import { z } from "zod";
import {
  CapabilityError,
  jsonValueSchema,
  type DatasetResult,
  type DatasetResultBase,
  type JsonObject,
  type RequestContext,
} from "../../core/contracts";
import type { DatasetRunner } from "../../core/datasets";
import {
  deepLookupInputSchema,
  keywordCollectionInputSchema,
  marketplaceInputSchema,
  urlCollectionInputSchema,
} from "../../core/dataset-inputs";
import type { ResultSource, ResultStore } from "../../core/results";
import {
  SYNC_SEARCH_DATASETS,
  collectorFor,
  createBrightDataCatalog,
  unknownDataset,
} from "./catalog";
import { BrightDataGateway, pollBrightData } from "./gateway";

const SNAPSHOT_PART_ROWS = 1_000;
const POLL_DEADLINE_MS = 5 * 60_000;
const RESULT_TTL_MS = 15 * 60_000;
const rowsSchema = z.array(z.record(z.string(), jsonValueSchema));
const snapshotTriggerSchema = z.object({ snapshot_id: z.string().min(1) });
const snapshotMetadataSchema = z.object({
  status: z.enum(["starting", "running", "ready", "failed"]),
  dataset_size: z.number().int().nonnegative().optional(),
  cost: z.number().nonnegative().optional(),
  error: z.string().optional(),
  error_code: z.string().optional(),
  warning: z.string().optional(),
  warning_code: z.string().optional(),
});
const synchronousSearchSchema = z.object({
  hits: rowsSchema,
  total_hits: z.number().int().nonnegative(),
  search_after: z.array(jsonValueSchema).optional(),
});
const deepPreviewTriggerSchema = z.object({
  preview_id: z.string().min(1),
  columns: z.array(z.unknown()).optional(),
});
const deepPreviewSchema = z.object({
  preview_id: z.string().min(1),
  status: z.enum(["pending", "processing", "queued", "running", "completed", "failed"]),
  sample_data: rowsSchema.optional(),
  columns: z.array(z.unknown()).optional(),
  result_limit: z.number().int().optional(),
});
const deepTriggerSchema = z.object({
  request_id: z.string().min(1),
  max_cost: z.string().optional(),
});
const deepRequestSchema = z.object({
  request_id: z.string().min(1),
  status: z.string(),
  step: z.string().optional(),
  matched_records: z.number().int().nonnegative().optional(),
  total_cost: z.string().optional(),
  columns: z.array(z.object({ name: z.string(), description: z.string().optional() }).passthrough()).optional(),
  data: rowsSchema.optional(),
});

export function createBrightDataDatasetAdapter(
  gateway: BrightDataGateway,
  resultStore: ResultStore,
) {
  const catalog = createBrightDataCatalog(gateway);
  return {
    catalog,
    runner: {
      async run(input, context) {
        if (input.datasetId === "deep-web-research") {
          return runDeepLookup(gateway, resultStore, input.arguments, context);
        }
        if (input.datasetId.startsWith("marketplace:")) {
          const definition = await catalog.describe(input.datasetId, context);
          const collector = collectorFor(input.datasetId.slice("marketplace:".length));
          if (input.operation === "collect" && collector) {
            return runCollector(gateway, resultStore, input, definition.title, collector, context);
          }
          return runMarketplace(gateway, resultStore, input, definition.title, context);
        }
        throw unknownDataset(input.datasetId);
      },
    } satisfies DatasetRunner,
  };
}

async function runCollector(
  gateway: BrightDataGateway,
  store: ResultStore,
  input: Parameters<DatasetRunner["run"]>[0],
  title: string,
  collector: NonNullable<ReturnType<typeof collectorFor>>,
  context: RequestContext,
) {
  if (input.operation !== "collect") throw unsupported(input.datasetId, input.operation, "collect");
  const parsed = collector.kind === "urls"
    ? urlCollectionInputSchema.safeParse(input.arguments)
    : keywordCollectionInputSchema.safeParse(input.arguments);
  if (!parsed.success) throw invalidArguments(parsed.error);
  const records = collector.kind === "urls"
    ? (parsed.data as { urls: string[] }).urls.map((url) => ({ url }))
    : [{
        keyword: (parsed.data as { query: string }).query,
        url: "https://www.amazon.com",
        pages_to_search: (parsed.data as { pages: number }).pages,
      }];
  const snapshot = parse(snapshotTriggerSchema, (await gateway.requestJson({
    method: "POST",
    path: "/datasets/v3/trigger",
    query: { dataset_id: collector.upstreamId, include_errors: "true" },
    body: records,
    timeoutMs: 30_000,
  }, context)).data);
  const metadata = await finishSnapshotCancellable(gateway, snapshot.snapshot_id, context);
  return saveSnapshot(store, gateway, {
    id: input.datasetId,
    title,
    operation: "collect",
    snapshotId: snapshot.snapshot_id,
    metadata,
  }, context);
}

async function runMarketplace(
  gateway: BrightDataGateway,
  store: ResultStore,
  input: Parameters<DatasetRunner["run"]>[0],
  title: string,
  context: RequestContext,
) {
  if (input.operation !== "search") throw unsupported(input.datasetId, input.operation, "search");
  const parsed = marketplaceInputSchema.safeParse(input.arguments);
  if (!parsed.success) throw invalidArguments(parsed.error);
  if (filterDepth(parsed.data.filter) > 3) {
    throw new CapabilityError(
      "invalid_dataset_arguments",
      "Marketplace filters support at most three nested groups.",
      false,
      "Flatten the filter expression and retry.",
    );
  }
  const upstreamId = input.datasetId.slice("marketplace:".length);
  if (SYNC_SEARCH_DATASETS.has(upstreamId) && parsed.data.limit <= 1_000) {
    const result = parse(synchronousSearchSchema, (await gateway.requestJson({
      method: "POST",
      path: `/datasets/search/${encodeURIComponent(upstreamId)}`,
      body: {
        filter: parsed.data.filter,
        size: parsed.data.limit,
        sort: parsed.data.sort,
        search_after: parsed.data.cursor,
      },
      timeoutMs: 30_000,
    }, context)).data);
    return store.save(base(input.datasetId, title, "search", result.hits, [{
      code: "billed_operation",
      message: "Bright Data billed this Marketplace search to the caller account.",
    }]), result.hits, context);
  }

  if (parsed.data.sort || parsed.data.cursor) {
    throw new CapabilityError(
      "operation_not_supported",
      "Sorting and cursors are available only on synchronous Marketplace search datasets.",
      false,
      "Remove sort and cursor; the asynchronous result resource provides paging.",
    );
  }

  const snapshot = parse(snapshotTriggerSchema, (await gateway.requestJson({
    method: "POST",
    path: "/datasets/filter",
    body: {
      dataset_id: upstreamId,
      filter: parsed.data.filter,
      records_limit: parsed.data.limit,
    },
    timeoutMs: 30_000,
  }, context)).data);
  const metadata = await finishSnapshotCancellable(gateway, snapshot.snapshot_id, context);
  return saveSnapshot(store, gateway, {
    id: input.datasetId,
    title,
    operation: "search",
    snapshotId: snapshot.snapshot_id,
    metadata,
  }, context);
}

async function runDeepLookup(
  gateway: BrightDataGateway,
  store: ResultStore,
  value: JsonObject,
  context: RequestContext,
) {
  const input = deepLookupInputSchema.safeParse(value);
  if (!input.success) throw invalidArguments(input.error);
  const preview = parse(deepPreviewTriggerSchema, (await gateway.requestJson({
    method: "POST",
    path: "/datasets/deep_lookup/v1/preview",
    body: [{ query: input.data.query }],
    timeoutMs: 30_000,
  }, context)).data);
  const previewData = await finishDeepPreview(gateway, preview.preview_id, context);
  if (input.data.preview) {
    const rows = previewData.sample_data ?? [];
    return store.save(base("deep-web-research", "Deep web research preview", "search", rows, [{
      code: "preview_only",
      message: "This is an unbilled preview. Run again with preview=false and an explicit cost cap for full research.",
    }]), rows, context);
  }

  const columnCount = previewData.columns?.length ?? preview.columns?.length ?? 0;
  const worstCaseCost = input.data.limit * (1 + Math.max(0, columnCount - 10) * 0.05);
  if ((input.data.maxCostUsd ?? 0) < worstCaseCost) {
    throw new CapabilityError(
      "cost_cap_too_low",
      `The computed worst-case Deep Lookup cost is $${worstCaseCost.toFixed(2)}.`,
      false,
      "Increase maxCostUsd or reduce the result limit. No full run was started.",
    );
  }
  const triggered = parse(deepTriggerSchema, (await gateway.requestJson({
    method: "POST",
    path: "/datasets/deep_lookup/v1/trigger",
    body: [{ preview_id: preview.preview_id, result_limit: input.data.limit }],
    timeoutMs: 30_000,
  }, context)).data);
  const upstreamMaximum = money(triggered.max_cost);
  if (upstreamMaximum !== undefined && upstreamMaximum > input.data.maxCostUsd!) {
    await cancelDeepRequest(gateway, triggered.request_id, context);
    throw new CapabilityError(
      "cost_cap_exceeded",
      `Bright Data estimated a $${upstreamMaximum.toFixed(2)} maximum, above the caller's cap.`,
      false,
      "Reduce the result limit or increase maxCostUsd. The request was cancelled.",
    );
  }
  let completed: z.infer<typeof deepRequestSchema>;
  try {
    completed = await finishDeepRequest(gateway, triggered.request_id, context);
  } catch (error) {
    if (error instanceof CapabilityError && error.code === "cancelled") {
      await cancelDeepRequest(gateway, triggered.request_id, {
        ...context,
        signal: undefined,
      }).catch(() => undefined);
    }
    throw error;
  }
  const rows = completed.data ?? [];
  return store.save(base("deep-web-research", "Deep web research", "search", rows, [{
    code: "billed_operation",
    message: `Bright Data billed the caller account ${completed.total_cost ?? triggered.max_cost ?? "for matched records"}.`,
  }]), rows, context);
}

async function saveSnapshot(
  store: ResultStore,
  gateway: BrightDataGateway,
  input: {
    id: string;
    title: string;
    operation: "collect" | "search";
    snapshotId: string;
    metadata: z.infer<typeof snapshotMetadataSchema>;
  },
  context: RequestContext,
) {
  const source: ResultSource = {
    partSize: SNAPSHOT_PART_ROWS,
    totalRows: input.metadata.dataset_size,
    expiresAt: new Date(Date.now() + RESULT_TTL_MS).toISOString(),
    async loadPart(part, readContext) {
      return parse(rowsSchema, (await gateway.requestJson({
        method: "GET",
        path: `/datasets/v3/snapshot/${encodeURIComponent(input.snapshotId)}`,
        query: { format: "json", batch_size: String(SNAPSHOT_PART_ROWS), part: String(part) },
        timeoutMs: 45_000,
        maxResponseBytes: 10_000_000,
      }, readContext)).data);
    },
  };
  const firstRows = await source.loadPart(1, context);
  const cachedSource: ResultSource = {
    ...source,
    loadPart: (part, readContext) => part === 1
      ? Promise.resolve(firstRows)
      : source.loadPart(part, readContext),
  };
  const warnings = [{
    code: "billed_operation",
    message: `Bright Data billed this operation to the caller account${input.metadata.cost === undefined ? "." : ` ($${input.metadata.cost.toFixed(2)}).`}`,
  }, ...(input.metadata.warning ? [{
    code: input.metadata.warning_code ?? "upstream_warning",
    message: input.metadata.warning,
  }] : [])];
  return store.save(base(input.id, input.title, input.operation, firstRows, warnings), cachedSource, context);
}

async function finishSnapshot(
  gateway: BrightDataGateway,
  snapshotId: string,
  context: RequestContext,
) {
  return pollBrightData({
    context,
    deadlineMs: POLL_DEADLINE_MS,
    intervalMs: 1_000,
    async load() {
      return parse(snapshotMetadataSchema, (await gateway.requestJson({
        method: "GET",
        path: `/datasets/v3/progress/${encodeURIComponent(snapshotId)}`,
        timeoutMs: 15_000,
      }, context)).data);
    },
    state: (metadata) => metadata.status === "ready"
      ? "ready"
      : metadata.status === "failed" ? "failed" : "pending",
    failed: (metadata) => new CapabilityError(
        metadata.error_code ?? "upstream_job_failed",
        metadata.error ?? "Bright Data could not complete the dataset operation.",
        false,
        "Review the filter or collection input and retry once.",
      ),
    timeout: new CapabilityError(
      "upstream_timeout",
      "Bright Data did not finish the dataset operation within five minutes.",
      true,
      "Retry with a smaller result limit or task-capable host.",
    ),
  });
}

async function finishSnapshotCancellable(
  gateway: BrightDataGateway,
  snapshotId: string,
  context: RequestContext,
) {
  try {
    return await finishSnapshot(gateway, snapshotId, context);
  } catch (error) {
    if (error instanceof CapabilityError && error.code === "cancelled") {
      await gateway.requestJson({
        method: "POST",
        path: `/datasets/v3/snapshot/${encodeURIComponent(snapshotId)}/cancel`,
        timeoutMs: 15_000,
      }, { ...context, signal: undefined }).catch(() => undefined);
    }
    throw error;
  }
}

async function finishDeepPreview(gateway: BrightDataGateway, id: string, context: RequestContext) {
  return pollBrightData({
    context,
    deadlineMs: 55_000,
    intervalMs: 1_000,
    load: async () => parse(deepPreviewSchema, (await gateway.requestJson({
      method: "GET",
      path: `/datasets/deep_lookup/v1/preview/${encodeURIComponent(id)}`,
      timeoutMs: 15_000,
    }, context)).data),
    state: (value) => value.status === "completed"
      ? "ready"
      : value.status === "failed" ? "failed" : "pending",
    failed: () => new CapabilityError("upstream_job_failed", "Deep Lookup preview failed."),
    timeout: new CapabilityError("upstream_timeout", "Deep Lookup preview timed out.", true, "Retry once with a narrower objective."),
  });
}

async function finishDeepRequest(gateway: BrightDataGateway, id: string, context: RequestContext) {
  return pollBrightData({
    context,
    deadlineMs: POLL_DEADLINE_MS,
    intervalMs: 2_000,
    load: async () => parse(deepRequestSchema, (await gateway.requestJson({
      method: "GET",
      path: `/datasets/deep_lookup/v1/request/${encodeURIComponent(id)}`,
      timeoutMs: 20_000,
    }, context)).data),
    state: (value) => value.status === "completed" || value.step === "done"
      ? "ready"
      : value.status === "failed" ? "failed" : "pending",
    failed: () => new CapabilityError("upstream_job_failed", "Deep Lookup research failed."),
    timeout: new CapabilityError("upstream_timeout", "Deep Lookup research timed out.", true, "Retry once with a narrower objective or smaller result limit."),
  });
}

function base(
  id: string,
  title: string,
  operation: "collect" | "search",
  rows: DatasetResult["rows"],
  warnings?: DatasetResult["warnings"],
): DatasetResultBase {
  return {
    schemaVersion: 1,
    resultId: `result_${crypto.randomUUID()}`,
    dataset: { id, title },
    operation,
    columns: columnsFor(rows),
    warnings,
  };
}

function columnsFor(rows: DatasetResult["rows"]): DatasetResult["columns"] {
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))].slice(0, 50);
  return keys.map((key) => ({
    key,
    label: key.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
    type: inferType(rows.find((row) => row[key] !== null && row[key] !== undefined)?.[key]),
  }));
}

function inferType(value: unknown) {
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return typeof value;
  return Array.isArray(value) ? "array" : value && typeof value === "object" ? "object" : undefined;
}

function filterDepth(value: JsonObject): number {
  const filters = Array.isArray(value.filters) ? value.filters : [];
  return filters.length
    ? 1 + Math.max(...filters.map((filter) =>
        filter && typeof filter === "object" && !Array.isArray(filter)
          ? filterDepth(filter as JsonObject)
          : 0))
    : 0;
}

function money(value: string | undefined) {
  if (!value) return undefined;
  const amount = Number(value.replace(/[^\d.]/g, ""));
  return Number.isFinite(amount) ? amount : undefined;
}

async function cancelDeepRequest(
  gateway: BrightDataGateway,
  requestId: string,
  context: RequestContext,
) {
  await gateway.requestJson({
    method: "POST",
    path: `/datasets/deep_lookup/v1/request/${encodeURIComponent(requestId)}/cancel`,
    timeoutMs: 15_000,
  }, context);
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new CapabilityError(
      "malformed_upstream_response",
      "Bright Data returned an unexpected dataset response.",
      false,
      "Retry once. If this persists, report the request ID.",
    );
  }
  return parsed.data;
}

function invalidArguments(error: z.ZodError) {
  return new CapabilityError(
    "invalid_dataset_arguments",
    z.prettifyError(error),
    false,
    "Use the operation and input schema returned by find_datasets.",
  );
}

function unsupported(datasetId: string, actual: string, expected: string) {
  return new CapabilityError(
    "operation_not_supported",
    `${datasetId} does not support ${actual}.`,
    false,
    `Use operation ${expected}.`,
  );
}
