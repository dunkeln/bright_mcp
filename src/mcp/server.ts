import {
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CreateTaskRequestHandlerExtra,
  TaskRequestHandlerExtra,
} from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";
import {
  CallToolResultSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  datasetOperationSchema,
  datasetResultSchema,
  jsonValueSchema,
  type DatasetOperation,
  type JsonObject,
  type RequestContext,
} from "../core/contracts";
import { isPublicHttpUrl } from "../core/public-url";
import type { DatasetUseCases } from "../core/datasets";
import type { ResultStore } from "../core/results";
import type { FieldProjection, WebUseCases } from "../core/web";
import type { CancellableTaskStore } from "./task-store";
import type { BrowserUseCases } from "../browser/use-cases";
import { registerBrowserTools } from "./browser-tools";
import { jsonResourceReply, reply, requestContext, runTool } from "./support";

export const DATASET_TABLE_URI = "ui://bright-mcp/dataset-table";

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const summarySchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  requiredInputs: z.array(z.string()),
});

const definitionSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  operations: z.array(
    z.object({
      kind: datasetOperationSchema,
      inputSchema: z.record(z.string(), z.unknown()),
      limits: z.array(z.string()).optional(),
      examples: z.array(z.record(z.string(), z.unknown())).optional(),
    }),
  ),
});

const searchResultSchema = z.object({
  title: z.string(),
  url: z.url(),
  summary: z.string(),
});

const itemFailureSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  nextAction: z.string().optional(),
});

const fieldProjectionSchema: z.ZodType<FieldProjection> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.enum(["string", "number", "boolean"]) }),
    z.object({
      kind: z.literal("object"),
      fields: z.record(z.string().min(1).max(80), fieldProjectionSchema),
    }),
    z.object({ kind: z.literal("array"), items: fieldProjectionSchema }),
  ]),
);

const extractionSchema = z
  .object({
    instructions: z.string().trim().min(1).max(1_000),
    fields: z
      .record(z.string().min(1).max(80), fieldProjectionSchema)
      .refine((fields) => Object.keys(fields).length > 0, "At least one field is required."),
  })
  .superRefine((value, context) => {
    let fieldCount = 0;
    const visit = (field: FieldProjection, depth: number) => {
      if (depth > 4) {
        context.addIssue({
          code: "custom",
          message: "Extraction projections support at most four nested levels.",
        });
        return;
      }
      fieldCount += 1;
      if (field.kind === "object") {
        Object.values(field.fields).forEach((item) => visit(item, depth + 1));
      } else if (field.kind === "array") {
        visit(field.items, depth + 1);
      }
    };
    Object.values(value.fields).forEach((field) => visit(field, 1));
    if (fieldCount > 20) {
      context.addIssue({
        code: "custom",
        message: "Extraction projections support at most 20 fields.",
      });
    }
  });

const scrapeItemSchema = z.object({
  url: z.url(),
  format: z.enum(["markdown", "html"]),
  content: z.string().optional(),
  truncated: z.boolean().optional(),
  error: itemFailureSchema.optional(),
  extraction: z
    .object({
      data: z.record(z.string(), jsonValueSchema),
      provenance: z.object({ provider: z.string(), model: z.string().optional() }),
    })
    .optional(),
  extractionError: itemFailureSchema.optional(),
});

const runDatasetConfig = {
  title: "Run dataset",
  description:
    "Use this when you have described a dataset and want to execute one returned operation with schema-valid arguments. Returns a bounded preview and a completed result resource.",
  inputSchema: {
    datasetId: z.string().trim().min(1).max(120),
    operation: datasetOperationSchema,
    arguments: z.record(z.string(), jsonValueSchema),
  },
  outputSchema: datasetResultSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  _meta: {
    ui: { resourceUri: DATASET_TABLE_URI, visibility: ["model", "app"] },
    "ui/resourceUri": DATASET_TABLE_URI,
    "openai/outputTemplate": DATASET_TABLE_URI,
    "openai/toolInvocation/invoking": "Running dataset…",
    "openai/toolInvocation/invoked": "Dataset ready",
  },
} as const;

type RunDatasetInput = {
  datasetId: string;
  operation: DatasetOperation;
  arguments: JsonObject;
};

export function createBrightMcpServer(dependencies: {
  datasets: DatasetUseCases;
  createWeb: (server: McpServer) => WebUseCases;
  browser?: BrowserUseCases;
  results: ResultStore;
  tasks?: CancellableTaskStore;
  widgetHtml: string;
  principalId: string;
}) {
  const server = new McpServer(
    { name: "bright-mcp", version: "0.1.0" },
    {
      ...(dependencies.tasks
        ? {
            capabilities: {
              tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
            },
            taskStore: dependencies.tasks,
            defaultTaskPollInterval: 500,
          }
        : {}),
      instructions:
        "Use search_web to find current URLs and scrape to retrieve known URLs. For managed datasets, use find_datasets, then describe_dataset, then run_dataset with the returned ID and operation schema.",
    },
  );
  const web = dependencies.createWeb(server);

  server.registerTool(
    "search_web",
    {
      title: "Search web",
      description:
        "Use this to find current public web resources. Returns canonical organic results rather than engine-specific response data.",
      inputSchema: {
        query: z.string().trim().min(1).max(500),
        engine: z.enum(["google", "bing", "duckduckgo"]).default("google"),
        locale: z
          .string()
          .regex(/^[a-zA-Z]{2,3}(?:-[a-zA-Z]{2})?$/)
          .default("en-US"),
        cursor: z.string().max(80).optional(),
      },
      outputSchema: {
        results: z.array(searchResultSchema),
        nextCursor: z.string().optional(),
      },
      annotations: { ...annotations, openWorldHint: true },
    },
    async (input, extra) =>
      runTool(async () => {
        const structuredContent = await web.searchWeb(
          input,
          requestContext(
            dependencies.principalId,
            extra.signal,
            extra.authInfo,
          ),
        );
        return reply(
          structuredContent,
          `Found ${structuredContent.results.length} web results.`,
        );
      }),
  );

  server.registerTool(
    "scrape",
    {
      title: "Scrape URLs",
      description:
        "Use this to retrieve readable content from one to five known public HTTP(S) URLs. Results preserve input order and isolate per-URL failures.",
      inputSchema: {
        urls: z
          .array(z.url().refine(isPublicHttpUrl, "URL must be a public HTTP(S) URL."))
          .min(1)
          .max(5),
        format: z.enum(["markdown", "html"]).default("markdown"),
        extraction: extractionSchema.optional(),
      },
      outputSchema: { results: z.array(scrapeItemSchema) },
      annotations: { ...annotations, openWorldHint: true },
    },
    async (input, extra) =>
      runTool(async () => {
        const structuredContent = await web.scrape(
          input,
          requestContext(
            dependencies.principalId,
            extra.signal,
            extra.authInfo,
          ),
        );
        const failures = structuredContent.results.filter((item) => item.error).length;
        return reply(
          structuredContent,
          `Scraped ${structuredContent.results.length - failures} of ${structuredContent.results.length} URLs.`,
        );
      }),
  );

  server.registerTool(
    "find_datasets",
    {
      title: "Find datasets",
      description:
        "Use this when you need to discover a dataset for a web-data task. Returns concise candidates that can be passed to describe_dataset.",
      inputSchema: {
        query: z.string().trim().min(1).max(500),
        limit: z.number().int().min(1).max(10).default(5),
      },
      outputSchema: { datasets: z.array(summarySchema) },
      annotations,
    },
    async ({ query, limit }) =>
      runTool(async () => {
        const structuredContent = {
          datasets: await dependencies.datasets.findDatasets(query, limit),
        };
        return reply(
          structuredContent,
          structuredContent.datasets.length
            ? `Found ${structuredContent.datasets.length} matching dataset capability.`
            : "No matching dataset capability was found. Try a broader task description.",
        );
      }),
  );

  server.registerTool(
    "describe_dataset",
    {
      title: "Describe dataset",
      description:
        "Use this when you have a dataset ID from find_datasets and need its exact operations and executable input schemas.",
      inputSchema: { datasetId: z.string().trim().min(1).max(120) },
      outputSchema: definitionSchema,
      annotations,
    },
    async ({ datasetId }) =>
      runTool(async () => {
        const structuredContent =
          await dependencies.datasets.describeDataset(datasetId);
        return reply(
          structuredContent,
          `${structuredContent.title} supports ${structuredContent.operations.map((item) => item.kind).join(", ")}.`,
        );
      }),
  );

  if (dependencies.tasks) {
    const tasks = dependencies.tasks;
    server.experimental.tasks.registerToolTask(
      "run_dataset",
      { ...runDatasetConfig, execution: { taskSupport: "optional" } },
      {
        async createTask(
          input: RunDatasetInput,
          extra: CreateTaskRequestHandlerExtra,
        ) {
          const task = await extra.taskStore.createTask({
            ttl: taskTtl(extra.taskRequestedTtl),
            pollInterval: 500,
          });
          const controller = new AbortController();
          tasks.bind(task.taskId, controller);
          const abortFromRequest = () => controller.abort(extra.signal.reason);
          extra.signal.addEventListener("abort", abortFromRequest, { once: true });
          const context = requestContext(
            dependencies.principalId,
            controller.signal,
            extra.authInfo,
          );

          void executeRunDataset(input, dependencies, context)
            .then(async (result) => {
              await extra.taskStore.storeTaskResult(
                task.taskId,
                result.isError ? "failed" : "completed",
                result,
              );
            })
            .catch(async (error) => {
              await extra.taskStore.storeTaskResult(task.taskId, "failed", {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      code: "internal_error",
                      message:
                        error instanceof Error ? error.message : "Task failed.",
                      retryable: true,
                      nextAction: "Retry once.",
                    }),
                  },
                ],
              });
            })
            .finally(() => {
              extra.signal.removeEventListener("abort", abortFromRequest);
              tasks.release(task.taskId);
            });

          return { task };
        },
        async getTask(
          _input: RunDatasetInput,
          extra: TaskRequestHandlerExtra,
        ) {
          return extra.taskStore.getTask(extra.taskId);
        },
        async getTaskResult(
          _input: RunDatasetInput,
          extra: TaskRequestHandlerExtra,
        ) {
          return CallToolResultSchema.parse(
            await extra.taskStore.getTaskResult(extra.taskId),
          );
        },
      },
    );
  } else {
    server.registerTool("run_dataset", runDatasetConfig, async (input, extra) =>
      executeRunDataset(
        input,
        dependencies,
        requestContext(
          dependencies.principalId,
          extra.signal,
          extra.authInfo,
        ),
      ),
    );
  }

  server.registerResource(
    "dataset-definition",
    new ResourceTemplate("brightdata://datasets/{datasetId}", { list: undefined }),
    { mimeType: "application/json", description: "Dataset capability definition" },
    async (uri, { datasetId }) =>
      jsonResourceReply(
        uri,
        await dependencies.datasets.describeDataset(String(datasetId)),
      ),
  );

  server.registerResource(
    "dataset-result",
    new ResourceTemplate("brightdata://results/{resultId}", { list: undefined }),
    { mimeType: "application/json", description: "Completed dataset result" },
    async (uri, { resultId }, extra) =>
      jsonResourceReply(
        uri,
        dependencies.results.readResult(
          String(resultId),
          requestContext(
            dependencies.principalId,
            extra.signal,
            extra.authInfo,
          ).principalId,
        ),
      ),
  );

  server.registerResource(
    "dataset-result-page",
    new ResourceTemplate("brightdata://pages/{pageToken}", { list: undefined }),
    { mimeType: "application/json", description: "Dataset result continuation page" },
    async (uri, { pageToken }, extra) =>
      jsonResourceReply(
        uri,
        dependencies.results.readPage(
          String(pageToken),
          requestContext(
            dependencies.principalId,
            extra.signal,
            extra.authInfo,
          ).principalId,
        ),
      ),
  );

  registerAppResource(
    server,
    "Dataset table",
    DATASET_TABLE_URI,
    {
      mimeType: RESOURCE_MIME_TYPE,
      description: "Interactive projection of a canonical dataset result",
      _meta: {
        ui: {
          prefersBorder: true,
          csp: { connectDomains: [], resourceDomains: [] },
        },
        "openai/widgetDescription":
          "Shows the dataset result as a filterable, sortable, paged table with ordered row selection.",
      },
    },
    async () => ({
      contents: [
        {
          uri: DATASET_TABLE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: dependencies.widgetHtml,
          _meta: {
            ui: {
              prefersBorder: true,
              csp: { connectDomains: [], resourceDomains: [] },
            },
            "openai/widgetDescription":
              "Shows the dataset result as a filterable, sortable, paged table with ordered row selection.",
          },
        },
      ],
    }),
  );

  if (dependencies.browser) {
    registerBrowserTools(server, dependencies.browser, dependencies.principalId);
  }

  return server;
}

function executeRunDataset(
  input: {
    datasetId: string;
    operation: DatasetOperation;
    arguments: JsonObject;
  },
  dependencies: {
    datasets: DatasetUseCases;
    principalId: string;
  },
  context: RequestContext,
): Promise<CallToolResult> {
  return runTool(async () => {
    const structuredContent = await dependencies.datasets.runDataset(
      input,
      context,
    );
    return {
      structuredContent,
      content: [
        {
          type: "text" as const,
          text: `${structuredContent.dataset.title} returned ${structuredContent.page.totalRows ?? structuredContent.rows.length} rows. The response includes a bounded preview.`,
        },
        {
          type: "resource_link" as const,
          uri: structuredContent.artifact.uri,
          name: `${structuredContent.dataset.title} result`,
          description: "Completed canonical dataset result",
          mimeType: structuredContent.artifact.mediaType,
        },
      ],
    };
  });
}

function taskTtl(requested: number | null | undefined) {
  if (requested === null || requested === undefined) return 15 * 60_000;
  return Math.min(Math.max(requested, 60_000), 15 * 60_000);
}
