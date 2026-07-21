import { z } from "zod";
import {
  CapabilityError,
  jsonValueSchema,
  type DatasetDefinition,
  type DatasetResult,
  type DatasetSummary,
} from "../../core/contracts";
import type { DatasetCatalog, DatasetRunner } from "../../core/datasets";
import type { ResultStore } from "../../core/results";
import { BrightDataGateway } from "./gateway";

const UPSTREAM_DATASET_ID = "gd_lwdb4vjm1ehb499uxs";
const MAX_ROWS = 100;
const MAX_RESULT_BYTES = 500_000;
const POLL_DEADLINE_MS = 55_000;

const inputSchema = z.object({
  query: z.string().trim().min(1).max(160),
  pages: z.number().int().min(1).max(3).default(1),
}).strict();

const upstreamRowsSchema = z.array(z.record(z.string(), jsonValueSchema));
const snapshotSchema = z.object({ snapshot_id: z.string().min(1) });
const progressSchema = z.object({
  snapshot_id: z.string(),
  dataset_id: z.string().optional(),
  status: z.enum(["starting", "running", "ready", "failed"]),
});

const definition: DatasetDefinition = {
  id: "amazon-products-search",
  title: "Amazon products search",
  description:
    "Search Amazon.com product listings by keyword using Bright Data's managed scraper.",
  operations: [
    {
      kind: "search",
      inputSchema: z.toJSONSchema(inputSchema, { target: "draft-7" }),
      limits: [
        "Searches Amazon.com.",
        "Accepts one to three search-result pages.",
        "Returns at most 100 normalized rows synchronously.",
      ],
      examples: [{ query: "wireless earbuds", pages: 1 }],
    },
  ],
};

const summary: DatasetSummary = {
  id: definition.id,
  title: definition.title,
  summary: definition.description,
  requiredInputs: ["query"],
};

export function createBrightDataDatasetAdapter(
  gateway: BrightDataGateway,
  resultStore: ResultStore,
): { catalog: DatasetCatalog; runner: DatasetRunner } {
  return {
    catalog: {
      async find(query, limit) {
        const text = query.toLowerCase();
        const matches = ["amazon", "product", "shopping", "ecommerce"].some(
          (word) => text.includes(word),
        );
        return matches ? [summary].slice(0, limit) : [];
      },
      async describe(datasetId) {
        if (datasetId !== definition.id) throw unknownDataset(datasetId);
        return definition;
      },
    },
    runner: {
      async run(input, context) {
        if (input.datasetId !== definition.id) throw unknownDataset(input.datasetId);
        if (input.operation !== "search") {
          throw new CapabilityError(
            "operation_not_supported",
            `${definition.id} does not support ${input.operation}.`,
            false,
            "Call describe_dataset and use its search operation.",
          );
        }
        const parsed = inputSchema.safeParse(input.arguments);
        if (!parsed.success) {
          throw new CapabilityError(
            "invalid_dataset_arguments",
            z.prettifyError(parsed.error),
            false,
            "Call describe_dataset and match the returned input schema.",
          );
        }

        const response = await gateway.requestJson(
          {
            method: "POST",
            path: "/datasets/v3/scrape",
            query: { dataset_id: UPSTREAM_DATASET_ID, format: "json" },
            body: [
              {
                keyword: parsed.data.query,
                url: "https://www.amazon.com",
                pages_to_search: parsed.data.pages,
              },
            ],
            timeoutMs: 65_000,
          },
          context,
        );

        const rows = Array.isArray(response.data)
          ? parseRows(response.data)
          : await finishSnapshot(gateway, response.data, context);
        const bounded = boundRows(rows);
        const base: Omit<
          DatasetResult,
          "rows" | "rowRefs" | "page" | "artifact"
        > = {
          schemaVersion: 1,
          resultId: `result_${crypto.randomUUID()}`,
          dataset: { id: definition.id, title: definition.title },
          operation: "search",
          columns: columnsFor(bounded.rows),
          warnings: bounded.truncated
            ? [
                {
                  code: "result_truncated",
                  message:
                    "The complete upstream response exceeded the synchronous result limits.",
                },
              ]
            : undefined,
        };
        return resultStore.save(base, bounded.rows, context);
      },
    },
  };
}

async function finishSnapshot(
  gateway: BrightDataGateway,
  value: unknown,
  context: Parameters<DatasetRunner["run"]>[1],
) {
  const snapshot = snapshotSchema.safeParse(value);
  if (!snapshot.success) malformed();
  const deadline = Date.now() + POLL_DEADLINE_MS;

  while (Date.now() < deadline) {
    if (context.signal?.aborted) {
      throw new CapabilityError("cancelled", "Dataset execution was cancelled.");
    }
    await Bun.sleep(1_000);
    const progressResponse = await gateway.requestJson(
      {
        method: "GET",
        path: `/datasets/v3/progress/${encodeURIComponent(snapshot.data.snapshot_id)}`,
        timeoutMs: 10_000,
      },
      context,
    );
    const progress = progressSchema.safeParse(progressResponse.data);
    if (!progress.success) malformed();
    if (progress.data.status === "failed") {
      throw new CapabilityError(
        "upstream_job_failed",
        "Bright Data could not complete the dataset search.",
        false,
        "Review the input and retry once.",
      );
    }
    if (progress.data.status === "ready") {
      const download = await gateway.requestJson(
        {
          method: "GET",
          path: `/datasets/v3/snapshot/${encodeURIComponent(snapshot.data.snapshot_id)}`,
          query: { format: "json" },
          timeoutMs: 30_000,
        },
        context,
      );
      return parseRows(download.data);
    }
  }

  throw new CapabilityError(
    "upstream_timeout",
    "The Bright Data dataset search did not finish within the synchronous deadline.",
    true,
    "Retry with fewer pages or use task-backed execution when available.",
  );
}

function parseRows(value: unknown): DatasetResult["rows"] {
  const parsed = upstreamRowsSchema.safeParse(value);
  if (!parsed.success) malformed();
  return parsed.data;
}

function boundRows(rows: DatasetResult["rows"]) {
  const bounded: DatasetResult["rows"] = [];
  const encoder = new TextEncoder();
  let bytes = 2;
  for (const row of rows) {
    const rowBytes = encoder.encode(JSON.stringify(row)).byteLength + 1;
    if (bounded.length >= MAX_ROWS || bytes + rowBytes > MAX_RESULT_BYTES) break;
    bounded.push(row);
    bytes += rowBytes;
  }
  return { rows: bounded, truncated: bounded.length < rows.length };
}

function columnsFor(rows: DatasetResult["rows"]): DatasetResult["columns"] {
  const candidates = [
    ["title", "Title", "string"],
    ["asin", "ASIN", "string"],
    ["price", "Price", "number"],
    ["currency", "Currency", "string"],
    ["rating", "Rating", "number"],
    ["reviews_count", "Reviews", "number"],
    ["sponsored", "Sponsored", "boolean"],
    ["position", "Position", "number"],
    ["url", "URL", "string"],
  ] as const;
  return candidates
    .filter(([key]) => rows.length === 0 || rows.some((row) => key in row))
    .map(([key, label, type]) => ({ key, label, type }));
}

function malformed(): never {
  throw new CapabilityError(
    "malformed_upstream_response",
    "Bright Data returned an unexpected dataset response shape.",
    false,
    "Retry once. If this persists, update the Bright Data adapter fixture.",
  );
}

function unknownDataset(datasetId: string) {
  return new CapabilityError(
    "dataset_not_found",
    `Dataset ${datasetId} is not available.`,
    false,
    "Call find_datasets to obtain a current dataset ID.",
  );
}
