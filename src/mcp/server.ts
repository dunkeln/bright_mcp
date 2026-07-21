import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
  icon: {
    src: string;
    mimeType: "image/png";
    sizes: string[];
  };
}) {
  const server = new McpServer(
    {
      name: "bright-mcp",
      version: "0.1.0",
      icons: [dependencies.icon],
    },
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
        "Use search_web once to find current URLs, then scrape the relevant pages. For managed datasets, call find_datasets once, then describe_dataset with the returned ID, then run_dataset with that operation schema.",
    },
  );
  registerWebTools(
    server,
    dependencies.createWeb(server),
    dependencies.principalId,
  );
  registerDatasetTools(server, dependencies);
  if (dependencies.browser) {
    registerBrowserTools(server, dependencies.browser, dependencies.principalId);
  }
  return server;
}
