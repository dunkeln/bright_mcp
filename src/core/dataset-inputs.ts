import { z } from "zod";
import type { JsonObject } from "./contracts";

export const datasetFilterSchema: z.ZodType<JsonObject> = z.lazy(() =>
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
      filters: z.array(datasetFilterSchema).min(1).max(20),
    }).strict(),
  ]),
);

export const marketplaceInputSchema = z.object({
  filter: datasetFilterSchema,
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

export const urlCollectionInputSchema = z.object({
  urls: z.array(z.url()).min(1).max(20),
  acknowledgeCost: z.literal(true),
}).strict();

export const keywordCollectionInputSchema = z.object({
  query: z.string().trim().min(1).max(160),
  pages: z.number().int().min(1).max(5).default(1),
  acknowledgeCost: z.literal(true),
}).strict();

const datasetIdSchema = z.string().trim().min(1).max(120);
export const datasetRunArgumentsSchema = z.union([
  urlCollectionInputSchema,
  keywordCollectionInputSchema,
  marketplaceInputSchema,
]);

export const datasetRunInputSchema = z.discriminatedUnion("operation", [
  z.object({
    datasetId: datasetIdSchema,
    operation: z.literal("collect"),
    arguments: z.union([urlCollectionInputSchema, keywordCollectionInputSchema]),
  }).strict(),
  z.object({
    datasetId: datasetIdSchema,
    operation: z.literal("search"),
    arguments: marketplaceInputSchema,
  }).strict(),
]);

export type DatasetRunInput = z.infer<typeof datasetRunInputSchema>;
export type DatasetExecutionInput = DatasetRunInput | {
  datasetId: "deep-web-research";
  operation: "search";
  arguments: z.infer<typeof deepLookupInputSchema>;
};
