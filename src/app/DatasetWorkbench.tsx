import { Button } from "@openai/apps-sdk-ui/components/Button";
import {
  ArrowLeft,
  ExternalLink,
} from "@openai/apps-sdk-ui/components/Icon";
import type { DatasetResult, JsonObject } from "../core/contracts";
import { displayValue, linksFromRows } from "./dataset-utils";

export type WorkbenchPanel =
  | "details"
  | "links"
  | "provenance"
  | "quality";

type Selection = { rowRef: string; row: JsonObject };

export function DatasetWorkbench({
  panel,
  page,
  rows,
  selection,
  focusedRow,
  onBack,
  onOpenLink,
}: {
  panel: WorkbenchPanel;
  page: DatasetResult;
  rows: JsonObject[];
  selection: Selection[];
  focusedRow: Selection | null;
  onBack: () => void;
  onOpenLink: (url: string) => void;
}) {
  const heading = {
    details: "Row details",
    links: "Sources and links",
    provenance: "Info",
    quality: "Data quality",
  }[panel];
  return (
    <section className="rounded-xl border border-subtle bg-surface-secondary/40 p-3 sm:p-4">
      <header className="mb-4 flex items-center gap-2">
        <Button
          variant="ghost"
          color="secondary"
          size="sm"
          uniform
          aria-label="Back to table"
          title="Back to table"
          onClick={onBack}
        >
          <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden="true" />
        </Button>
        <div>
          <h2 className="text-sm font-semibold">{heading}</h2>
          <p className="text-xs text-secondary">Loaded rows only · transient session</p>
        </div>
      </header>
      {panel === "quality" && <Quality rows={rows} columns={page.columns} />}
      {panel === "provenance" && <Provenance page={page} loaded={rows.length} />}
      {panel === "details" && (
        <Details
          row={focusedRow?.row ?? selection[0]?.row}
          columns={page.columns}
          onOpenLink={onOpenLink}
        />
      )}
      {panel === "links" && <Links rows={rows} onOpenLink={onOpenLink} />}
    </section>
  );
}

function Quality({ rows, columns }: Pick<DatasetResult, "rows" | "columns">) {
  const cells = rows.length * columns.length;
  const missingByColumn = columns.map((column) => ({
    label: column.label,
    count: rows.filter((row) => isMissing(row[column.key])).length,
  })).filter(({ count }) => count > 0).sort((a, b) => b.count - a.count);
  const missing = missingByColumn.reduce((sum, item) => sum + item.count, 0);
  const duplicates = rows.length - new Set(rows.map(stableRow)).size;
  const conflicts = columns.reduce((sum, column) =>
    sum + rows.filter((row) => !matchesType(row[column.key], column.type)).length, 0);
  const outliers = columns.reduce(
    (sum, column) => sum + countOutliers(rows.map((row) => row[column.key])),
    0,
  );
  const stats = [
    ["Completeness", cells ? `${Math.round(((cells - missing) / cells) * 100)}%` : "—"],
    ["Missing cells", missing],
    ["Duplicate rows", duplicates],
    ["Type conflicts", conflicts],
    ["Potential outliers", outliers],
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(220px,0.8fr)]">
      <dl className="grid grid-cols-2 gap-2">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-lg bg-surface-secondary p-3">
            <dt className="text-xs text-secondary">{label}</dt>
            <dd className="mt-1 text-xl font-semibold">{value}</dd>
          </div>
        ))}
      </dl>
      <div>
        <h3 className="mb-2 text-xs font-medium text-secondary">Columns with gaps</h3>
        {missingByColumn.length ? (
          <ul className="space-y-1 text-sm">
            {missingByColumn.slice(0, 8).map(({ label, count }) => (
              <li key={label} className="flex justify-between gap-3">
                <span className="truncate">{label}</span>
                <span className="text-secondary">{count}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-secondary">No missing values in loaded rows.</p>
        )}
      </div>
    </div>
  );
}

function Details({
  row,
  columns,
  onOpenLink,
}: {
  row?: JsonObject;
  columns: DatasetResult["columns"];
  onOpenLink: (url: string) => void;
}) {
  if (!row) return <p className="text-sm text-secondary">Choose a row to inspect.</p>;
  return (
    <dl className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
      {columns.map((column) => {
        const value = row[column.key];
        const link = httpUrl(value);
        return (
          <div key={column.key} className="min-w-0 border-b border-subtle pb-3">
            <dt className="text-xs font-medium text-secondary">{column.label}</dt>
            <dd className="mt-1 break-words text-sm">
              {link ? (
                <button type="button" className="inline-flex items-center gap-1 text-start underline" onClick={() => onOpenLink(link)}>
                  {link}<ExternalLink className="size-3 shrink-0" aria-hidden="true" />
                </button>
              ) : typeof value === "object" && value !== null ? (
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-surface-secondary p-2 text-xs">{JSON.stringify(value, null, 2)}</pre>
              ) : displayValue(value)}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function Links({ rows, onOpenLink }: { rows: JsonObject[]; onOpenLink: (url: string) => void }) {
  const links = linksFromRows(rows);
  if (!links.length) return <p className="text-sm text-secondary">No HTTP links were found in loaded rows.</p>;
  return (
    <ul className="space-y-1">
      {links.map((link, index) => (
        <li key={`${link.url}:${index}`} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-secondary">
          <div className="min-w-0"><p className="truncate text-sm">{link.url}</p><p className="text-[11px] text-secondary">{link.field} · row {link.row}</p></div>
          <Button variant="ghost" color="secondary" size="xs" uniform aria-label={`Open ${link.url}`} onClick={() => onOpenLink(link.url)}><ExternalLink className="size-3.5" aria-hidden="true" /></Button>
        </li>
      ))}
    </ul>
  );
}

function Provenance({ page, loaded }: { page: DatasetResult; loaded: number }) {
  const facts = [
    ["Dataset", page.dataset.title],
    ["Dataset ID", page.dataset.id],
    ["Operation", page.operation],
    ["Loaded rows", loaded],
    ["Reported rows", page.page.totalRows ?? page.rows.length],
    ["Result", page.page.truncated ? "Bounded preview" : "Complete loaded result"],
    ["Expires", page.artifact.expiresAt ? new Date(page.artifact.expiresAt).toLocaleString() : "Session-bound"],
    ["Artifact", page.artifact.uri],
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <dl className="space-y-2">{facts.map(([label, value]) => <div key={label} className="grid grid-cols-[100px_minmax(0,1fr)] gap-2 text-sm"><dt className="text-secondary">{label}</dt><dd className="break-all">{value}</dd></div>)}</dl>
      <div><h3 className="mb-2 text-xs font-medium text-secondary">Warnings and billing</h3>{page.warnings?.length ? <ul className="space-y-2 text-sm">{page.warnings.map((warning) => <li key={warning.code} className="rounded-lg bg-surface-secondary p-2"><span className="font-medium">{warning.code.replaceAll("_", " ")}</span><br /><span className="text-secondary">{warning.message}</span></li>)}</ul> : <p className="text-sm text-secondary">No result warnings.</p>}</div>
    </div>
  );
}

function isMissing(value: unknown) {
  return value === null || value === undefined || value === "";
}

function stableRow(row: JsonObject) {
  return JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)));
}

function matchesType(value: unknown, expected?: string) {
  if (isMissing(value) || !expected) return true;
  if (expected === "array") return Array.isArray(value);
  if (expected === "object") return typeof value === "object" && !Array.isArray(value);
  if (expected === "date" || expected === "datetime") return typeof value === "string" && Number.isFinite(Date.parse(value));
  return typeof value === expected;
}

function countOutliers(values: unknown[]) {
  const numbers = values
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .toSorted((left, right) => left - right);
  if (numbers.length < 4) return 0;
  const lower = numbers[Math.floor((numbers.length - 1) * 0.25)]!;
  const upper = numbers[Math.floor((numbers.length - 1) * 0.75)]!;
  const spread = upper - lower;
  return numbers.filter((value) => value < lower - spread * 1.5 || value > upper + spread * 1.5).length;
}

function httpUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
