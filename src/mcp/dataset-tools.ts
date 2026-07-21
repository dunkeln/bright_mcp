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
  CapabilityError,
  datasetOperationSchema,
  datasetResultSchema,
  jsonValueSchema,
  type DatasetOperation,
  type JsonObject,
  type RequestContext,
} from "../core/contracts";
import type { DatasetUseCases } from "../core/datasets";
import type { ResultStore } from "../core/results";
import { jsonResourceReply, reply, requestContext, runTool } from "./support";
import type { CancellableTaskStore } from "./task-store";

export const DATASET_WORKBENCH_URI = "ui://bright-mcp/dataset-workbench-v2.html";

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
  operation: datasetOperationSchema.optional(),
  example: z.record(z.string(), jsonValueSchema).optional(),
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

const runDatasetConfig = {
  title: "Run dataset",
  description:
    "Execute a dataset candidate using the operation and example from find_datasets, or the exact schema from describe_dataset when discovery omits an operation. Paid operations require explicit acknowledgement and return a bounded preview plus a result resource.",
  inputSchema: {
    datasetId: z.string().trim().min(1).max(120),
    operation: datasetOperationSchema,
    arguments: z.record(z.string(), jsonValueSchema),
  },
  outputSchema: datasetResultSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  _meta: {
    ui: { resourceUri: DATASET_WORKBENCH_URI, visibility: ["model", "app"] },
    "ui/resourceUri": DATASET_WORKBENCH_URI,
    "openai/outputTemplate": DATASET_WORKBENCH_URI,
    "openai/toolInvocation/invoking": "Running dataset…",
    "openai/toolInvocation/invoked": "Dataset workbench ready",
  },
} as const;

type RunDatasetInput = {
  datasetId: string;
  operation: DatasetOperation;
  arguments: JsonObject;
};

type DatasetToolDependencies = {
  datasets: DatasetUseCases;
  results: ResultStore;
  tasks?: CancellableTaskStore;
  widgetHtml: string;
  principalId: string;
};

export function registerDatasetTools(
  server: McpServer,
  dependencies: DatasetToolDependencies,
) {
  server.registerTool(
    "find_datasets",
    {
      title: "Find datasets",
      description:
        "Search the caller's live Marketplace catalog, curated collectors, and deep research once. A candidate with operation and example can be passed directly to run_dataset; otherwise call describe_dataset for valid fields and the exact schema.",
      inputSchema: {
        query: z.string().trim().min(1).max(500),
        limit: z.number().int().min(1).max(10).default(5),
      },
      outputSchema: { datasets: z.array(summarySchema) },
      annotations,
    },
    async ({ query, limit }, extra) =>
      runTool(async () => {
        const context = requestContext(
          dependencies.principalId,
          extra.signal,
          extra.authInfo,
        );
        const structuredContent = {
          datasets: await dependencies.datasets.findDatasets(query, limit, context),
        };
        return reply(
          structuredContent,
          structuredContent.datasets.length
            ? `Dataset candidates:\n${JSON.stringify(structuredContent)}\nNext: run candidates that include an operation and example; describe only candidates that omit them.`
            : "No matching dataset capability was found. Try a broader task description.",
        );
      }),
  );

  server.registerTool(
    "describe_dataset",
    {
      title: "Describe dataset",
      description:
        "Get valid fields and the exact executable schema when find_datasets did not return a direct operation and example. Then call run_dataset once.",
      inputSchema: { datasetId: z.string().trim().min(1).max(120) },
      outputSchema: definitionSchema,
      annotations,
    },
    async ({ datasetId }, extra) =>
      runTool(async () => {
        const context = requestContext(
          dependencies.principalId,
          extra.signal,
          extra.authInfo,
        );
        const structuredContent =
          await dependencies.datasets.describeDataset(datasetId, context);
        return reply(
          structuredContent,
          `Dataset definition:\n${JSON.stringify(structuredContent)}\nNext: call run_dataset with this ID, one returned operation, and matching arguments.`,
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
    server.registerTool("run_dataset", runDatasetConfig, async (input, extra) => {
      const context = requestContext(
        dependencies.principalId,
        extra.signal,
        extra.authInfo,
      );
      return executeRunDataset(
        input,
        dependencies,
        context,
      );
    });
  }

  server.registerResource(
    "dataset-result",
    new ResourceTemplate("brightdata://results/{resultId}", { list: undefined }),
    { mimeType: "application/json", description: "Completed dataset result" },
    async (uri, { resultId }, extra) =>
      jsonResourceReply(
        uri,
        await dependencies.results.readResult(
          String(resultId),
          requestContext(
            dependencies.principalId,
            extra.signal,
            extra.authInfo,
          ),
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
        await dependencies.results.readPage(
          String(pageToken),
          requestContext(
            dependencies.principalId,
            extra.signal,
            extra.authInfo,
          ),
        ),
      ),
  );

  registerAppResource(
    server,
    "Dataset workbench",
    DATASET_WORKBENCH_URI,
    {
      mimeType: RESOURCE_MIME_TYPE,
      description: "Transient inspection and handoff surface for a canonical dataset result",
      _meta: {
        ui: {
          prefersBorder: true,
          csp: { connectDomains: [], resourceDomains: [] },
        },
        "openai/widgetDescription":
          "Inspects a dataset through a table, profiles, quality checks, row comparison, provenance, exports, and model handoff.",
      },
    },
    async () => ({
      contents: [
        {
          uri: DATASET_WORKBENCH_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: dependencies.widgetHtml,
          _meta: {
            ui: {
              prefersBorder: true,
              csp: { connectDomains: [], resourceDomains: [] },
            },
            "openai/widgetDescription":
              "Inspects a dataset through a table, profiles, quality checks, row comparison, provenance, exports, and model handoff.",
          },
        },
      ],
    }),
  );
}

function executeRunDataset(
  input: RunDatasetInput,
  dependencies: Pick<DatasetToolDependencies, "datasets" | "principalId">,
  context: RequestContext,
  onError?: (
    error: unknown,
  ) => CapabilityError | undefined | Promise<CapabilityError | undefined>,
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
          text: `Dataset snapshot:\n${JSON.stringify({
            dataset: structuredContent.dataset,
            rowCount:
              structuredContent.page.totalRows ?? structuredContent.rows.length,
            fields: structuredContent.columns.map(({ key }) => key),
            continuation: structuredContent.page.nextResourceUri ?? null,
          })}`,
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
  }, onError);
}

function taskTtl(requested: number | null | undefined) {
  if (requested === null || requested === undefined) return 15 * 60_000;
  return Math.min(Math.max(requested, 60_000), 15 * 60_000);
}
