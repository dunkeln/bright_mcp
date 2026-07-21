import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const projectRoot = new URL("../", import.meta.url).pathname;
const temporaryDirectory = await mkdtemp(join(tmpdir(), "bright-mcp-auth-"));
const keyPath = join(temporaryDirectory, "localhost.key");
const certificatePath = join(temporaryDirectory, "localhost.crt");
const issuerPort = randomPort();
const mcpPort = randomPort(issuerPort);
const issuer = `https://127.0.0.1:${issuerPort}`;
const resource = `https://127.0.0.1:${mcpPort}/mcp`;
const { privateKey, publicKey } = await generateKeyPair("RS256");
const publicJwk = {
  ...(await exportJWK(publicKey)),
  kid: "compatibility-key",
  alg: "RS256",
  use: "sig",
};

await createCertificate(keyPath, certificatePath);
const issuerServer = Bun.serve({
  port: issuerPort,
  tls: { key: Bun.file(keyPath), cert: Bun.file(certificatePath) },
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (
      path === "/.well-known/oauth-authorization-server" ||
      path === "/.well-known/openid-configuration"
    ) {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (path === "/jwks") return Response.json({ keys: [publicJwk] });
    return new Response("Not found", { status: 404 });
  },
});

const child = Bun.spawn([process.execPath, "run", "src/main.ts"], {
  cwd: projectRoot,
  env: {
    ...cleanEnvironment(),
    MCP_TRANSPORT: "http",
    MCP_AUTH_MODE: "oidc",
    MCP_PUBLIC_URL: resource,
    MCP_OIDC_ISSUER: issuer,
    PORT: String(mcpPort),
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
  },
  stdout: "ignore",
  stderr: "pipe",
});

try {
  await waitForServer(`http://127.0.0.1:${mcpPort}/`);
  const metadata = await fetch(
    `http://127.0.0.1:${mcpPort}/.well-known/oauth-protected-resource/mcp`,
  );
  assert(metadata.ok, "Protected Resource Metadata was not published.");
  const metadataBody = (await metadata.json()) as { resource?: string };
  assert(metadataBody.resource === resource, "Protected resource identifier drifted.");

  const unauthenticated = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert(unauthenticated.status === 401, "Missing access token did not return 401.");
  assert(
    unauthenticated.headers.get("www-authenticate")?.includes("resource_metadata="),
    "The 401 challenge omitted resource metadata.",
  );

  const webToken = await token("principal-a", ["mcp:access", "bright:web"]);
  const webClient = await connectClient(webToken, "auth-web-check");
  try {
    const search = await webClient.callTool({
      name: "search_web",
      arguments: { query: "Bright Data" },
    });
    assert(!search.isError, "A correctly scoped web call failed.");
    let denied = false;
    try {
      await webClient.callTool({
        name: "run_dataset",
        arguments: {
          datasetId: "ecommerce-products",
          operation: "search",
          arguments: { query: "e", limit: 5 },
        },
      });
    } catch {
      denied = true;
    }
    assert(denied, "Dataset execution did not require incremental scope.");
  } finally {
    await webClient.close();
  }

  const datasetScopes = ["mcp:access", "bright:datasets:run"];
  const ownerClient = await connectClient(
    await token("principal-a", datasetScopes),
    "auth-owner-check",
  );
  let resultUri: string;
  try {
    const tools = await ownerClient.listTools();
    const runTool = tools.tools.find((tool) => tool.name === "run_dataset");
    assert(
      runTool?.execution?.taskSupport === "forbidden",
      "Hosted mode advertised tasks without principal-bound task storage.",
    );
    const run = await ownerClient.callTool({
      name: "run_dataset",
      arguments: {
        datasetId: "ecommerce-products",
        operation: "search",
        arguments: { query: "e", limit: 5 },
      },
    });
    assert(!run.isError, "Scoped dataset execution failed.");
    resultUri = (
      run.structuredContent as { artifact?: { uri?: string } }
    ).artifact?.uri ?? "";
    assert(resultUri, "Dataset execution omitted its result resource.");
    const owned = await ownerClient.readResource({ uri: resultUri });
    assert(owned.contents.length === 1, "The owner could not read its result.");
  } finally {
    await ownerClient.close();
  }

  const otherClient = await connectClient(
    await token("principal-b", datasetScopes),
    "auth-other-check",
  );
  try {
    let isolated = false;
    try {
      await otherClient.readResource({ uri: resultUri });
    } catch {
      isolated = true;
    }
    assert(isolated, "A different principal could read the owner's result.");
  } finally {
    await otherClient.close();
  }

  console.log("OIDC discovery, scope routing, and principal ownership passed.");
} finally {
  child.kill();
  await child.exited;
  issuerServer.stop(true);
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function token(subject: string, scopes: string[]) {
  return new SignJWT({ scope: scopes.join(" "), client_id: "compatibility-client" })
    .setProtectedHeader({ alg: "RS256", kid: "compatibility-key" })
    .setIssuer(issuer)
    .setAudience(resource)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(privateKey);
}

async function connectClient(accessToken: string, name: string) {
  const client = new Client({ name, version: "0.1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${mcpPort}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } },
    ),
  );
  return client;
}

async function createCertificate(key: string, certificate: string) {
  const process = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      key,
      "-out",
      certificate,
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  if ((await process.exited) !== 0) {
    throw new Error("OpenSSL could not create the temporary HTTPS certificate.");
  }
}

async function waitForServer(url: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Protected MCP exited during startup: ${await new Response(child.stderr).text()}`);
    }
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // The child is still discovering the issuer or starting Bun HTTP.
    }
    await Bun.sleep(50);
  }
  throw new Error("Protected MCP did not start.");
}

function cleanEnvironment() {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    BRIGHTDATA_API_KEY: "",
    BRIGHTDATA_SERP_ZONE: "",
    BRIGHTDATA_UNLOCKER_ZONE: "",
    BRIGHTDATA_BROWSER_USERNAME: "",
    BRIGHTDATA_BROWSER_PASSWORD: "",
    MCP_BROWSER_PROFILE: "disabled",
  };
}

function randomPort(except?: number) {
  let value = 20_000 + Math.floor(Math.random() * 20_000);
  if (value === except) value += 1;
  return value;
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
