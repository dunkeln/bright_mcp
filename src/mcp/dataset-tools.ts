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
  type RequestContext,
} from "../core/contracts";
import { isPublicHttpUrl } from "../core/public-url";
import {
  deepLookupInputSchema,
  datasetRunArgumentsSchema,
  datasetRunInputSchema,
} from "../core/dataset-inputs";
import type { DatasetAdapter } from "../core/datasets";
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

const extractionInputSchema = z.object({
  urls: z.array(
    z.url().max(500).refine(isPublicHttpUrl, "URL must be a public HTTP(S) URL."),
  ).min(1).max(5),
  fields: z.array(z.object({
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/),
    description: z.string().trim().min(1).max(300),
  }).strict()).min(1).max(20),
  preview: z.boolean().default(true),
  acknowledgeCost: z.literal(true).optional(),
  maxCostUsd: z.number().positive().max(10_000).optional(),
}).strict().superRefine((input, context) => {
  if (!input.preview && (input.acknowledgeCost !== true || input.maxCostUsd === undefined)) {
    context.addIssue({
      code: "custom",
      message: "Full extraction requires acknowledgeCost=true and maxCostUsd.",
    });
  }
  if (extractionQuery(input).length > 2_000) {
    context.addIssue({
      code: "custom",
      message: "The combined URLs and field descriptions exceed the extraction objective limit.",
    });
  }
});

const appMeta = {
  ui: { resourceUri: DATASET_WORKBENCH_URI, visibility: ["model", "app"] },
  "ui/resourceUri": DATASET_WORKBENCH_URI,
  "openai/outputTemplate": DATASET_WORKBENCH_URI,
  "openai/toolInvocation/invoking": "Running dataset…",
  "openai/toolInvocation/invoked": "Dataset workbench ready",
} as const;

const runDatasetConfig = {
  title: "Run dataset",
  description:
    "Execute one maintained structured-data capability returned by find_datasets. Preserve its dataset identifier and operation exactly, and construct arguments from the returned schema and example. Use for purpose-built URL or keyword collectors and filtered Marketplace records—not for page reading, ad hoc fields, or open-ended research. Paid operations require explicit acknowledgement. A successful call returns a bounded preview and a resource for additional rows; consume that resource instead of repeating the run.",
  inputSchema: {
    datasetId: z.string().trim().min(1).max(120),
    operation: datasetOperationSchema,
    arguments: datasetRunArgumentsSchema,
  },
  outputSchema: datasetResultSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  _meta: appMeta,
} as const;

type DatasetToolDependencies = {
  datasets: DatasetAdapter;
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
    "extract_web",
    {
      title: "Extract web fields",
      description:
        "Extract an ad hoc structured record from each known public URL. Supply the exact field names and meanings required in the result. Use this when the source URLs are already known and the desired schema is temporary; use read_web for exact page evidence, research_web when sources are not known, and run_dataset for a maintained extractor. Preview is the default. Full extraction is caller-funded and requires acknowledgeCost=true plus maxCostUsd.",
      inputSchema: extractionInputSchema,
      outputSchema: datasetResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: appMeta,
    },
    async (input, extra) => {
      return executeDeepLookup({
        query: extractionQuery(input),
        limit: input.urls.length,
        preview: input.preview,
        acknowledgeCost: input.acknowledgeCost,
        maxCostUsd: input.maxCostUsd,
      }, dependencies, requestContext(
        dependencies.principalId,
        extra.signal,
        extra.authInfo,
      ));
    },
  );

  server.registerTool(
    "research_web",
    {
      title: "Research web",
      description:
        "Turn an open-ended objective into a sourced structured table when the relevant pages are not known in advance. Use for multi-source comparison, entity discovery, or broad web research that should return records. Use search_web for compact source discovery, read_web for exact known-page evidence, and extract_web when URLs and fields are already known. Preview is the default. Full research is caller-funded and requires acknowledgeCost=true plus maxCostUsd.",
      inputSchema: deepLookupInputSchema,
      outputSchema: datasetResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: appMeta,
    },
    async (input, extra) => executeDeepLookup(
      input,
      dependencies,
      requestContext(dependencies.principalId, extra.signal, extra.authInfo),
    ),
  );

  server.registerTool(
    "find_datasets",
    {
      title: "Find datasets",
      description:
        "Discover maintained structured-data capabilities for records, entities, products, organizations, profiles, or listings. Search by the desired data and constraints—not a guessed ID. Every candidate includes its executable operations, exact input schemas, limits, and examples; choose one and call run_dataset directly. Do not use for ordinary pages, ad hoc extraction, open-ended research, schedules, subscriptions, recurring deliveries, approvals, or exports.",
      inputSchema: {
        query: z.string().trim().min(1).max(500),
        limit: z.number().int().min(1).max(5).default(3),
      },
      outputSchema: { datasets: z.array(definitionSchema) },
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
          datasets: await dependencies.datasets.catalog.find(query, limit, context),
        };
        return reply(
          structuredContent,
          structuredContent.datasets.length
            ? `Found ${structuredContent.datasets.length} executable dataset candidate${structuredContent.datasets.length === 1 ? "" : "s"}. Choose one returned operation and call run_dataset with arguments matching its schema.`
            : "No matching dataset capability was found. Try a broader task description.",
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
          input: unknown,
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
          _input: unknown,
          extra: TaskRequestHandlerExtra,
        ) {
          return extra.taskStore.getTask(extra.taskId);
        },
        async getTaskResult(
          _input: unknown,
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
          "Inspects a dataset through a table, profiles, quality checks, provenance, and exports.",
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
              "Inspects a dataset through a table, profiles, quality checks, provenance, and exports.",
          },
        },
      ],
    }),
  );
}

function executeRunDataset(
  input: unknown,
  dependencies: Pick<DatasetToolDependencies, "datasets" | "principalId">,
  context: RequestContext,
  onError?: (
    error: unknown,
  ) => CapabilityError | undefined | Promise<CapabilityError | undefined>,
): Promise<CallToolResult> {
  return runTool(async () => {
    const parsedInput = datasetRunInputSchema.safeParse(input);
    if (!parsedInput.success) {
      const issue = parsedInput.error.issues[0];
      throw new CapabilityError(
        "invalid_dataset_arguments",
        `Invalid run_dataset input${issue?.path.length ? ` at ${issue.path.join(".")}` : ""}: ${issue?.message ?? "unsupported argument shape"}.`,
        false,
        "Use the operation and matching typed argument shape returned by find_datasets.",
      );
    }
    const structuredContent = await dependencies.datasets.runner.run(
      parsedInput.data,
      context,
    );
    return datasetReply(structuredContent);
  }, onError);
}

function executeDeepLookup(
  input: z.infer<typeof deepLookupInputSchema>,
  dependencies: Pick<DatasetToolDependencies, "datasets">,
  context: RequestContext,
) {
  return runTool(async () => datasetReply(await dependencies.datasets.runner.run({
    datasetId: "deep-web-research",
    operation: "search",
    arguments: input,
  }, context)));
}

function extractionQuery(input: {
  urls: string[];
  fields: Array<{ name: string; description: string }>;
}) {
  const fields = input.fields
    .map(({ name, description }) => `${name}: ${description}`)
    .join("\n");
  return `Extract exactly one record per source URL. Use only these source URLs and include sourceUrl in every record.\nFields:\n${fields}\nSource URLs:\n${input.urls.join("\n")}`;
}

function datasetReply(structuredContent: z.infer<typeof datasetResultSchema>) {
  return {
    structuredContent,
    content: [
      {
        type: "text" as const,
        text: `Dataset snapshot:\n${JSON.stringify({
          dataset: structuredContent.dataset,
          rowCount: structuredContent.page.totalRows ?? structuredContent.rows.length,
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
}

function taskTtl(requested: number | null | undefined) {
  if (requested === null || requested === undefined) return 15 * 60_000;
  return Math.min(Math.max(requested, 60_000), 15 * 60_000);
}
