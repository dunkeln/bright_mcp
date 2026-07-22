import { LRUCache } from "lru-cache";
import { z } from "zod";
import {
  CapabilityError,
  type DatasetDefinition,
  type JsonObject,
  type RequestContext,
} from "../../core/contracts";
import {
  keywordCollectionInputSchema,
  marketplaceInputSchema,
  urlCollectionInputSchema,
} from "../../core/dataset-inputs";
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
type MaintainedCollector = {
  upstreamId: string;
  kind: CollectorInputKind;
  title: string;
  description: string;
};

/**
 * Trigger input shapes omitted by Bright Data's live dataset metadata.
 * Entries enrich account-discovered datasets; they do not create or rank them.
 */
const collectorInputKinds = new Map<string, CollectorInputKind>([
  ["gd_l7q7dkf244hwjntr0", "urls"],
  ["gd_l95fol7l1ru6rlo116", "urls"],
  ["gd_l1viktl72bvl7bjuj0", "urls"],
  ["gd_l1vikfnt1wgvvqz95w", "urls"],
  ["gd_lpfll7v5hcqtkxl6l", "urls"],
  ["gd_l1vikfch901nx3by4", "urls"],
  ["gd_lk5ns7kz21pck8jpis", "urls"],
  ["gd_lyclm1571iy3mv57zw", "urls"],
  ["gd_l1vijqt9jfj7olije", "urls"],
]);

const maintainedCollectors = new Map<string, MaintainedCollector>([
  ["gd_lwdb4vjm1ehb499uxs", {
    upstreamId: "gd_lwdb4vjm1ehb499uxs",
    kind: "keyword",
    title: "Amazon product search",
    description: "Collect fresh structured Amazon product search records by keyword.",
  }],
]);

export function collectorFor(upstreamId: string) {
  const maintained = maintainedCollectors.get(upstreamId);
  if (maintained) return maintained;
  const kind = collectorInputKinds.get(upstreamId);
  return kind ? { upstreamId, kind } : undefined;
}

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
      let available: z.infer<typeof datasetListSchema> = [];
      try {
        available = await list(context);
      } catch (error) {
        if (!(error instanceof CapabilityError) || error.code !== "upstream_capability_unavailable") {
          throw error;
        }
      }
      const marketplace = available.map((dataset) => ({
        score: rank(dataset.name, terms),
        dataset,
      }));
      const known = [...maintainedCollectors.values()]
        .filter(({ upstreamId }) => !available.some(({ id }) => id === upstreamId))
        .map((collector) => ({
          score: rank(`${collector.title} ${collector.description}`, terms),
          collector,
        }));
      const selected = [...marketplace, ...known]
        .filter(({ score }) => score > 0)
        .sort((left, right) => right.score - left.score || candidateTitle(left).localeCompare(candidateTitle(right)))
        .slice(0, limit);
      return Promise.all(selected.map(async (candidate) => {
        if ("collector" in candidate) return maintainedCollectorDefinition(candidate.collector);
        const fallback = maintainedCollectors.get(candidate.dataset.id);
        try {
          return marketplaceDefinition(candidate.dataset, await fields(candidate.dataset.id, context));
        } catch (error) {
          if (fallback && error instanceof CapabilityError && error.code === "upstream_capability_unavailable") {
            return maintainedCollectorDefinition(fallback);
          }
          throw error;
        }
      }));
    },

    async describe(datasetId, context) {
      if (!datasetId.startsWith("marketplace:")) throw unknownDataset(datasetId);
      const upstreamId = datasetId.slice("marketplace:".length);
      const maintained = maintainedCollectors.get(upstreamId);
      try {
        const available = (await list(context)).find(({ id }) => id === upstreamId);
        if (!available) {
          if (maintained) return maintainedCollectorDefinition(maintained);
          throw unknownDataset(datasetId);
        }
        return marketplaceDefinition(available, await fields(upstreamId, context));
      } catch (error) {
        if (maintained && error instanceof CapabilityError && error.code === "upstream_capability_unavailable") {
          return maintainedCollectorDefinition(maintained);
        }
        throw error;
      }
    },
  };
}

function candidateTitle(candidate: { dataset: { name: string } } | { collector: MaintainedCollector }) {
  return "dataset" in candidate ? candidate.dataset.name : candidate.collector.title;
}

function maintainedCollectorDefinition(collector: MaintainedCollector): DatasetDefinition {
  return {
    id: `marketplace:${collector.upstreamId}`,
    title: collector.title,
    description: collector.description,
    operations: [collectorOperation(collector)],
  };
}

function collectorOperation(collector: NonNullable<ReturnType<typeof collectorFor>>) {
  const schema = collector.kind === "urls"
    ? urlCollectionInputSchema
    : keywordCollectionInputSchema;
  return {
    kind: "collect" as const,
    inputSchema: z.toJSONSchema(schema, { target: "draft-7" }) as JsonObject,
    limits: ["Runs a paid managed scraper and returns an upstream-backed result resource."],
    examples: [collector.kind === "urls"
      ? { urls: ["https://example.com/record"], acknowledgeCost: true }
      : { query: "wireless earbuds", pages: 1, acknowledgeCost: true }],
  };
}

function marketplaceDefinition(
  dataset: z.infer<typeof datasetListSchema>[number],
  metadata: z.infer<typeof metadataSchema>,
): DatasetDefinition {
  const collector = collectorFor(dataset.id);
  const visibleFields = Object.entries(metadata.fields)
    .filter(([, field]) => field.active !== false)
    .slice(0, 30)
    .map(([name, field]) => `${name} (${field.type ?? "unknown"})${field.description ? `: ${field.description}` : ""}`);
  return {
    id: `marketplace:${dataset.id}`,
    title: dataset.name,
    description: `${collector ? "Collect fresh records or search" : "Search"} ${dataset.size?.toLocaleString() ?? "available"} maintained Bright Data Marketplace records. Available fields:\n${visibleFields.join("\n")}`,
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
