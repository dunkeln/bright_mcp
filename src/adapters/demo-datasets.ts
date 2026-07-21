import { z } from "zod";
import {
  CapabilityError,
  type DatasetDefinition,
  type DatasetResultBase,
  type DatasetSummary,
} from "../core/contracts";
import type { DatasetCatalog, DatasetRunner } from "../core/datasets";
import {
  deepLookupInputSchema,
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
      inputSchema: z.toJSONSchema(deepLookupInputSchema, { target: "draft-7" }),
      limits: ["Returns at most 20 rows in this demo dataset."],
      examples: [{ query: "wireless audio", limit: 8, preview: true }],
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
  const summary: DatasetSummary = {
    id: definition.id,
    title: definition.title,
    summary: definition.description,
    requiredInputs: ["query"],
    operation: "search",
    example: { query: "wireless audio", limit: 8, preview: true },
  };

  return {
    catalog: {
      async find(query, limit) {
        const terms = query.toLowerCase().split(/\s+/);
        const searchable = `${summary.title} ${summary.summary}`.toLowerCase();
        return terms.some((term) => searchable.includes(term))
          ? [summary].slice(0, limit)
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
        if (input.datasetId !== definition.id) {
          throw unknownDataset(input.datasetId);
        }
        const matches = input.operation === "search"
          ? searchRows(parseInput(deepLookupInputSchema, input.arguments))
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

function searchRows(input: z.infer<typeof deepLookupInputSchema>) {
  const query = input.query.toLowerCase();
  return rows
    .filter(
      (row) =>
        `${row.title} ${row.category}`.toLowerCase().includes(query),
    )
    .slice(0, input.limit);
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
      "Call describe_dataset and match the returned input schema.",
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
