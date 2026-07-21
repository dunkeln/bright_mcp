import { z } from "zod";

export const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const datasetOperationSchema = z.enum(["collect", "search"]);

export const datasetColumnSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.string().optional(),
});

export const datasetWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export const datasetProfileSchema = z.object({
  columnKey: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["numeric", "date", "category", "boolean"]),
  populated: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  distinct: z.number().int().nonnegative(),
  buckets: z.array(z.object({
    label: z.string(),
    count: z.number().int().nonnegative(),
  })).max(8),
  stats: z.array(z.object({
    label: z.string(),
    value: z.union([z.string(), z.number()]),
  })).max(5),
});

export const datasetResultSchema = z.object({
  schemaVersion: z.literal(1),
  resultId: z.string().min(1),
  dataset: z.object({ id: z.string().min(1), title: z.string().min(1) }),
  operation: datasetOperationSchema,
  columns: z.array(datasetColumnSchema),
  profiles: z.array(datasetProfileSchema),
  rows: z.array(z.record(z.string(), jsonValueSchema)),
  rowRefs: z.array(z.string().min(1)),
  page: z.object({
    nextResourceUri: z.string().optional(),
    truncated: z.boolean(),
    totalRows: z.number().int().nonnegative().optional(),
  }),
  artifact: z.object({
    uri: z.string(),
    mediaType: z.string(),
    expiresAt: z.string().optional(),
  }),
  warnings: z.array(datasetWarningSchema).optional(),
}).superRefine((result, context) => {
  const columnKeys = result.columns.map((column) => column.key);
  if (new Set(columnKeys).size !== columnKeys.length) {
    context.addIssue({
      code: "custom",
      path: ["columns"],
      message: "Dataset column keys must be unique.",
    });
  }
  if (result.rowRefs.length !== result.rows.length) {
    context.addIssue({
      code: "custom",
      path: ["rowRefs"],
      message: "Dataset rows and row references must align one-to-one.",
    });
  }
  if (new Set(result.rowRefs).size !== result.rowRefs.length) {
    context.addIssue({
      code: "custom",
      path: ["rowRefs"],
      message: "Dataset row references must be unique within a result.",
    });
  }
});

export type JsonObject = Record<string, unknown>;
export type DatasetOperation = z.infer<typeof datasetOperationSchema>;
export type DatasetProfile = z.infer<typeof datasetProfileSchema>;
export type DatasetResult = z.infer<typeof datasetResultSchema>;
export type DatasetResultBase = Omit<
  DatasetResult,
  "profiles" | "rows" | "rowRefs" | "page" | "artifact"
>;

export type DatasetSummary = {
  id: string;
  title: string;
  summary: string;
  requiredInputs: string[];
  operation?: DatasetOperation;
  example?: JsonObject;
};

export type DatasetDefinition = {
  id: string;
  title: string;
  description: string;
  operations: Array<{
    kind: DatasetOperation;
    inputSchema: JsonObject;
    limits?: string[];
    examples?: JsonObject[];
  }>;
};

export type RequestContext = {
  principalId: string;
  requestId: string;
  signal?: AbortSignal;
};

export class CapabilityError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly nextAction?: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "CapabilityError";
  }
}
