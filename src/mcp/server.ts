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
  all: "Choose by source certainty and output: unknown sources plus compact links or snippets -> search_web; known URLs plus readable evidence -> read_web; known URLs plus named fields -> extract_web; unknown sources plus sourced structured records -> research_web; maintained vertical data -> find_datasets then run_dataset. Do not substitute a search_web -> read_web chain when research_web matches the requested outcome.",
  web: "Use search_web for compact discovery when sources are unknown. Use read_web for readable evidence when URLs are known. Do not read every search result unless page-level evidence is required.",
  "deep-lookup": "Use extract_web for named fields when source URLs are known. Use research_web for sourced structured records when sources are unknown. Preview before a caller-approved paid run.",
  marketplace: "Use find_datasets only for maintained vertical data, then call run_dataset once with the returned identifier, operation, argument schema, and cost acknowledgement.",
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
