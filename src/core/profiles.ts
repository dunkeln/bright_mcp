import type {
  DatasetProfile,
  DatasetResult,
} from "./contracts";

const MAX_BUCKETS = 8;
const MAX_CATEGORIES = 6;

export function profileDataset(
  columns: DatasetResult["columns"],
  rows: DatasetResult["rows"],
): DatasetProfile[] {
  return columns
    .map((column) => profileColumn(column, rows))
    .filter(
      (profile) =>
        profile.populated > 0 &&
        (profile.missing > 0 ||
          (profile.distinct > 1 &&
            (profile.kind !== "category" ||
              profile.distinct < profile.populated))),
    );
}

function profileColumn(
  column: DatasetResult["columns"][number],
  rows: DatasetResult["rows"],
): DatasetProfile {
  const values = rows
    .map((row) => row[column.key])
    .filter((value) => value !== null && value !== undefined && value !== "");
  const base = {
    columnKey: column.key,
    label: column.label,
    populated: values.length,
    missing: rows.length - values.length,
    distinct: new Set(values.map(valueText)).size,
  };

  const booleans = values.every((value) => typeof value === "boolean");
  if (column.type === "boolean" || booleans) {
    return categoricalProfile(base, values, "boolean");
  }

  const numbers = values.map(numericValue);
  if (
    values.length > 0 &&
    (column.type === "number" || numbers.every((value) => value !== null)) &&
    numbers.every((value) => value !== null)
  ) {
    return numericProfile(base, numbers as number[]);
  }

  const dates = values.map(dateValue);
  if (
    values.length > 0 &&
    (column.type === "date" || column.type === "datetime" ||
      dates.every((value) => value !== null)) &&
    dates.every((value) => value !== null)
  ) {
    return dateProfile(base, dates as number[]);
  }

  return categoricalProfile(base, values, "category");
}

function numericProfile(
  base: ProfileBase,
  values: number[],
): DatasetProfile {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return {
    ...base,
    kind: "numeric",
    buckets: distribution(sorted, formatNumber),
    stats: [
      { label: "Minimum", value: formatNumber(sorted[0]!) },
      { label: "Median", value: formatNumber(median) },
      { label: "Maximum", value: formatNumber(sorted.at(-1)!) },
      { label: "Missing", value: base.missing },
      { label: "Distinct", value: base.distinct },
    ],
  };
}

function dateProfile(base: ProfileBase, values: number[]): DatasetProfile {
  const sorted = values.toSorted((left, right) => left - right);
  const first = sorted[0]!;
  const last = sorted.at(-1)!;
  const bucketLabel = last - first < 86_400_000
    ? (value: number) => new Date(value).toISOString().slice(11, 16)
    : (value: number) => new Date(value).toISOString().slice(0, 10);
  return {
    ...base,
    kind: "date",
    buckets: distribution(sorted, bucketLabel),
    stats: [
      { label: "Earliest", value: formatInstant(first) },
      { label: "Latest", value: formatInstant(last) },
      { label: "Missing", value: base.missing },
      { label: "Distinct", value: base.distinct },
    ],
  };
}

function categoricalProfile(
  base: ProfileBase,
  values: unknown[],
  kind: "category" | "boolean",
): DatasetProfile {
  const counts = new Map<string, number>();
  for (const value of values) {
    const label = valueText(value);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return {
    ...base,
    kind,
    buckets: [...counts]
      .sort(
        ([leftLabel, leftCount], [rightLabel, rightCount]) =>
          rightCount - leftCount || leftLabel.localeCompare(rightLabel),
      )
      .slice(0, MAX_CATEGORIES)
      .map(([label, count]) => ({ label, count })),
    stats: [
      { label: "Populated", value: base.populated },
      { label: "Missing", value: base.missing },
      { label: "Distinct", value: base.distinct },
    ],
  };
}

function distribution(
  values: number[],
  format: (value: number) => string,
): DatasetProfile["buckets"] {
  const minimum = values[0]!;
  const maximum = values.at(-1)!;
  if (minimum === maximum) {
    return [{ label: format(minimum), count: values.length }];
  }
  const bucketCount = Math.min(
    MAX_BUCKETS,
    Math.max(2, Math.ceil(Math.sqrt(values.length))),
  );
  const width = (maximum - minimum) / bucketCount;
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    label: `${format(minimum + width * index)}–${format(
      minimum + width * (index + 1),
    )}`,
    count: 0,
  }));
  for (const value of values) {
    const index = Math.min(
      bucketCount - 1,
      Math.floor((value - minimum) / width),
    );
    buckets[index]!.count += 1;
  }
  return buckets;
}

function numericValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/[$€£¥,\s]/g, "").replace(/%$/, "");
  return /^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(normalized)
    ? Number(normalized)
    : null;
}

function dateValue(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function formatNumber(value: number): string {
  return String(Number(value.toFixed(2)));
}

function formatInstant(value: number): string {
  return new Date(value).toISOString().replace("T", " ").slice(0, 16);
}

type ProfileBase = Pick<
  DatasetProfile,
  "columnKey" | "label" | "populated" | "missing" | "distinct"
>;
