import { Badge } from "@openai/apps-sdk-ui/components/Badge";
import { Button } from "@openai/apps-sdk-ui/components/Button";
import { Checkbox } from "@openai/apps-sdk-ui/components/Checkbox";
import {
  ArrowDownSm,
  ArrowLeft,
  ArrowRight,
  ArrowUpSm,
  AnalyzeData,
  BarChart as BarChartIcon,
  DataControls,
  DotsVerticalMoreMenu,
  Download,
  Eye,
  EyeOff,
  InfoCircle,
  Link,
  Search,
} from "@openai/apps-sdk-ui/components/Icon";
import { Input } from "@openai/apps-sdk-ui/components/Input";
import { Menu } from "@openai/apps-sdk-ui/components/Menu";
import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  datasetResultSchema,
  datasetUnavailableSchema,
  searchResponseSchema,
  type DatasetResult,
  type DatasetUnavailable,
  type JsonObject,
  type SearchResponse,
} from "../core/contracts";
import { profileDataset } from "../core/profiles";
import { DatasetOverview } from "./DatasetOverview";
import {
  DatasetWorkbench,
  type WorkbenchPanel,
} from "./DatasetWorkbench";
import {
  compareValues,
  displayValue,
  downloadRows,
} from "./dataset-utils";

type Sort = { key: string; direction: "ascending" | "descending" } | null;
type Selection = { rowRef: string; row: JsonObject };
type View = "table" | "overview" | WorkbenchPanel;
const ROWS_PER_PAGE = 5;

function DataWorkbenchApp() {
  const isBrowserPreview = Boolean(
    (window as Window & { brightMcpPreview?: boolean }).brightMcpPreview,
  );
  const [initial] = useState(readInitialResult);
  const [pages, setPages] = useState<DatasetResult[]>(
    initial.result ? [initial.result] : [],
  );
  const [unavailable, setUnavailable] = useState<DatasetUnavailable | null>(
    initial.unavailable ?? null,
  );
  const [pageIndex, setPageIndex] = useState(0);
  const [rowPageIndex, setRowPageIndex] = useState(0);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<Sort>(null);
  const [view, setView] = useState<View>("table");
  const [profileIndex, setProfileIndex] = useState(0);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [hiddenColumnKeys, setHiddenColumnKeys] = useState<string[]>([]);
  const [menuColumnKey, setMenuColumnKey] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection[]>([]);
  const [focusedRow, setFocusedRow] = useState<Selection | null>(null);
  const [pageError, setPageError] = useState<string | null>(initial.error ?? null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [loadingPage, setLoadingPage] = useState(false);
  const activeResize = useRef<AbortController | null>(null);

  const { app, isConnected, error } = useApp({
    appInfo: { name: "bright-data-workbench", version: "0.4.0" },
    capabilities: {},
    onAppCreated(createdApp) {
      createdApp.ontoolresult = (toolResult) => {
        const parsed = parseToolResult(toolResult);
        if (!parsed.ok) {
          setPageError(parsed.message);
          return;
        }
        if (parsed.unavailable) {
          setPages([]);
          setUnavailable(parsed.unavailable);
          setPageError(null);
          return;
        }
        setPages([parsed.value]);
        setUnavailable(null);
        setPageIndex(0);
        setRowPageIndex(0);
        setView("table");
        setProfileIndex(0);
        setColumnWidths({});
        setHiddenColumnKeys([]);
        setMenuColumnKey(null);
        setSelection([]);
        setFocusedRow(null);
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
  const filteredRows = useMemo(() => {
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
      const order = compareValues(left.row[sort.key], right.row[sort.key]);
      return sort.direction === "ascending" ? order : -order;
    });
  }, [filter, page, sort]);
  const rowPageCount = Math.max(
    1,
    Math.ceil(filteredRows.length / ROWS_PER_PAGE),
  );
  const visibleRows = filteredRows.slice(
    rowPageIndex * ROWS_PER_PAGE,
    (rowPageIndex + 1) * ROWS_PER_PAGE,
  );
  const loadedRows = useMemo(
    () => pages.flatMap(({ rows }) => rows),
    [pages],
  );

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

  const openLink = async (url: string) => {
    if (app?.getHostCapabilities()?.openLinks) {
      const result = await app.openLink({ url });
      if (!result.isError) return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  };

  if (unavailable) {
    return (
      <main
        className="flex min-h-56 flex-col items-center justify-center gap-5 p-6 text-center"
        role="alert"
        aria-label={`${unavailable.title}. ${unavailable.message}`}
      >
        <div
          className="flex size-16 items-center justify-center rounded-2xl bg-surface-secondary text-5xl font-light text-secondary"
          aria-hidden="true"
        >
          ×
        </div>
        <h1 className="text-lg font-semibold text-primary">
          {unavailable.title}
        </h1>
      </main>
    );
  }

  if (!page) {
    return (
      <main
        className="p-4 text-sm text-secondary"
        aria-live="polite"
        role={pageError ? "alert" : "status"}
      >
        {pageError ??
          (error
            ? "This workbench is waiting for a supported MCP Apps host."
            : "Waiting for structured data…")}
      </main>
    );
  }
  const isSearch = page.dataset.id === "web-search";

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
      if (parsed.unavailable) throw new Error(parsed.unavailable.message);
      setPages((current) => [...current.slice(0, pageIndex + 1), parsed.value]);
      setPageIndex((current) => current + 1);
      setRowPageIndex(0);
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
    setRowPageIndex(0);
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

      <section
        className={`grid items-center gap-2 ${
          view === "table"
            ? isSearch
              ? "grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_auto_224px]"
              : "grid-cols-[minmax(0,1fr)_auto_auto] sm:grid-cols-[minmax(0,1fr)_auto_auto_224px]"
            : "grid-cols-[minmax(0,1fr)_auto_auto]"
        }`}
      >
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
          {page.page.truncated && <Badge color="warning">Preview</Badge>}
        </nav>
        {!isSearch && (
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
        )}
        <Menu>
          <Menu.Trigger>
            <Button
              variant="ghost"
              color="secondary"
              size="sm"
              uniform
              aria-label="Data actions"
              title="Data actions"
            >
              <DataControls className="size-4" aria-hidden="true" />
            </Button>
          </Menu.Trigger>
          <Menu.Content align="end" minWidth={210}>
            {!isSearch && (
              <Menu.Item onSelect={() => setView("quality")}>
                <AnalyzeData className="size-4" aria-hidden="true" />
                Data quality
              </Menu.Item>
            )}
            <Menu.Item onSelect={() => setView("links")}>
              <Link className="size-4" aria-hidden="true" />
              Sources and links
            </Menu.Item>
            <Menu.Item onSelect={() => setView("provenance")}>
              <InfoCircle className="size-4" aria-hidden="true" />
              Info
            </Menu.Item>
            <Menu.Separator />
            <Menu.Item
              onSelect={() =>
                downloadRows("csv", page.dataset.title, page.columns, loadedRows)
              }
            >
              <Download className="size-4" aria-hidden="true" />
              Export loaded CSV
            </Menu.Item>
            <Menu.Item
              onSelect={() =>
                downloadRows("json", page.dataset.title, page.columns, loadedRows)
              }
            >
              <Download className="size-4" aria-hidden="true" />
              Export loaded JSON
            </Menu.Item>
          </Menu.Content>
        </Menu>
        {view === "table" && (
          <Input
            className={`${isSearch ? "col-span-2" : "col-span-3"} w-full sm:col-span-1`}
            type="search"
            aria-label="Filter rows on this page"
            placeholder="Search visible values"
            startAdornment={<Search className="size-4" aria-hidden="true" />}
            size="sm"
            value={filter}
            onChange={(event) => {
              setFilter(event.currentTarget.value);
              setRowPageIndex(0);
            }}
          />
        )}
      </section>

      {view === "overview" ? (
        <DatasetOverview
          profiles={page.profiles}
          profileIndex={profileIndex}
          rowCount={page.page.totalRows ?? page.rows.length}
          onProfileIndexChange={setProfileIndex}
        />
      ) : view !== "table" ? (
        <DatasetWorkbench
          panel={view}
          page={page}
          rows={loadedRows}
          selection={selection}
          focusedRow={focusedRow}
          onBack={() => setView("table")}
          onOpenLink={(url) => void openLink(url)}
        />
      ) : isSearch ? (
        <div className="divide-y divide-subtle overflow-hidden rounded-xl border border-subtle">
          {visibleRows.map(({ row, rowRef }) => {
            const url = typeof row.url === "string" ? row.url : "";
            return (
              <article key={rowRef} className="space-y-1.5 p-3">
                <div className="flex items-center gap-2 text-xs text-secondary">
                  {typeof row.rank === "number" && <span>#{row.rank}</span>}
                  <span>{displayValue(row.kind)}</span>
                  {page.rows.some((candidate) => candidate.query !== row.query) && (
                    <span className="min-w-0 truncate">· {displayValue(row.query)}</span>
                  )}
                </div>
                <button
                  type="button"
                  className="block text-start text-sm font-medium text-primary hover:underline"
                  onClick={() => url && void openLink(url)}
                >
                  {displayValue(row.title)}
                </button>
                {typeof row.summary === "string" && row.summary && (
                  <p className="line-clamp-2 text-sm text-secondary">
                    {displayValue(row.summary)}
                  </p>
                )}
                {url && <p className="truncate text-xs text-secondary">{url}</p>}
              </article>
            );
          })}
          {visibleRows.length === 0 && (
            <p className="p-4 text-center text-sm text-secondary" role="status">
              No results match this filter.
            </p>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-subtle">
          <table className="w-full min-w-max table-fixed border-collapse text-left text-sm">
          <colgroup>
            <col className="w-16" />
            {visibleColumns.map((column) => (
              <col
                key={column.key}
                style={{ width: columnWidths[column.key] ?? 180 }}
              />
            ))}
          </colgroup>
          <thead className="bg-surface-secondary">
            <tr>
              <th className="w-16 border-b border-subtle px-2 py-2">
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
                    <Menu.Content align="end" minWidth="auto">
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
                  <td className="px-2 py-1.5 align-top">
                    <div className="flex items-center gap-1">
                      <Checkbox
                        checked={checked}
                        label={
                          <span className="sr-only">
                            {checked ? "Deselect" : "Select"} row {rowRef}
                          </span>
                        }
                        onCheckedChange={(nextChecked) =>
                          toggleSelection(rowRef, row, nextChecked)
                        }
                      />
                      <Button
                        variant="ghost"
                        color="secondary"
                        size="xs"
                        uniform
                        aria-label={`Inspect row ${rowRef}`}
                        title="Inspect row"
                        onClick={() => {
                          setFocusedRow({ rowRef, row });
                          setView("details");
                        }}
                      >
                        <InfoCircle className="size-3.5" aria-hidden="true" />
                      </Button>
                    </div>
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
          {filteredRows.length
            ? `${rowPageIndex * ROWS_PER_PAGE + 1}–${Math.min(
                filteredRows.length,
                (rowPageIndex + 1) * ROWS_PER_PAGE,
              )} of ${filteredRows.length}`
            : "0 rows"}
        </p>
        {(selection.length > 0 ||
          rowPageCount > 1 ||
          pageIndex > 0 ||
          page.page.nextResourceUri) && (
          <div className="flex justify-self-end gap-2">
            {selection.length > 0 && (
              <Button
                color="secondary"
                variant="ghost"
                size="md"
                iconSize="sm"
                uniform
                aria-label="Export selected rows as CSV"
                title="Export selected rows"
                onClick={() =>
                  downloadRows(
                    "csv",
                    `${page.dataset.title}-selection`,
                    page.columns,
                    selection.map(({ row }) => row),
                  )
                }
              >
                <Download aria-hidden="true" />
              </Button>
            )}
            {(rowPageCount > 1 || pageIndex > 0 || page.page.nextResourceUri) && (
              <>
                <Button
                  color="secondary"
                  variant="soft"
                  size="md"
                  iconSize="sm"
                  uniform
                  pill={false}
                  disabled={pageIndex === 0 && rowPageIndex === 0}
                  aria-label="Previous page"
                  title="Previous page"
                  onClick={() => {
                    if (rowPageIndex > 0) {
                      setRowPageIndex((current) => current - 1);
                    } else {
                      setPageIndex((current) => Math.max(0, current - 1));
                    }
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
                  disabled={
                    rowPageIndex >= rowPageCount - 1 &&
                    (!page.page.nextResourceUri || !app)
                  }
                  aria-label="Next page"
                  title="Next page"
                  onClick={() => {
                    if (rowPageIndex < rowPageCount - 1) {
                      setRowPageIndex((current) => current + 1);
                    } else {
                      void loadNextPage();
                    }
                  }}
                >
                  <ArrowRight className="rtl:rotate-180" aria-hidden="true" />
                </Button>
              </>
            )}
          </div>
        )}
        </footer>
      )}
    </main>
  );
}

function parseToolResult(result: CallToolResult) {
  if (!result.isError) return parseResult(result.structuredContent);
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) return { ok: false as const, message: "The dataset operation failed." };
  try {
    const failure = JSON.parse(text) as unknown;
    if (failure && typeof failure === "object" && "message" in failure) {
      const message = failure.message;
      const nextAction = "nextAction" in failure ? failure.nextAction : undefined;
      if (typeof message === "string") {
        return {
          ok: false as const,
          message: typeof nextAction === "string" ? `${message} ${nextAction}` : message,
        };
      }
    }
  } catch {
    // Plain-text tool errors are already suitable for display.
  }
  return { ok: false as const, message: text };
}

function parseResult(
  value: unknown,
):
  | { ok: true; value: DatasetResult; unavailable?: undefined }
  | { ok: true; unavailable: DatasetUnavailable; value?: undefined }
  | { ok: false; message: string } {
  const unavailable = datasetUnavailableSchema.safeParse(value);
  if (unavailable.success) {
    return { ok: true, unavailable: unavailable.data };
  }
  const parsed = datasetResultSchema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  const search = searchResponseSchema.safeParse(value);
  if (search.success) return { ok: true, value: searchToDataset(search.data) };
  const version =
    value && typeof value === "object" && "schemaVersion" in value
      ? String(value.schemaVersion)
      : "missing";
  return {
    ok: false,
    message: `Unsupported or invalid workbench result schema (${version}).`,
  };
}

function searchToDataset(search: SearchResponse): DatasetResult {
  const columns: DatasetResult["columns"] = [
    { key: "query", label: "Query", type: "string" },
    { key: "kind", label: "Kind", type: "string" },
    { key: "rank", label: "Rank", type: "number" },
    { key: "title", label: "Title", type: "string" },
    { key: "url", label: "URL", type: "string" },
    { key: "summary", label: "Summary", type: "string" },
    { key: "source", label: "Source", type: "string" },
    { key: "published", label: "Published", type: "string" },
    { key: "siteLinks", label: "Site links", type: "array" },
    { key: "imageUrl", label: "Image", type: "string" },
  ];
  const rows: JsonObject[] = search.searches.flatMap((item) => [
    ...item.results.map((result) => ({
      query: item.query,
      kind: "Organic",
      rank: result.rank,
      title: result.title,
      url: result.url,
      summary: result.summary,
      siteLinks: result.siteLinks,
    })),
    ...(item.topStories ?? []).map((story) => ({
      query: item.query,
      kind: "Top story",
      title: story.title,
      url: story.url,
      source: story.source,
      published: story.published,
      imageUrl: story.imageUrl,
    })),
  ]);
  const warnings = search.searches.flatMap((item, index) => {
    const messages = [];
    if (item.error) messages.push(item.error.message);
    if (item.providerQuery && item.providerQuery !== item.query) {
      messages.push(`Provider received “${item.providerQuery}”.`);
    }
    if (item.detectedQuery && item.detectedQuery !== item.query) {
      messages.push(`Provider searched for “${item.detectedQuery}”.`);
    }
    const correction =
      item.spelling?.correctedText ?? item.spelling?.suggestedText;
    if (correction) messages.push(`Spelling alternative: “${correction}”.`);
    return messages.map((message, warningIndex) => ({
      code: `search_${index + 1}_${warningIndex + 1}`,
      message,
    }));
  });
  const first = search.searches[0];
  return {
    schemaVersion: 1,
    resultId: `search-${first?.retrievedAt ?? "empty"}`,
    dataset: {
      id: "web-search",
      title: search.searches.length === 1
        ? `Search · ${first?.query ?? ""}`
        : `Web search · ${search.searches.length} queries`,
    },
    operation: "search",
    columns,
    profiles: profileDataset(columns, rows),
    rows,
    rowRefs: rows.map((_, index) => `search-row-${index + 1}`),
    page: {
      truncated: search.searches.some((item) => Boolean(item.nextCursor)),
      totalRows: rows.length,
    },
    artifact: {
      uri: "mcp://bright/search_web",
      mediaType: "application/json",
    },
    ...(warnings.length && { warnings }),
  };
}

function readInitialResult(): {
  result?: DatasetResult;
  unavailable?: DatasetUnavailable;
  error?: string;
} {
  const value = (
    window as Window & { openai?: { toolOutput?: unknown } }
  ).openai?.toolOutput;
  if (value === undefined) return {};
  const parsed = parseResult(value);
  if (!parsed.ok) return { error: parsed.message };
  return parsed.unavailable
    ? { unavailable: parsed.unavailable }
    : { result: parsed.value };
}

const root = document.getElementById("root");
if (!root) throw new Error("Data workbench root element is missing.");
createRoot(root).render(
  <StrictMode>
    <DataWorkbenchApp />
  </StrictMode>,
);
