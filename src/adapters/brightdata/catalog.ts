import { LRUCache } from "lru-cache";
import { z } from "zod";
import {
  CapabilityError,
  type DatasetDefinition,
  type DatasetSummary,
  type JsonObject,
  type RequestContext,
} from "../../core/contracts";
import type { DatasetCatalog } from "../../core/datasets";
import { BrightDataGateway } from "./gateway";

/**
 * Adapter-only capabilities omitted by Bright Data's live dataset list and
 * metadata responses. Dataset identity and fields remain account-discovered;
 * these IDs only select the supported synchronous execution path.
 */
export const SYNC_SEARCH_DATASETS = new Set([
  "gd_l1viktl72bvl7bjuj0",
  "gd_me5ppxjr2ge6icjuh0",
  "gd_l1vikfnt1wgvvqz95w",
]);

const filterSchema: z.ZodType<JsonObject> = z.lazy(() =>
  z.union([
    z.object({
      name: z.string().trim().min(1).max(160),
      operator: z.enum([
        "=", "!=", "<", "<=", ">", ">=", "in", "not_in", "includes",
        "not_includes", "array_includes", "not_array_includes", "is_null",
        "is_not_null",
      ]),
      value: z.union([
        z.string(), z.number(), z.boolean(),
        z.array(z.union([z.string(), z.number(), z.boolean()])).max(10_000),
      ]).optional(),
    }).strict(),
    z.object({
      operator: z.enum(["and", "or"]),
      filters: z.array(filterSchema).min(1).max(20),
    }).strict(),
  ]),
);

export const marketplaceInputSchema = z.object({
  filter: filterSchema,
  limit: z.number().int().min(1).max(10_000).default(100),
  sort: z.union([
    z.enum(["default", "random"]),
    z.array(z.record(z.string().min(1), z.enum(["asc", "desc"]))).min(1).max(5),
  ]).optional(),
  cursor: z.array(z.union([z.string(), z.number(), z.boolean()])).max(20).optional(),
  acknowledgeCost: z.literal(true),
}).strict();

export const deepLookupInputSchema = z.object({
  query: z.string().trim().min(1).max(2_000),
  limit: z.number().int().min(1).max(100).default(10),
  preview: z.boolean().default(true),
  acknowledgeCost: z.literal(true).optional(),
  maxCostUsd: z.number().positive().max(10_000).optional(),
}).strict().superRefine((input, context) => {
  if (!input.preview && (input.acknowledgeCost !== true || input.maxCostUsd === undefined)) {
    context.addIssue({
      code: "custom",
      message: "Full research requires acknowledgeCost=true and maxCostUsd.",
    });
  }
});

const datasetListSchema = z.array(z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  size: z.number().int().nonnegative().optional(),
}));
const metadataSchema = z.object({
  id: z.string().min(1),
  fields: z.record(z.string(), z.object({
    type: z.string().optional(),
    active: z.boolean().optional(),
    required: z.boolean().optional(),
    description: z.string().optional(),
  }).passthrough()),
});

type CollectorInputKind = "urls" | "keyword";

/**
 * Trigger input shapes omitted by Bright Data's live dataset metadata.
 * Entries enrich account-discovered datasets; they do not create or rank them.
 */
const collectorInputKinds = new Map<string, CollectorInputKind>([
  ["gd_l7q7dkf244hwjntr0", "urls"],
  ["gd_lwdb4vjm1ehb499uxs", "keyword"],
  ["gd_l95fol7l1ru6rlo116", "urls"],
  ["gd_l1viktl72bvl7bjuj0", "urls"],
  ["gd_l1vikfnt1wgvvqz95w", "urls"],
  ["gd_lpfll7v5hcqtkxl6l", "urls"],
  ["gd_l1vikfch901nx3by4", "urls"],
  ["gd_lk5ns7kz21pck8jpis", "urls"],
  ["gd_lyclm1571iy3mv57zw", "urls"],
  ["gd_l1vijqt9jfj7olije", "urls"],
]);

export function collectorFor(upstreamId: string) {
  const kind = collectorInputKinds.get(upstreamId);
  return kind ? { upstreamId, kind } : undefined;
}

const urlCollectorInput = z.object({
  urls: z.array(z.url()).min(1).max(20),
  acknowledgeCost: z.literal(true),
}).strict();
const keywordCollectorInput = z.object({
  query: z.string().trim().min(1).max(160),
  pages: z.number().int().min(1).max(5).default(1),
  acknowledgeCost: z.literal(true),
}).strict();

export function createBrightDataCatalog(gateway: BrightDataGateway): DatasetCatalog {
  const lists = new LRUCache<string, z.infer<typeof datasetListSchema>>({
    max: 1_000,
    ttl: 5 * 60_000,
  });
  const metadata = new LRUCache<string, z.infer<typeof metadataSchema>>({
    max: 5_000,
    ttl: 15 * 60_000,
  });

  async function list(context: RequestContext) {
    let value = lists.get(context.principalId);
    if (value) return value;
    const parsed = datasetListSchema.safeParse((await gateway.requestJson(
      { method: "GET", path: "/datasets/list", timeoutMs: 20_000 },
      context,
    )).data);
    if (!parsed.success) throw malformedCatalog();
    value = parsed.data;
    lists.set(context.principalId, value);
    return value;
  }

  async function fields(datasetId: string, context: RequestContext) {
    const key = `${context.principalId}:${datasetId}`;
    let value = metadata.get(key);
    if (value) return value;
    const parsed = metadataSchema.safeParse((await gateway.requestJson({
      method: "GET",
      path: `/datasets/${encodeURIComponent(datasetId)}/metadata`,
      timeoutMs: 20_000,
    }, context)).data);
    if (!parsed.success) throw malformedCatalog();
    value = parsed.data;
    metadata.set(key, value);
    return value;
  }

  return {
    async find(query, limit, context) {
      const terms = query.toLowerCase().split(/\W+/).filter((term) => term.length > 1);
      const available = await list(context);
      const marketplace = available.map((dataset) => ({
        score: rank(dataset.name, terms),
        value: marketplaceSummary(dataset),
      }));
      const deep = {
        score: rank("deep web research entities companies table sources", terms) +
          (terms.some((term) => ["research", "find", "list", "table"].includes(term)) ? 2 : 0),
        value: deepLookupSummary,
      };
      return [...marketplace, deep]
        .filter(({ score }) => score > 0)
        .sort((left, right) => right.score - left.score || left.value.title.localeCompare(right.value.title))
        .slice(0, limit)
        .map(({ value }) => value);
    },

    async describe(datasetId, context) {
      if (datasetId === deepLookupDefinition.id) return deepLookupDefinition;
      if (!datasetId.startsWith("marketplace:")) throw unknownDataset(datasetId);
      const upstreamId = datasetId.slice("marketplace:".length);
      const available = (await list(context)).find(({ id }) => id === upstreamId);
      if (!available) throw unknownDataset(datasetId);
      return marketplaceDefinition(available, await fields(upstreamId, context));
    },
  };
}

function collectorOperation(collector: NonNullable<ReturnType<typeof collectorFor>>) {
  const schema = collector.kind === "urls" ? urlCollectorInput : keywordCollectorInput;
  return {
    kind: "collect" as const,
    inputSchema: z.toJSONSchema(schema, { target: "draft-7" }) as JsonObject,
    limits: ["Runs a paid managed scraper and returns an upstream-backed result resource."],
    examples: [collector.kind === "urls"
      ? { urls: ["https://example.com/record"], acknowledgeCost: true }
      : { query: "wireless earbuds", pages: 1, acknowledgeCost: true }],
  };
}

function marketplaceSummary(dataset: z.infer<typeof datasetListSchema>[number]): DatasetSummary {
  const collector = collectorFor(dataset.id);
  const operation = collector && collectorOperation(collector);
  return {
    id: `marketplace:${dataset.id}`,
    title: dataset.name,
    summary: `${collector ? "Collect fresh structured records or search" : "Search"} ${dataset.size?.toLocaleString() ?? "available"} maintained marketplace records.`,
    requiredInputs: collector
      ? [collector.kind === "urls" ? "urls" : "query", "acknowledgeCost"]
      : ["filter", "acknowledgeCost"],
    operation: operation?.kind,
    example: operation?.examples[0],
  };
}

function marketplaceDefinition(
  dataset: z.infer<typeof datasetListSchema>[number],
  metadata: z.infer<typeof metadataSchema>,
): DatasetDefinition {
  const collector = collectorFor(dataset.id);
  const visibleFields = Object.entries(metadata.fields)
    .filter(([, field]) => field.active !== false)
    .slice(0, 100)
    .map(([name, field]) => `${name} (${field.type ?? "unknown"})${field.description ? `: ${field.description}` : ""}`);
  return {
    id: `marketplace:${dataset.id}`,
    title: dataset.name,
    description: `Search maintained Bright Data marketplace records. Available fields:\n${visibleFields.join("\n")}`,
    operations: [...(collector ? [collectorOperation(collector)] : []), {
      kind: "search",
      inputSchema: z.toJSONSchema(marketplaceInputSchema, { target: "draft-7" }) as JsonObject,
      limits: [
        SYNC_SEARCH_DATASETS.has(dataset.id)
          ? "Synchronous lookup; at most 1,000 records per call."
          : "Asynchronous filtered snapshot; at most 10,000 records per call.",
        "Billed at the caller account's current Marketplace rate; acknowledgeCost must be true.",
      ],
      examples: [{
        filter: { name: Object.keys(metadata.fields)[0] ?? "url", operator: "is_not_null" },
        limit: 100,
        acknowledgeCost: true,
      }],
    }],
  };
}

const deepLookupDefinition: DatasetDefinition = {
  id: "deep-web-research",
  title: "Deep web research",
  description: "Turn a natural-language research objective into a sourced structured table.",
  operations: [{
    kind: "search",
    inputSchema: z.toJSONSchema(deepLookupInputSchema, { target: "draft-7" }) as JsonObject,
    limits: [
      "Preview is the default and does not launch a full paid run.",
      "Full runs require acknowledgeCost=true and a maxCostUsd at least as large as the computed worst-case cost.",
    ],
    examples: [{ query: "AI infrastructure companies founded after 2022", limit: 10, preview: true }],
  }],
};

const deepLookupSummary: DatasetSummary = {
  id: deepLookupDefinition.id,
  title: deepLookupDefinition.title,
  summary: deepLookupDefinition.description,
  operation: "search",
  requiredInputs: ["query"],
  example: deepLookupDefinition.operations[0]?.examples?.[0],
};

function rank(text: string, terms: string[]) {
  const haystack = text.toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function malformedCatalog() {
  return new CapabilityError(
    "malformed_upstream_response",
    "Bright Data returned an unexpected dataset catalog response.",
    false,
    "Retry once. If this persists, report the request ID.",
  );
}

export function unknownDataset(datasetId: string) {
  return new CapabilityError(
    "dataset_not_found",
    `Dataset ${datasetId} is not available for this account.`,
    false,
    "Call find_datasets to obtain a current account-scoped dataset ID.",
  );
}
