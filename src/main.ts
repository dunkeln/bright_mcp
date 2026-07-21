import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBrightDataDatasetAdapter } from "./adapters/brightdata/datasets";
import { BrightDataGateway } from "./adapters/brightdata/gateway";
import { createBrightDataWebAdapter } from "./adapters/brightdata/web";
import { createDemoDatasetAdapter } from "./adapters/demo-datasets";
import { createDemoWebAdapter } from "./adapters/demo-web";
import { createFakeBrowserProvider } from "./browser/fake-provider";
import { createBrightDataBrowserProvider } from "./browser/brightdata-provider";
import type { BrowserProvider } from "./browser/contracts";
import {
  LocalBrowserArtifactStore,
  LocalBrowserSessionStore,
} from "./browser/stores";
import { createBrowserUseCases } from "./browser/use-cases";
import type { BrowserUseCases } from "./browser/use-cases";
import { LocalResultStore } from "./adapters/result-store";
import {
  createBearerCredentialProvider,
  macOsKeychainCredential,
  staticCredential,
} from "./connections/credentials";
import { staticBrowserCredential } from "./connections/browser-credentials";
import { createWebUseCases } from "./core/web";
import { createBrightMcpServer } from "./mcp/server";
import { startHttpServer } from "./mcp/http-server";
import { createSamplingExtractionProvider } from "./mcp/sampling-extraction";
import { CancellableTaskStore } from "./mcp/task-store";

const transportName = process.env.MCP_TRANSPORT ?? "http";
if (!(transportName === "http" || transportName === "stdio")) {
  throw new Error('MCP_TRANSPORT must be either "http" or "stdio".');
}
const testFixtures = process.env.BRIGHT_MCP_TEST_FIXTURES === "1";
if (testFixtures && process.env.NODE_ENV !== "test") {
  throw new Error("Bright MCP test fixtures require NODE_ENV=test.");
}
const hosted = transportName === "http" && !testFixtures;
const publicMcpUrl = hosted
  ? configuredUrl("MCP_PUBLIC_URL", process.env.MCP_PUBLIC_URL)
  : undefined;
if (publicMcpUrl && (publicMcpUrl.pathname !== "/mcp" || publicMcpUrl.search)) {
  throw new Error("MCP_PUBLIC_URL must identify the /mcp endpoint without a query.");
}
if (hosted && publicMcpUrl?.protocol !== "https:") {
  throw new Error("Hosted HTTP requires an HTTPS MCP_PUBLIC_URL.");
}
const bearerCredentials = hosted
  ? createBearerCredentialProvider()
  : undefined;
const allowedOrigins = new Set(
  (process.env.MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
if (publicMcpUrl) allowedOrigins.add(publicMcpUrl.origin);
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
if (hosted && (apiKey || credentialSource === "keychain")) {
  throw new Error(
    "Hosted HTTP accepts each caller's Bright Data key and cannot use deployment-global credentials.",
  );
}
if (
  hosted &&
  (process.env.BRIGHTDATA_SERP_ZONE || process.env.BRIGHTDATA_UNLOCKER_ZONE)
) {
  throw new Error(
    "Hosted HTTP discovers zones per caller and cannot use deployment-global zone names.",
  );
}
const localCredentials = apiKey
  ? staticCredential(apiKey)
  : credentialSource === "keychain"
    ? macOsKeychainCredential()
    : undefined;
if (!testFixtures && !bearerCredentials && !localCredentials) {
  throw new Error(
    "Stdio requires BRIGHTDATA_API_KEY or BRIGHTDATA_CREDENTIAL_SOURCE=keychain.",
  );
}
const credentials = bearerCredentials?.credentials ?? localCredentials;
const gateway = credentials
  ? new BrightDataGateway({
        credentials,
        logger: {
          info: (record) => console.error(JSON.stringify(record)),
          error: (record) => console.error(JSON.stringify(record)),
        },
      })
  : undefined;
const datasetAdapter = testFixtures
  ? createDemoDatasetAdapter(resultStore)
  : createBrightDataDatasetAdapter(gateway!, resultStore);
const webAdapter = testFixtures
  ? createDemoWebAdapter()
  : createBrightDataWebAdapter(gateway!, {
      serp: process.env.BRIGHTDATA_SERP_ZONE?.trim() || undefined,
      unlocker: process.env.BRIGHTDATA_UNLOCKER_ZONE?.trim() || undefined,
    });
const browserProfile = process.env.MCP_BROWSER_PROFILE?.trim() || "disabled";
if (
  browserProfile !== "disabled" &&
  browserProfile !== "fixture" &&
  browserProfile !== "brightdata"
) {
  throw new Error(
    'MCP_BROWSER_PROFILE must be "disabled", "fixture", or "brightdata".',
  );
}
if (browserProfile === "fixture" && !testFixtures) {
  throw new Error("The fixture browser profile is test-only.");
}
const browserProvider = browserProfile === "disabled"
  ? undefined
  : createBrowserProvider(browserProfile);
const widgetFile = Bun.file(
  new URL("../dist/dataset-table.html", import.meta.url),
);
const iconFile = Bun.file(new URL("../assets/icon.png", import.meta.url));

if (!(await widgetFile.exists())) {
  throw new Error('Dataset table bundle is missing. Run "bun run build" first.');
}
if (!(await iconFile.exists())) {
  throw new Error("Bright MCP icon is missing at assets/icon.png.");
}

const widgetHtml = await widgetFile.text();
const icon = {
  src: `data:image/png;base64,${Buffer.from(await iconFile.arrayBuffer()).toString("base64")}`,
  mimeType: "image/png" as const,
  sizes: ["1254x1254"],
};
const activeBrowsers = new Set<BrowserUseCases>();
const createServer = (requestPrincipal = principalId) => {
  const browser = browserProvider ? createBrowser(browserProvider) : undefined;
  const server = createBrightMcpServer({
    datasets: datasetAdapter,
    createWeb: (server) =>
      createWebUseCases({
        ...webAdapter,
        extraction: createSamplingExtractionProvider(server),
      }),
    browser,
    results: resultStore,
    tasks: taskStore,
    widgetHtml,
    principalId: requestPrincipal,
    icon,
  });
  if (browser) {
    activeBrowsers.add(browser);
    const onclose = server.server.onclose;
    server.server.onclose = () => {
      onclose?.();
      if (activeBrowsers.delete(browser)) void browser.shutdown();
    };
  }
  return server;
};

let closeTransport: () => void = () => undefined;
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const browsers = [...activeBrowsers];
  activeBrowsers.clear();
  await Promise.allSettled(browsers.map((browser) => browser.shutdown()));
  closeTransport();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function createBrowserProvider(
  profile: "fixture" | "brightdata",
): BrowserProvider {
  if (hosted && profile === "brightdata") {
    throw new Error(
      "Hosted HTTP cannot use deployment-global Browser API credentials.",
    );
  }
  return profile === "fixture"
    ? createFakeBrowserProvider()
    : brightDataBrowserProvider();
}

function createBrowser(provider: BrowserProvider) {
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
  const httpServer = startHttpServer({
    port,
    publicUrl: publicMcpUrl,
    allowedOrigins,
    bearerCredentials,
    widgetHtml,
    localPrincipalId: principalId,
    createServer,
  });
  closeTransport = httpServer.close;
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
