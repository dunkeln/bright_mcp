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
  key: z.string(),
  label: z.string(),
  type: z.string().optional(),
});

export const datasetWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export const datasetResultSchema = z.object({
  schemaVersion: z.literal(1),
  resultId: z.string(),
  dataset: z.object({ id: z.string(), title: z.string() }),
  operation: datasetOperationSchema,
  columns: z.array(datasetColumnSchema),
  rows: z.array(z.record(z.string(), jsonValueSchema)),
  rowRefs: z.array(z.string()),
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
});

export type JsonObject = Record<string, unknown>;
export type DatasetOperation = z.infer<typeof datasetOperationSchema>;
export type DatasetResult = z.infer<typeof datasetResultSchema>;

export type DatasetSummary = {
  id: string;
  title: string;
  summary: string;
  requiredInputs: string[];
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
};

export class CapabilityError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly nextAction?: string,
  ) {
    super(message);
    this.name = "CapabilityError";
  }
}
