import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatasetAdapter } from "../core/datasets";
import type { ResultStore } from "../core/results";
import type { WebAdapter, WebContentStore } from "../core/web";
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
  webContent: WebContentStore;
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
      version: "0.2.0",
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
        "Choose tools by intent: search_web locates unknown pages; read_web retrieves exact known-page evidence; extract_web creates fields from known URLs; research_web investigates an objective; find_datasets discovers maintained structured capabilities; run_dataset executes one returned contract.",
    },
  );
  registerWebTools(
    server,
    dependencies.web,
    dependencies.webContent,
    dependencies.principalId,
  );
  registerDatasetTools(server, dependencies);
  if (dependencies.browser) {
    registerBrowserTools(server, dependencies.browser, dependencies.principalId);
  }
  return server;
}
