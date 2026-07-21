import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { UrlElicitationRequiredError } from "@modelcontextprotocol/sdk/types.js";
import {
  CapabilityError,
  type RequestContext,
} from "../core/contracts";
import type { DatasetUseCases } from "../core/datasets";
import type { ResultStore } from "../core/results";
import type { WebUseCases } from "../core/web";
import type { BrowserUseCases } from "../browser/use-cases";
import { registerBrowserTools } from "./browser-tools";
import { registerDatasetTools } from "./dataset-tools";
import type { CancellableTaskStore } from "./task-store";
import { registerWebTools } from "./web-tools";

export { DATASET_TABLE_URI } from "./dataset-tools";

export function createBrightMcpServer(dependencies: {
  datasets: DatasetUseCases;
  createWeb: (server: McpServer) => WebUseCases;
  browser?: BrowserUseCases;
  results: ResultStore;
  tasks?: CancellableTaskStore;
  widgetHtml: string;
  principalId: string;
  connection?: {
    manualUrl: string;
    createElicitation(
      principalId: string,
      completion: (elicitationId: string) => () => Promise<void>,
    ): Promise<{
      elicitationId: string;
      url: string;
    }>;
  };
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
  const connectionError = (context: RequestContext) => async (error: unknown) => {
    if (
      !(error instanceof CapabilityError) ||
      error.code !== "brightdata_connection_required" ||
      !dependencies.connection
    ) {
      return;
    }
    if (server.server.getClientCapabilities()?.elicitation?.url) {
      const elicitation = await dependencies.connection.createElicitation(
        context.principalId,
        (elicitationId) =>
          server.server.createElicitationCompletionNotifier(elicitationId),
      );
      throw new UrlElicitationRequiredError([
        {
          mode: "url",
          message:
            "Connect Bright Data in the secure server page, then retry this request.",
          ...elicitation,
        },
      ]);
    }
    return new CapabilityError(
      "brightdata_connection_required",
      "Bright Data is not connected for this account.",
      false,
      `Open ${dependencies.connection.manualUrl}, connect Bright Data, then retry.`,
    );
  };

  registerWebTools(
    server,
    dependencies.createWeb(server),
    dependencies.principalId,
    connectionError,
  );
  registerDatasetTools(server, dependencies, connectionError);
  if (dependencies.browser) {
    registerBrowserTools(server, dependencies.browser, dependencies.principalId);
  }
  return server;
}
