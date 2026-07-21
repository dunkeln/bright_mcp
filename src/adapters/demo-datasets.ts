import { z } from "zod";
import {
  CapabilityError,
  type DatasetDefinition,
  type DatasetResult,
  type DatasetSummary,
} from "../core/contracts";
import type { DatasetCatalog, DatasetRunner } from "../core/datasets";
import type { ResultStore } from "../core/results";

const inputSchema = z.object({
  query: z.string().trim().min(1).max(120),
  category: z.enum(["audio", "computing", "photo"]).optional(),
  limit: z.number().int().min(1).max(20).default(12),
});

const definition: DatasetDefinition = {
  id: "ecommerce-products",
  title: "E-commerce products",
  description:
    "Search a representative product catalog by words in the title or description.",
  operations: [
    {
      kind: "search",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 1, maxLength: 120 },
          category: { type: "string", enum: ["audio", "computing", "photo"] },
          limit: { type: "integer", minimum: 1, maximum: 20, default: 12 },
        },
      },
      limits: ["Returns at most 20 rows in this demo dataset."],
      examples: [{ query: "wireless", category: "audio", limit: 8 }],
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
        if (input.operation !== "search") {
          throw new CapabilityError(
            "operation_not_supported",
            `Dataset ${definition.id} does not support ${input.operation}.`,
            false,
            "Call describe_dataset and use one of its operations.",
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

        const query = parsed.data.query.toLowerCase();
        const matches = rows
          .filter(
            (row) =>
              (!parsed.data.category || row.category === parsed.data.category) &&
              `${row.title} ${row.category}`.toLowerCase().includes(query),
          )
          .slice(0, parsed.data.limit);

        const base: Omit<
          DatasetResult,
          "rows" | "rowRefs" | "page" | "artifact"
        > = {
          schemaVersion: 1,
          resultId: `result_${crypto.randomUUID()}`,
          dataset: { id: definition.id, title: definition.title },
          operation: "search",
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

function unknownDataset(datasetId: string) {
  return new CapabilityError(
    "dataset_not_found",
    `Dataset ${datasetId} is not available.`,
    false,
    "Call find_datasets to obtain a current dataset ID.",
  );
}
