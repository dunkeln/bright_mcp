import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createBrightDataDatasetAdapter } from "./adapters/brightdata/datasets";
import { BrightDataGateway } from "./adapters/brightdata/gateway";
import { createBrightDataWebAdapter } from "./adapters/brightdata/web";
import { createDemoDatasetAdapter } from "./adapters/demo-datasets";
import { createDemoWebAdapter } from "./adapters/demo-web";
import { createFakeBrowserProvider } from "./browser/fake-provider";
import { createBrightDataBrowserProvider } from "./browser/brightdata-provider";
import {
  LocalBrowserArtifactStore,
  LocalBrowserSessionStore,
} from "./browser/stores";
import { createBrowserUseCases } from "./browser/use-cases";
import { LocalResultStore } from "./adapters/result-store";
import { staticCredential } from "./connections/credentials";
import { staticBrowserCredential } from "./connections/browser-credentials";
import { createDatasetUseCases } from "./core/datasets";
import { createWebUseCases } from "./core/web";
import { createBrightMcpServer } from "./mcp/server";
import { CancellableTaskStore } from "./mcp/task-store";

const transportName = process.env.MCP_TRANSPORT ?? "http";
const principalId = "local";
const resultStore = new LocalResultStore();
const taskStore = new CancellableTaskStore();
const apiKey = process.env.BRIGHTDATA_API_KEY?.trim();
const gateway = apiKey
  ? new BrightDataGateway({
        credentials: staticCredential(apiKey),
        logger: {
          info: (record) => console.error(JSON.stringify(record)),
          error: (record) => console.error(JSON.stringify(record)),
        },
      })
  : undefined;
const datasetAdapter = gateway
  ? createBrightDataDatasetAdapter(gateway, resultStore)
  : createDemoDatasetAdapter(resultStore);
const webAdapter = gateway
  ? createBrightDataWebAdapter(gateway, {
      serp: process.env.BRIGHTDATA_SERP_ZONE?.trim() || undefined,
      unlocker: process.env.BRIGHTDATA_UNLOCKER_ZONE?.trim() || undefined,
    })
  : createDemoWebAdapter();
const datasets = createDatasetUseCases(datasetAdapter);
const web = createWebUseCases(webAdapter);
const browserProfile = process.env.MCP_BROWSER_PROFILE?.trim() || "disabled";
if (
  browserProfile !== "disabled" &&
  browserProfile !== "demo" &&
  browserProfile !== "brightdata"
) {
  throw new Error(
    'MCP_BROWSER_PROFILE must be "disabled", "demo", or "brightdata".',
  );
}
const browser = browserProfile === "disabled"
  ? undefined
  : createBrowser(browserProfile);
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await browser?.shutdown();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
const widgetFile = Bun.file(
  new URL("../dist/dataset-table.html", import.meta.url),
);

if (!(await widgetFile.exists())) {
  throw new Error('Dataset table bundle is missing. Run "bun run build" first.');
}

const widgetHtml = await widgetFile.text();
const createServer = () =>
  createBrightMcpServer({
    datasets,
    web,
    browser,
    results: resultStore,
    tasks: taskStore,
    widgetHtml,
    principalId,
  });

function createBrowser(profile: "demo" | "brightdata") {
  const provider = profile === "demo"
    ? createFakeBrowserProvider()
    : brightDataBrowserProvider();
  return createBrowserUseCases({
    provider,
    sessions: new LocalBrowserSessionStore(provider),
    artifacts: new LocalBrowserArtifactStore(),
  });
}

function brightDataBrowserProvider() {
  const username = process.env.BRIGHTDATA_BROWSER_USERNAME?.trim();
  const password = process.env.BRIGHTDATA_BROWSER_PASSWORD;
  if (!username || !password) {
    throw new Error(
      "The brightdata browser profile requires BRIGHTDATA_BROWSER_USERNAME and BRIGHTDATA_BROWSER_PASSWORD.",
    );
  }
  return createBrightDataBrowserProvider(
    staticBrowserCredential(username, password),
  );
}

if (transportName === "stdio") {
  const server = createServer();
  await server.connect(new StdioServerTransport());
} else if (transportName === "http") {
  const port = readPort(process.env.PORT);
  Bun.serve({
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/") {
        return new Response("Bright MCP", { status: 200 });
      }
      if (request.method === "GET" && url.pathname === "/widget") {
        return new Response(widgetHtml, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (request.method === "OPTIONS" && url.pathname === "/mcp") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(),
        });
      }
      if (url.pathname !== "/mcp") {
        return new Response("Not found", { status: 404 });
      }

      const server = createServer();
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      const response = await transport.handleRequest(request);
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(corsHeaders())) {
        headers.set(key, value);
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  });
  console.error(`Bright MCP listening on http://localhost:${port}/mcp`);
} else {
  throw new Error('MCP_TRANSPORT must be either "http" or "stdio".');
}

function readPort(value: string | undefined): number {
  const port = Number(value ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return port;
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, mcp-protocol-version, mcp-session-id",
    "access-control-expose-headers": "mcp-session-id",
  };
}
