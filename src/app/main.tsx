import { Badge } from "@openai/apps-sdk-ui/components/Badge";
import { Button } from "@openai/apps-sdk-ui/components/Button";
import {
  ArrowLeft,
  ArrowRight,
} from "@openai/apps-sdk-ui/components/Icon";
import { Input } from "@openai/apps-sdk-ui/components/Input";
import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  datasetResultSchema,
  type DatasetResult,
  type JsonObject,
} from "../core/contracts";

type Sort = { key: string; direction: "ascending" | "descending" } | null;
type Selection = { rowRef: string; row: JsonObject };

function DatasetTable() {
  const isBrowserPreview = Boolean(
    (window as Window & { brightMcpPreview?: boolean }).brightMcpPreview,
  );
  const [initial] = useState(readInitialResult);
  const [pages, setPages] = useState<DatasetResult[]>(
    initial.result ? [initial.result] : [],
  );
  const [pageIndex, setPageIndex] = useState(0);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<Sort>(null);
  const [selection, setSelection] = useState<Selection[]>([]);
  const [pageError, setPageError] = useState<string | null>(initial.error ?? null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [loadingPage, setLoadingPage] = useState(false);

  const { app, isConnected, error } = useApp({
    appInfo: { name: "bright-dataset-table", version: "0.1.0" },
    capabilities: {},
    onAppCreated(createdApp) {
      createdApp.ontoolresult = (toolResult) => {
        const parsed = parseResult(toolResult.structuredContent);
        if (!parsed.ok) {
          setPageError(parsed.message);
          return;
        }
        setPages([parsed.value]);
        setPageIndex(0);
        setSelection([]);
        setPageError(null);
      };
    },
  });
  useHostStyles(app, app?.getHostContext());

  const page = pages[pageIndex];
  const visibleRows = useMemo(() => {
    if (!page) return [];
    const query = filter.trim().toLocaleLowerCase();
    const rows = page.rows.map((row, index) => ({
      row,
      rowRef: page.rowRefs[index] ?? "",
    }));
    const filtered = query
      ? rows.filter(({ row }) =>
          page.columns.some((column) =>
            displayValue(row[column.key]).toLocaleLowerCase().includes(query),
          ),
        )
      : rows;
    if (!sort) return filtered;
    return filtered.toSorted((left, right) => {
      const order = compare(left.row[sort.key], right.row[sort.key]);
      return sort.direction === "ascending" ? order : -order;
    });
  }, [filter, page, sort]);

  const shareSelection = async () => {
    if (!app || !app.getHostCapabilities()?.updateModelContext) return;
    const rows = selection.slice(0, 20);
    while (
      rows.length > 0 &&
      JSON.stringify({ selectedRows: rows }).length > 6_000
    ) {
      rows.pop();
    }
    try {
      await app.updateModelContext({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              dataset: page?.dataset,
              selectedRows: rows,
              selectionTruncated: rows.length < selection.length,
            }),
          },
        ],
      });
      setContextError(null);
    } catch {
      setContextError("The host could not receive the current selection.");
    }
  };

  useEffect(() => {
    const timeout = window.setTimeout(() => void shareSelection(), 250);
    return () => window.clearTimeout(timeout);
  }, [app, selection]);

  if (!page) {
    return (
      <main
        className="p-4 text-sm text-secondary"
        aria-live="polite"
        role={pageError ? "alert" : "status"}
      >
        {pageError ??
          (error
            ? "This table is waiting for a supported MCP Apps host."
            : "Waiting for a dataset result…")}
      </main>
    );
  }

  const loadNextPage = async () => {
    const uri = page.page.nextResourceUri;
    if (!uri || !app) return;
    setLoadingPage(true);
    setPageError(null);
    try {
      const response = await app.readServerResource({ uri });
      const content = response.contents.find((item) => "text" in item);
      const parsed = parseResult(
        content && "text" in content ? JSON.parse(content.text) : null,
      );
      if (!parsed.ok) throw new Error(parsed.message);
      setPages((current) => [...current.slice(0, pageIndex + 1), parsed.value]);
      setPageIndex((current) => current + 1);
      setFilter("");
      setSort(null);
    } catch (loadError) {
      setPageError(
        loadError instanceof Error
          ? loadError.message
          : "The next page could not be read.",
      );
    } finally {
      setLoadingPage(false);
    }
  };

  const changeSort = (key: string) => {
    setSort((current) =>
      current?.key === key
        ? {
            key,
            direction:
              current.direction === "ascending" ? "descending" : "ascending",
          }
        : { key, direction: "ascending" },
    );
  };

  const toggleSelection = (rowRef: string, row: JsonObject, checked: boolean) => {
    setSelection((current) =>
      checked
        ? current.some((item) => item.rowRef === rowRef)
          ? current
          : [...current, { rowRef, row }]
        : current.filter((item) => item.rowRef !== rowRef),
    );
  };

  return (
    <main className="flex min-w-0 flex-col gap-3 p-3 sm:p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs text-secondary">Dataset result</p>
          <h1 className="heading-lg">{page.dataset.title}</h1>
          <p className="mt-1 text-xs text-secondary">
            {page.page.totalRows ?? page.rows.length} rows · page {pageIndex + 1}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {selection.length > 0 && (
            <Badge color="info" pill>
              {selection.length} selected
            </Badge>
          )}
          {page.page.truncated && <Badge color="warning">Preview</Badge>}
        </div>
      </header>

      {page.warnings?.map((warning) => (
        <p
          key={warning.code}
          className="rounded-lg border border-subtle bg-surface-secondary p-2 text-sm"
          role="status"
        >
          {warning.message}
        </p>
      ))}

      <label className="flex max-w-sm flex-col gap-1 text-xs font-medium text-secondary">
        Filter this page
        <Input
          aria-label="Filter rows on this page"
          placeholder="Search visible values"
          size="sm"
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value)}
        />
      </label>

      <div className="overflow-x-auto rounded-xl border border-subtle">
        <table className="w-full min-w-max border-collapse text-left text-sm">
          <thead className="bg-surface-secondary">
            <tr>
              <th className="w-10 border-b border-subtle px-3 py-2">
                <span className="sr-only">Select row</span>
              </th>
              {page.columns.map((column) => (
                <th
                  key={column.key}
                  className="border-b border-subtle px-3 py-2 font-medium"
                  aria-sort={sort?.key === column.key ? sort.direction : "none"}
                >
                  <button
                    type="button"
                    className="flex items-center gap-1 rounded-sm"
                    onClick={() => changeSort(column.key)}
                    aria-label={`Sort by ${column.label}`}
                  >
                    {column.label}
                    {sort?.key === column.key &&
                      (sort.direction === "ascending" ? " ↑" : " ↓")}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map(({ row, rowRef }) => {
              const checked = selection.some((item) => item.rowRef === rowRef);
              return (
                <tr key={rowRef} className="border-b border-subtle last:border-0">
                  <td className="px-3 py-2 align-top">
                    <input
                      type="checkbox"
                      checked={checked}
                      aria-label={`${checked ? "Deselect" : "Select"} row ${rowRef}`}
                      onChange={(event) =>
                        toggleSelection(rowRef, row, event.currentTarget.checked)
                      }
                    />
                  </td>
                  {page.columns.map((column) => (
                    <td key={column.key} className="max-w-80 px-3 py-2 align-top">
                      <span className="line-clamp-3 break-words">
                        {displayValue(row[column.key])}
                      </span>
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        {visibleRows.length === 0 && (
          <p className="p-4 text-center text-sm text-secondary" role="status">
            No rows match this page filter.
          </p>
        )}
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-2">
        {!isBrowserPreview && (
          <p className="text-xs text-secondary" aria-live="polite">
            {pageError ??
              contextError ??
              (isConnected ? "Connected to host" : "Display remains available offline")}
          </p>
        )}
        <div className="ml-auto flex gap-2">
          {contextError && (
            <Button color="secondary" variant="ghost" size="sm" onClick={shareSelection}>
              Retry selection context
            </Button>
          )}
          <Button
            color="secondary"
            variant="soft"
            size="md"
            iconSize="sm"
            uniform
            pill={false}
            disabled={pageIndex === 0}
            aria-label="Previous page"
            title="Previous page"
            onClick={() => {
              setPageIndex((current) => Math.max(0, current - 1));
              setFilter("");
              setSort(null);
            }}
          >
            <ArrowLeft className="rtl:rotate-180" aria-hidden="true" />
          </Button>
          <Button
            color="secondary"
            variant="soft"
            size="md"
            iconSize="sm"
            uniform
            pill={false}
            loading={loadingPage}
            disabled={!page.page.nextResourceUri || !app}
            aria-label="Next page"
            title="Next page"
            onClick={loadNextPage}
          >
            <ArrowRight className="rtl:rotate-180" aria-hidden="true" />
          </Button>
        </div>
      </footer>
    </main>
  );
}

function parseResult(
  value: unknown,
): { ok: true; value: DatasetResult } | { ok: false; message: string } {
  const parsed = datasetResultSchema.safeParse(value);
  if (!parsed.success) {
    const version =
      value && typeof value === "object" && "schemaVersion" in value
        ? String(value.schemaVersion)
        : "missing";
    return {
      ok: false,
      message: `Unsupported or invalid dataset result schema (${version}).`,
    };
  }
  return { ok: true, value: parsed.data };
}

function readInitialResult(): { result?: DatasetResult; error?: string } {
  const value = (
    window as Window & { openai?: { toolOutput?: unknown } }
  ).openai?.toolOutput;
  if (value === undefined) return {};
  const parsed = parseResult(value);
  return parsed.ok ? { result: parsed.value } : { error: parsed.message };
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "[unavailable value]";
  }
}

function compare(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return displayValue(left).localeCompare(displayValue(right), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

const root = document.getElementById("root");
if (!root) throw new Error("Dataset table root element is missing.");
createRoot(root).render(
  <StrictMode>
    <DatasetTable />
  </StrictMode>,
);
