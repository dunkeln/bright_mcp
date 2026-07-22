import { z } from "zod";
import {
  CapabilityError,
  type DatasetDefinition,
  type DatasetResultBase,
} from "../core/contracts";
import type { DatasetCatalog, DatasetRunner } from "../core/datasets";
import {
  deepLookupInputSchema,
  marketplaceInputSchema,
  urlCollectionInputSchema,
} from "../core/dataset-inputs";
import type { ResultStore } from "../core/results";

const definition: DatasetDefinition = {
  id: "ecommerce-products",
  title: "E-commerce products",
  description:
    "Search a representative product catalog or collect known records by product ID.",
  operations: [
    {
      kind: "collect",
      inputSchema: z.toJSONSchema(urlCollectionInputSchema, { target: "draft-7" }),
      limits: ["Collects at most 20 known product records in the requested order."],
      examples: [{
        urls: ["https://example.com/product-1", "https://example.com/product-5"],
        acknowledgeCost: true,
      }],
    },
    {
      kind: "search",
      inputSchema: z.toJSONSchema(marketplaceInputSchema, { target: "draft-7" }),
      limits: ["Returns at most 20 rows in this demo dataset."],
      examples: [{
        filter: { name: "category", operator: "=", value: "audio" },
        limit: 8,
        acknowledgeCost: true,
      }],
    },
  ],
};

const rows = [
  ["Wireless Studio Headphones", "audio", 249, 4.8],
  ["Pocket Bluetooth Speaker", "audio", 79, 4.5],
  ["Noise Cancelling Earbuds", "audio", 159, 4.7],
  ["USB Podcast Microphone", "audio", 129, 4.6],
  ["Mechanical Keyboard", "computing", 139, 4.7],
  ["Ultralight Wireless Mouse", "computing", 89, 4.6],
  ["Portable 4K Monitor", "computing", 329, 4.4],
  ["Thunderbolt Dock", "computing", 219, 4.5],
  ["Ergonomic Laptop Stand", "computing", 69, 4.3],
  ["Mirrorless Travel Camera", "photo", 1199, 4.8],
  ["Compact Prime Lens", "photo", 449, 4.7],
  ["Carbon Travel Tripod", "photo", 189, 4.5],
  ["Wireless Camera Remote", "photo", 39, 4.2],
  ["Action Camera Kit", "photo", 379, 4.4],
].map(([title, category, price, rating], index) => ({
  productId: `product-${index + 1}`,
  title,
  category,
  price,
  rating,
}));

export function createDemoDatasetAdapter(resultStore: ResultStore): {
  catalog: DatasetCatalog;
  runner: DatasetRunner;
} {
  return {
    catalog: {
      async find(query, limit) {
        const terms = query.toLowerCase().split(/\s+/);
        const searchable = `${definition.title} ${definition.description}`.toLowerCase();
        return terms.some((term) => searchable.includes(term))
          ? [definition].slice(0, limit)
          : [];
      },
      async describe(datasetId) {
        if (datasetId !== definition.id) {
          throw unknownDataset(datasetId);
        }
        return definition;
      },
    },
    runner: {
      async run(input, context) {
        if (input.datasetId === "deep-web-research") {
          const request = parseInput(deepLookupInputSchema, input.arguments);
          const result: DatasetResultBase = {
            schemaVersion: 1,
            resultId: `result_${crypto.randomUUID()}`,
            dataset: { id: input.datasetId, title: "Deep web research" },
            operation: "search",
            columns: [
              { key: "finding", label: "Finding", type: "string" },
              { key: "sourceUrl", label: "Source URL", type: "string" },
            ],
          };
          const sourceUrl = request.query.match(/https?:\/\/[^\s,]+/)?.[0] ?? "https://example.com/";
          return resultStore.save(result, [{ finding: request.query, sourceUrl }], context);
        }
        if (input.datasetId !== definition.id) {
          throw unknownDataset(input.datasetId);
        }
        const matches = input.operation === "search"
          ? rows.slice(0, parseInput(marketplaceInputSchema, input.arguments).limit)
          : collectRows(parseInput(urlCollectionInputSchema, input.arguments));

        const base: DatasetResultBase = {
          schemaVersion: 1,
          resultId: `result_${crypto.randomUUID()}`,
          dataset: { id: definition.id, title: definition.title },
          operation: input.operation,
          columns: [
            { key: "productId", label: "Product ID", type: "string" },
            { key: "title", label: "Title", type: "string" },
            { key: "category", label: "Category", type: "string" },
            { key: "price", label: "Price (USD)", type: "number" },
            { key: "rating", label: "Rating", type: "number" },
          ],
        };

        return resultStore.save(base, matches, context);
      },
    },
  };
}

function collectRows(input: z.infer<typeof urlCollectionInputSchema>) {
  const byId = new Map(rows.map((row) => [row.productId, row]));
  return input.urls.flatMap((url) => {
    const productId = new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "";
    const row = byId.get(productId);
    return row ? [row] : [];
  });
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new CapabilityError(
      "invalid_dataset_arguments",
      z.prettifyError(parsed.error),
      false,
      "Use the operation and input schema returned by find_datasets.",
    );
  }
  return parsed.data;
}

function unknownDataset(datasetId: string) {
  return new CapabilityError(
    "dataset_not_found",
    `Dataset ${datasetId} is not available.`,
    false,
    "Call find_datasets to obtain a current dataset ID.",
  );
}
