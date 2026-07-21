import { Badge } from "@openai/apps-sdk-ui/components/Badge";
import { Button } from "@openai/apps-sdk-ui/components/Button";
import {
  ArrowDownSm,
  ArrowLeft,
  ArrowRight,
  ArrowUpSm,
  BarChart as BarChartIcon,
  DotsVerticalMoreMenu,
  Eye,
  EyeOff,
  Search,
} from "@openai/apps-sdk-ui/components/Icon";
import { Input } from "@openai/apps-sdk-ui/components/Input";
import { Menu } from "@openai/apps-sdk-ui/components/Menu";
import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  datasetResultSchema,
  type DatasetResult,
  type JsonObject,
} from "../core/contracts";
import { DatasetOverview } from "./DatasetOverview";

type Sort = { key: string; direction: "ascending" | "descending" } | null;
type Selection = { rowRef: string; row: JsonObject };
type View = "table" | "overview";

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
  const [view, setView] = useState<View>("table");
  const [profileIndex, setProfileIndex] = useState(0);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [hiddenColumnKeys, setHiddenColumnKeys] = useState<string[]>([]);
  const [menuColumnKey, setMenuColumnKey] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection[]>([]);
  const [pageError, setPageError] = useState<string | null>(initial.error ?? null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [loadingPage, setLoadingPage] = useState(false);
  const activeResize = useRef<AbortController | null>(null);

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
        setView("table");
        setProfileIndex(0);
        setColumnWidths({});
        setHiddenColumnKeys([]);
        setMenuColumnKey(null);
        setSelection([]);
        setPageError(null);
      };
    },
  });
  useHostStyles(app, app?.getHostContext());

  const page = pages[pageIndex];
  const visibleColumns = useMemo(
    () =>
      page?.columns.filter(
        (column) => !hiddenColumnKeys.includes(column.key),
      ) ?? [],
    [hiddenColumnKeys, page],
  );
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

  const beginColumnResize = (
    event: React.PointerEvent<HTMLButtonElement>,
    key: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    activeResize.current?.abort();

    const controller = new AbortController();
    const header = event.currentTarget.parentElement;
    if (!header) return;
    const startX = event.clientX;
    const startWidth = header.getBoundingClientRect().width;
    const direction = getComputedStyle(header).direction === "rtl" ? -1 : 1;
    activeResize.current = controller;
    document.body.classList.add("resizing-column");

    window.addEventListener(
      "pointermove",
      (moveEvent) => {
        const width = Math.min(
          640,
          Math.max(96, startWidth + (moveEvent.clientX - startX) * direction),
        );
        setColumnWidths((current) => ({ ...current, [key]: width }));
      },
      { signal: controller.signal },
    );
    window.addEventListener(
      "pointerup",
      () => {
        controller.abort();
        activeResize.current = null;
        document.body.classList.remove("resizing-column");
      },
      { once: true, signal: controller.signal },
    );
  };

  const hideColumn = (key: string) => {
    if (visibleColumns.length > 1) {
      setHiddenColumnKeys((current) => [...current, key]);
    }
    setMenuColumnKey(null);
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
      {page.warnings?.map((warning) => (
        <p
          key={warning.code}
          className="rounded-lg border border-subtle bg-surface-secondary p-2 text-sm"
          role="status"
        >
          {warning.message}
        </p>
      ))}

      <section className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[minmax(0,1fr)_auto_224px]">
        <nav
          className="flex min-w-0 items-center gap-2 overflow-x-auto"
          role="tablist"
          aria-label="Open tables"
        >
          <button
            className="max-w-full truncate rounded-lg bg-surface-secondary px-3 py-1.5 text-sm font-medium"
            type="button"
            role="tab"
            aria-selected="true"
          >
            {page.dataset.title}
          </button>
          {selection.length > 0 && (
            <Badge color="info" pill>
              {selection.length} selected
            </Badge>
          )}
          {page.page.truncated && <Badge color="warning">Preview</Badge>}
        </nav>
        <Button
          variant="ghost"
          color="secondary"
          size="sm"
          uniform
          aria-label={view === "table" ? "Show overview" : "Show table"}
          aria-pressed={view === "overview"}
          title={view === "table" ? "Show overview" : "Show table"}
          onClick={() =>
            setView((current) =>
              current === "table" ? "overview" : "table",
            )
          }
        >
          <BarChartIcon className="size-4" aria-hidden="true" />
        </Button>
        <Input
          className="col-span-2 w-full sm:col-span-1"
          type="search"
          aria-label="Filter rows on this page"
          placeholder="Search visible values"
          startAdornment={<Search className="size-4" aria-hidden="true" />}
          size="sm"
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value)}
        />
      </section>

      {view === "overview" ? (
        <DatasetOverview
          profiles={page.profiles}
          profileIndex={profileIndex}
          rowCount={page.page.totalRows ?? page.rows.length}
          onProfileIndexChange={setProfileIndex}
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-subtle">
          <table className="w-full min-w-max table-fixed border-collapse text-left text-sm">
          <colgroup>
            <col className="w-10" />
            {visibleColumns.map((column) => (
              <col
                key={column.key}
                style={{ width: columnWidths[column.key] ?? 180 }}
              />
            ))}
          </colgroup>
          <thead className="bg-surface-secondary">
            <tr>
              <th className="w-10 border-b border-subtle px-3 py-2">
                <span className="sr-only">Select row</span>
              </th>
              {visibleColumns.map((column) => (
                <th
                  key={column.key}
                  className="column-header border-b border-subtle font-medium"
                  aria-sort={sort?.key === column.key ? sort.direction : "none"}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenuColumnKey(column.key);
                  }}
                >
                  <button
                    type="button"
                    className="flex h-full w-full items-center gap-1 overflow-hidden rounded-sm text-start"
                    onClick={() => changeSort(column.key)}
                    aria-label={`Sort by ${column.label}`}
                  >
                    <span className="truncate">{column.label}</span>
                    {sort?.key === column.key &&
                      (sort.direction === "ascending" ? " ↑" : " ↓")}
                  </button>
                  <Menu
                    forceOpen={menuColumnKey === column.key}
                    onClose={() => setMenuColumnKey(null)}
                  >
                    <Menu.Trigger>
                      <Button
                        className="column-menu"
                        variant="ghost"
                        color="secondary"
                        size="xs"
                        uniform
                        aria-label={`Options for ${column.label}`}
                        title={`Options for ${column.label}`}
                        onClick={() => setMenuColumnKey(column.key)}
                      >
                        <DotsVerticalMoreMenu className="size-4" aria-hidden="true" />
                      </Button>
                    </Menu.Trigger>
                    <Menu.Content align="end" minWidth={210}>
                      <Menu.Item
                        onSelect={() =>
                          setSort({ key: column.key, direction: "ascending" })
                        }
                      >
                        <ArrowUpSm className="size-4" aria-hidden="true" />
                        Sort ascending
                      </Menu.Item>
                      <Menu.Item
                        onSelect={() =>
                          setSort({ key: column.key, direction: "descending" })
                        }
                      >
                        <ArrowDownSm className="size-4" aria-hidden="true" />
                        Sort descending
                      </Menu.Item>
                      <Menu.Separator />
                      <Menu.Item
                        disabled={visibleColumns.length === 1}
                        onSelect={() => hideColumn(column.key)}
                      >
                        <EyeOff className="size-4" aria-hidden="true" />
                        Hide column
                      </Menu.Item>
                      {hiddenColumnKeys.length > 0 && (
                        <Menu.Sub>
                          <Menu.SubTrigger>
                            <Eye className="size-4" aria-hidden="true" />
                            Show columns
                          </Menu.SubTrigger>
                          <Menu.SubContent minWidth={180}>
                            {page.columns
                              .filter((candidate) =>
                                hiddenColumnKeys.includes(candidate.key),
                              )
                              .map((hiddenColumn) => (
                                <Menu.Item
                                  key={hiddenColumn.key}
                                  onSelect={() =>
                                    setHiddenColumnKeys((current) =>
                                      current.filter(
                                        (key) => key !== hiddenColumn.key,
                                      ),
                                    )
                                  }
                                >
                                  {hiddenColumn.label}
                                </Menu.Item>
                              ))}
                          </Menu.SubContent>
                        </Menu.Sub>
                      )}
                    </Menu.Content>
                  </Menu>
                  <button
                    className="resize-handle"
                    type="button"
                    aria-label={`Resize ${column.label} column`}
                    title="Drag to resize"
                    onPointerDown={(event) =>
                      beginColumnResize(event, column.key)
                    }
                  />
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
                  {visibleColumns.map((column) => (
                    <td key={column.key} className="px-3 py-2 align-top">
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
      )}

      {view === "table" && (
        <footer className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {!isBrowserPreview && (
            <p className="truncate text-xs text-secondary" aria-live="polite">
              {pageError ??
                contextError ??
                (isConnected
                  ? "Connected to host"
                  : "Display remains available offline")}
            </p>
          )}
          {contextError && (
            <Button color="secondary" variant="ghost" size="sm" onClick={shareSelection}>
              Retry selection context
            </Button>
          )}
        </div>
        <p className="text-center text-xs text-secondary" aria-live="polite">
          {page.page.totalRows ?? page.rows.length} rows · page {pageIndex + 1}
        </p>
        {(pageIndex > 0 || page.page.nextResourceUri) && (
          <div className="flex justify-self-end gap-2">
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
        )}
        </footer>
      )}
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
