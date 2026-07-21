import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createBrightDataDatasetAdapter } from "./adapters/brightdata/datasets";
import { BrightDataGateway } from "./adapters/brightdata/gateway";
import { createBrightDataWebAdapter } from "./adapters/brightdata/web";
import { createOidcAuthorization } from "./auth/oidc";
import { requiredScopesForRequest } from "./auth/scopes";
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
import {
  macOsKeychainCredential,
  staticCredential,
} from "./connections/credentials";
import { staticBrowserCredential } from "./connections/browser-credentials";
import { createDatasetUseCases } from "./core/datasets";
import { createWebUseCases } from "./core/web";
import { createBrightMcpServer } from "./mcp/server";
import { createSamplingExtractionProvider } from "./mcp/sampling-extraction";
import { CancellableTaskStore } from "./mcp/task-store";

const transportName = process.env.MCP_TRANSPORT ?? "http";
const authMode = process.env.MCP_AUTH_MODE?.trim() || "none";
if (!(authMode === "none" || authMode === "oidc")) {
  throw new Error('MCP_AUTH_MODE must be either "none" or "oidc".');
}
if (authMode === "oidc" && transportName !== "http") {
  throw new Error("OIDC authorization is only supported by the HTTP transport.");
}
const publicMcpUrl = authMode === "oidc"
  ? configuredUrl("MCP_PUBLIC_URL", process.env.MCP_PUBLIC_URL)
  : undefined;
if (publicMcpUrl && (publicMcpUrl.pathname !== "/mcp" || publicMcpUrl.search)) {
  throw new Error("MCP_PUBLIC_URL must identify the /mcp endpoint without a query.");
}
const httpAuthorization = authMode === "oidc"
  ? await createOidcAuthorization({
      issuer: configuredUrl("MCP_OIDC_ISSUER", process.env.MCP_OIDC_ISSUER),
      resource: publicMcpUrl!,
      maxTokenAgeSeconds: readMaxTokenAge(process.env.MCP_MAX_TOKEN_AGE_SECONDS),
    })
  : undefined;
const allowedOrigins = new Set(
  (process.env.MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const principalId = "local";
const resultStore = new LocalResultStore();
const taskStore = new CancellableTaskStore();
const credentialSource = process.env.BRIGHTDATA_CREDENTIAL_SOURCE?.trim() || "auto";
if (!(credentialSource === "auto" || credentialSource === "keychain")) {
  throw new Error(
    'BRIGHTDATA_CREDENTIAL_SOURCE must be either "auto" or "keychain".',
  );
}
const apiKey = process.env.BRIGHTDATA_API_KEY?.trim();
if (credentialSource === "keychain" && apiKey) {
  throw new Error(
    "Choose either BRIGHTDATA_API_KEY or BRIGHTDATA_CREDENTIAL_SOURCE=keychain, not both.",
  );
}
if (credentialSource === "keychain" && process.platform !== "darwin") {
  throw new Error("The built-in keychain credential source currently supports macOS only.");
}
if (httpAuthorization && (apiKey || credentialSource === "keychain")) {
  throw new Error(
    "Hosted OIDC mode cannot use deployment-global Bright Data credentials; configure a principal-bound credential vault.",
  );
}
const credentials = apiKey
  ? staticCredential(apiKey)
  : credentialSource === "keychain"
    ? macOsKeychainCredential()
    : undefined;
const gateway = credentials
  ? new BrightDataGateway({
        credentials,
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
    createWeb: (server) =>
      createWebUseCases({
        ...webAdapter,
        extraction: createSamplingExtractionProvider(server),
      }),
    browser,
    results: resultStore,
    tasks: httpAuthorization ? undefined : taskStore,
    widgetHtml,
    principalId,
  });

function createBrowser(profile: "demo" | "brightdata") {
  if (httpAuthorization && profile === "brightdata") {
    throw new Error(
      "Hosted OIDC mode cannot use deployment-global Browser API credentials.",
    );
  }
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
      const rejectedEdgeRequest = validateHostedEdge(
        request,
        publicMcpUrl,
        allowedOrigins,
      );
      if (rejectedEdgeRequest) return rejectedEdgeRequest;
      if (
        httpAuthorization &&
        request.method === "GET" &&
        url.pathname === httpAuthorization.metadataPath
      ) {
        return withCors(
          Response.json(httpAuthorization.protectedResourceMetadata, {
            headers: { "cache-control": "public, max-age=300" },
          }),
          request,
          httpAuthorization !== undefined,
          allowedOrigins,
        );
      }
      if (request.method === "GET" && url.pathname === "/") {
        return new Response("Bright MCP", { status: 200 });
      }
      if (request.method === "GET" && url.pathname === "/widget") {
        return new Response(widgetHtml, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (request.method === "OPTIONS" && url.pathname === "/mcp") {
        return withCors(
          new Response(null, { status: 204 }),
          request,
          httpAuthorization !== undefined,
          allowedOrigins,
        );
      }
      if (url.pathname !== "/mcp") {
        return new Response("Not found", { status: 404 });
      }

      let authInfo: AuthInfo | undefined;
      if (httpAuthorization) {
        const authenticated = await httpAuthorization.authenticate(request);
        if (authenticated instanceof Response) {
          return withCors(authenticated, request, true, allowedOrigins);
        }
        authInfo = authenticated;
      }

      let parsedBody: unknown;
      if (request.method === "POST") {
        try {
          parsedBody = await readBoundedJson(request, 1_000_000);
        } catch {
          return withCors(
            Response.json(
              { error: "invalid_request", error_description: "The MCP request body is invalid or too large." },
              { status: 400 },
            ),
            request,
            httpAuthorization !== undefined,
            allowedOrigins,
          );
        }
      }
      if (httpAuthorization && authInfo) {
        const insufficient = httpAuthorization.requireScopes(
          authInfo,
          requiredScopesForRequest(parsedBody),
        );
        if (insufficient) {
          return withCors(insufficient, request, true, allowedOrigins);
        }
      }

      const server = createServer();
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      const response = await transport.handleRequest(request, {
        authInfo,
        parsedBody,
      });
      return withCors(
        response,
        request,
        httpAuthorization !== undefined,
        allowedOrigins,
      );
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

function configuredUrl(name: string, value: string | undefined) {
  if (!value) throw new Error(`${name} is required.`);
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
}

function readMaxTokenAge(value: string | undefined) {
  const seconds = Number(value ?? 3_600);
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 3_600) {
    throw new Error("MCP_MAX_TOKEN_AGE_SECONDS must be between 60 and 3600.");
  }
  return seconds;
}

function validateHostedEdge(
  request: Request,
  publicUrl: URL | undefined,
  origins: Set<string>,
) {
  if (!publicUrl) return undefined;
  if (request.headers.get("host") !== publicUrl.host) {
    return new Response("Misdirected request", { status: 421 });
  }
  const origin = request.headers.get("origin");
  if (origin && !origins.has(origin)) {
    return new Response("Origin not allowed", { status: 403 });
  }
  return undefined;
}

function withCors(
  response: Response,
  request: Request,
  protectedMode: boolean,
  origins: Set<string>,
) {
  const headers = new Headers(response.headers);
  const origin = request.headers.get("origin");
  if (!protectedMode) {
    headers.set("access-control-allow-origin", "*");
  } else if (origin && origins.has(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "origin");
  }
  headers.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  headers.set(
    "access-control-allow-headers",
    "authorization, content-type, mcp-protocol-version, mcp-session-id",
  );
  headers.set("access-control-expose-headers", "mcp-session-id, www-authenticate");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function readBoundedJson(request: Request, maxBytes: number) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("Request body too large.");
  }
  if (!request.body) throw new Error("Request body is required.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error("Request body too large.");
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text) as unknown;
}
