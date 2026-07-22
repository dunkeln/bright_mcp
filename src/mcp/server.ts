import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatasetAdapter } from "../core/datasets";
import type { ResultStore } from "../core/results";
import type { WebAdapter, WebContentStore } from "../core/web";
import type { BrowserUseCases } from "../browser/use-cases";
import { registerBrowserTools } from "./browser-tools";
import {
  registerDatasetResources,
  registerDeepLookupTools,
  registerMarketplaceTools,
} from "./dataset-tools";
import type { CancellableTaskStore } from "./task-store";
import { registerWebTools } from "./web-tools";

export { DATASET_WORKBENCH_URI } from "./dataset-tools";

export type McpProfile = "all" | "web" | "deep-lookup" | "marketplace" | "browser";

export const MCP_PROFILE_PATHS: Readonly<Record<string, McpProfile>> = {
  "/mcp": "all",
  "/mcp/web": "web",
  "/mcp/deep-lookup": "deep-lookup",
  "/mcp/marketplace": "marketplace",
  "/mcp/browser": "browser",
};

const instructions: Record<McpProfile, string> = {
  all: "Choose tools by intent: search_web locates unknown pages; read_web retrieves exact known-page evidence; extract_web creates fields from known URLs; research_web investigates an objective; find_datasets discovers maintained structured capabilities; run_dataset executes one returned contract.",
  web: "Use search_web to locate unknown pages and read_web to retrieve exact known-page evidence. Do not read every search result unless the task requires page-level evidence.",
  "deep-lookup": "Use extract_web when source URLs are known and research_web when an open-ended objective requires sourced structured records. Preview before a caller-approved paid run.",
  marketplace: "Use find_datasets to discover an account-visible maintained capability, then call run_dataset once with the returned identifier, operation, schema, and cost acknowledgement.",
  browser: "Use browser_navigate to create or move a remote session, browser_observe to inspect it, browser_interact for one bounded action, and browser_close when finished.",
};

export function createBrightMcpServer(dependencies: {
  profile?: McpProfile;
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
  const profile = dependencies.profile ?? "all";
  if (profile === "browser" && !dependencies.browser) {
    throw new Error("The browser MCP profile requires a browser provider.");
  }
  const server = new McpServer(
    {
      name: "bright-mcp",
      version: "0.2.0",
      icons: [dependencies.icon],
    },
    {
      ...(dependencies.tasks && (profile === "all" || profile === "marketplace")
        ? {
            capabilities: {
              tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
            },
            taskStore: dependencies.tasks,
            defaultTaskPollInterval: 500,
          }
        : {}),
      instructions: instructions[profile],
    },
  );
  if (profile === "all" || profile === "web") {
    registerWebTools(
      server,
      dependencies.web,
      dependencies.webContent,
      dependencies.principalId,
    );
  }
  if (profile === "all" || profile === "deep-lookup") {
    registerDeepLookupTools(server, dependencies);
  }
  if (profile === "all" || profile === "marketplace") {
    registerMarketplaceTools(server, dependencies);
  }
  if (profile === "all" || profile === "deep-lookup" || profile === "marketplace") {
    registerDatasetResources(server, dependencies);
  }
  if (profile === "browser") {
    registerBrowserTools(server, dependencies.browser!, dependencies.principalId);
  }
  return server;
}
