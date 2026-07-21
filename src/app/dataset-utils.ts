import type { DatasetResult, JsonObject } from "../core/contracts";

export function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "[unavailable value]";
  }
}

export function compareValues(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return displayValue(left).localeCompare(displayValue(right), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function downloadRows(
  format: "csv" | "json",
  title: string,
  columns: DatasetResult["columns"],
  rows: JsonObject[],
) {
  const content = format === "json"
    ? JSON.stringify(rows, null, 2)
    : [
        columns.map(({ label }) => csvCell(label)).join(","),
        ...rows.map((row) =>
          columns.map(({ key }) => csvCell(displayValue(row[key]))).join(",")),
      ].join("\n");
  const url = URL.createObjectURL(new Blob([content], {
    type: format === "json" ? "application/json" : "text/csv;charset=utf-8",
  }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "dataset"}.${format}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function linksFromRows(rows: JsonObject[]) {
  const links: Array<{ field: string; url: string; row: number }> = [];
  rows.forEach((row, rowIndex) => {
    for (const [field, value] of Object.entries(row)) {
      for (const candidate of Array.isArray(value) ? value : [value]) {
        if (typeof candidate !== "string") continue;
        try {
          const url = new URL(candidate);
          if ((url.protocol === "http:" || url.protocol === "https:") && links.length < 50) {
            links.push({ field, url: url.href, row: rowIndex + 1 });
          }
        } catch {
          // Ordinary strings are not links.
        }
      }
    }
  });
  return links;
}

function csvCell(value: string) {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
