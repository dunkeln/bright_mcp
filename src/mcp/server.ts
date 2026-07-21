import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CapabilityError,
  datasetOperationSchema,
  datasetResultSchema,
  jsonValueSchema,
  type RequestContext,
} from "../core/contracts";
import type { DatasetUseCases } from "../core/datasets";
import type { ResultStore } from "../core/results";

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

export function createBrightMcpServer(dependencies: {
  datasets: DatasetUseCases;
  results: ResultStore;
  widgetHtml: string;
  principalId: string;
}) {
  const server = new McpServer(
    { name: "bright-mcp", version: "0.1.0" },
    {
      instructions:
        "Use find_datasets, then describe_dataset, then run_dataset. Only pass a dataset ID returned by discovery and arguments matching the described operation schema.",
    },
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

  registerAppTool(
    server,
    "run_dataset",
    {
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
        openWorldHint: false,
      },
      _meta: {
        ui: { resourceUri: DATASET_TABLE_URI, visibility: ["model", "app"] },
        "openai/outputTemplate": DATASET_TABLE_URI,
        "openai/toolInvocation/invoking": "Running dataset…",
        "openai/toolInvocation/invoked": "Dataset ready",
      },
    },
    async ({ datasetId, operation, arguments: args }, extra) =>
      runTool(async () => {
        const context = requestContext(dependencies.principalId, extra.signal);
        const structuredContent = await dependencies.datasets.runDataset(
          { datasetId, operation, arguments: args },
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
      }),
  );

  server.registerResource(
    "dataset-definition",
    new ResourceTemplate("brightdata://datasets/{datasetId}", { list: undefined }),
    { mimeType: "application/json", description: "Dataset capability definition" },
    async (uri, { datasetId }) =>
      resourceReply(
        uri,
        await dependencies.datasets.describeDataset(String(datasetId)),
      ),
  );

  server.registerResource(
    "dataset-result",
    new ResourceTemplate("brightdata://results/{resultId}", { list: undefined }),
    { mimeType: "application/json", description: "Completed dataset result" },
    async (uri, { resultId }) =>
      resourceReply(
        uri,
        dependencies.results.readResult(
          String(resultId),
          dependencies.principalId,
        ),
      ),
  );

  server.registerResource(
    "dataset-result-page",
    new ResourceTemplate("brightdata://pages/{pageToken}", { list: undefined }),
    { mimeType: "application/json", description: "Dataset result continuation page" },
    async (uri, { pageToken }) =>
      resourceReply(
        uri,
        dependencies.results.readPage(
          String(pageToken),
          dependencies.principalId,
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

  return server;
}

function requestContext(
  principalId: string,
  signal?: AbortSignal,
): RequestContext {
  return { principalId, requestId: crypto.randomUUID(), signal };
}

function reply<T extends Record<string, unknown>>(structuredContent: T, text: string) {
  return {
    structuredContent,
    content: [{ type: "text" as const, text }],
  };
}

async function runTool<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    const failure =
      error instanceof CapabilityError
        ? error
        : new CapabilityError(
            "internal_error",
            "The capability failed unexpectedly.",
            true,
            "Retry once. If it fails again, inspect the server logs with the request ID.",
          );
    return {
      isError: true as const,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            code: failure.code,
            message: failure.message,
            retryable: failure.retryable,
            nextAction: failure.nextAction,
          }),
        },
      ],
    };
  }
}

function resourceReply(uri: URL, value: unknown) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(value),
      },
    ],
  };
}
