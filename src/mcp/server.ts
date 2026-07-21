import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatasetAdapter } from "../core/datasets";
import type { ResultStore } from "../core/results";
import type { WebAdapter } from "../core/web";
import type { BrowserUseCases } from "../browser/use-cases";
import { registerBrowserTools } from "./browser-tools";
import { registerDatasetTools } from "./dataset-tools";
import type { CancellableTaskStore } from "./task-store";
import { registerWebTools } from "./web-tools";

export { DATASET_WORKBENCH_URI } from "./dataset-tools";

export function createBrightMcpServer(dependencies: {
  datasets: DatasetAdapter;
  web: WebAdapter;
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
        "Batch related web queries in one search_web call, then scrape only selected pages and read their Markdown to answer or extract fields. For maintained structured data, call find_datasets once, run direct candidates immediately, and use describe_dataset only when discovery omits an operation and example.",
    },
  );
  registerWebTools(server, dependencies.web, dependencies.principalId);
  registerDatasetTools(server, dependencies);
  if (dependencies.browser) {
    registerBrowserTools(server, dependencies.browser, dependencies.principalId);
  }
  return server;
}
