import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBrightDataDatasetAdapter } from "./adapters/brightdata/datasets";
import { BrightDataGateway } from "./adapters/brightdata/gateway";
import { createBrightDataWebAdapter } from "./adapters/brightdata/web";
import { createOidcAuthorization } from "./auth/oidc";
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
import { createEncryptedCredentialVault } from "./connections/encrypted-vault";
import { createHostedConnectionService } from "./connections/hosted-connection";
import { createDatasetUseCases } from "./core/datasets";
import { createWebUseCases } from "./core/web";
import { createBrightMcpServer } from "./mcp/server";
import { startHttpServer } from "./mcp/http-server";
import { createSamplingExtractionProvider } from "./mcp/sampling-extraction";
import { CancellableTaskStore } from "./mcp/task-store";

const transportName = process.env.MCP_TRANSPORT ?? "http";
const authMode = process.env.MCP_AUTH_MODE?.trim() || "none";
if (!(authMode === "none" || authMode === "byok" || authMode === "oidc")) {
  throw new Error('MCP_AUTH_MODE must be "none", "byok", or "oidc".');
}
if (authMode !== "none" && transportName !== "http") {
  throw new Error("Remote authorization is only supported by the HTTP transport.");
}
const publicMcpUrl = authMode !== "none"
  ? configuredUrl("MCP_PUBLIC_URL", process.env.MCP_PUBLIC_URL)
  : undefined;
if (publicMcpUrl && (publicMcpUrl.pathname !== "/mcp" || publicMcpUrl.search)) {
  throw new Error("MCP_PUBLIC_URL must identify the /mcp endpoint without a query.");
}
if (authMode === "byok" && publicMcpUrl?.protocol !== "https:") {
  throw new Error("BYOK mode requires an HTTPS MCP_PUBLIC_URL.");
}
const httpAuthorization = authMode === "oidc"
  ? await createOidcAuthorization({
      issuer: configuredUrl("MCP_OIDC_ISSUER", process.env.MCP_OIDC_ISSUER),
      resource: publicMcpUrl!,
      maxTokenAgeSeconds: readMaxTokenAge(process.env.MCP_MAX_TOKEN_AGE_SECONDS),
    })
  : undefined;
const bearerCredentials = authMode === "byok"
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
const dataProfile = process.env.BRIGHTDATA_PROFILE?.trim() || "auto";
if (!(dataProfile === "auto" || dataProfile === "demo" || dataProfile === "live")) {
  throw new Error('BRIGHTDATA_PROFILE must be "auto", "demo", or "live".');
}
if (credentialSource === "keychain" && apiKey) {
  throw new Error(
    "Choose either BRIGHTDATA_API_KEY or BRIGHTDATA_CREDENTIAL_SOURCE=keychain, not both.",
  );
}
if (credentialSource === "keychain" && process.platform !== "darwin") {
  throw new Error("The built-in keychain credential source currently supports macOS only.");
}
if ((httpAuthorization || bearerCredentials) && (apiKey || credentialSource === "keychain")) {
  throw new Error(
    "Hosted authorization cannot use deployment-global Bright Data credentials.",
  );
}
if (dataProfile === "demo" && (apiKey || credentialSource === "keychain")) {
  throw new Error("The demo Bright Data profile cannot accept live credentials.");
}
const localCredentials = apiKey
  ? staticCredential(apiKey)
  : credentialSource === "keychain"
    ? macOsKeychainCredential()
    : undefined;
const liveData = dataProfile === "live" ||
  (dataProfile === "auto" &&
    (httpAuthorization !== undefined || bearerCredentials !== undefined || localCredentials !== undefined));
if (liveData && !httpAuthorization && !bearerCredentials && !localCredentials) {
  throw new Error(
    "The live Bright Data profile requires BRIGHTDATA_API_KEY or BRIGHTDATA_CREDENTIAL_SOURCE=keychain.",
  );
}
const credentialVault = liveData && httpAuthorization
  ? await createEncryptedCredentialVault({
      path: requiredSetting("MCP_VAULT_PATH", process.env.MCP_VAULT_PATH),
      keyHex: requiredSetting("MCP_VAULT_KEY", process.env.MCP_VAULT_KEY),
      deploymentId: publicMcpUrl!.href,
    })
  : undefined;
const hostedConnection = credentialVault && httpAuthorization
  ? createHostedConnectionService({
      authorization: httpAuthorization,
      publicMcpUrl: publicMcpUrl!,
      clientId: requiredSetting(
        "MCP_OIDC_CLIENT_ID",
        process.env.MCP_OIDC_CLIENT_ID,
      ),
      clientSecret: process.env.MCP_OIDC_CLIENT_SECRET || undefined,
      vault: credentialVault,
      validateCredential: validateBrightDataCredential,
      audit: (event) => console.error(JSON.stringify(event)),
    })
  : undefined;
const credentials = credentialVault?.credentials ?? bearerCredentials?.credentials ?? localCredentials;
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
    principalId: requestPrincipal,
    icon,
    connection: hostedConnection,
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
  credentialVault?.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function validateBrightDataCredential(
  apiKey: string,
): Promise<"rejected_or_expired" | "permission" | "unavailable" | undefined> {
  const validationGateway = new BrightDataGateway({
    credentials: staticCredential(apiKey),
    logger: { info() {}, error() {} },
  });
  try {
    await validationGateway.requestJson(
      { method: "GET", path: "/status", timeoutMs: 10_000 },
      { principalId: "connection-validation", requestId: crypto.randomUUID() },
    );
    return undefined;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "unavailable";
    if (code === "brightdata_authentication_failed") return "rejected_or_expired";
    if (code === "brightdata_permission_denied") return "permission";
    return "unavailable";
  }
}

function createBrowserProvider(
  profile: "demo" | "brightdata",
): BrowserProvider {
  if (httpAuthorization && profile === "brightdata") {
    throw new Error(
      "Hosted OIDC mode cannot use deployment-global Browser API credentials.",
    );
  }
  return profile === "demo"
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
    authorization: httpAuthorization,
    bearerCredentials,
    connection: hostedConnection,
    widgetHtml,
    localPrincipalId: principalId,
    createServer,
  });
  closeTransport = httpServer.close;
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

function requiredSetting(name: string, value: string | undefined) {
  const configured = value?.trim();
  if (!configured) throw new Error(`${name} is required.`);
  return configured;
}

function readMaxTokenAge(value: string | undefined) {
  const seconds = Number(value ?? 3_600);
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 3_600) {
    throw new Error("MCP_MAX_TOKEN_AGE_SECONDS must be between 60 and 3600.");
  }
  return seconds;
}
