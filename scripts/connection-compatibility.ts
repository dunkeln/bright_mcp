import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ElicitationCompleteNotificationSchema,
  UrlElicitationRequiredError,
} from "@modelcontextprotocol/sdk/types.js";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const projectRoot = new URL("../", import.meta.url).pathname;
const temporaryDirectory = await mkdtemp(join(tmpdir(), "bright-mcp-connection-"));
const vaultKey = "11".repeat(32);

try {
  await checkHostedMcpElicitation();
  console.log("Hosted connection, encrypted storage, and URL elicitation passed.");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function checkHostedMcpElicitation() {
  const keyPath = join(temporaryDirectory, "localhost.key");
  const certificatePath = join(temporaryDirectory, "localhost.crt");
  const issuerPort = randomPort();
  const mcpPort = randomPort(issuerPort);
  const issuer = `https://127.0.0.1:${issuerPort}`;
  const resource = `https://127.0.0.1:${mcpPort}/mcp`;
  const hostedVaultPath = join(temporaryDirectory, "hosted.sqlite");
  const preloadPath = join(temporaryDirectory, "bright-fetch-preload.ts");
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = {
    ...(await exportJWK(publicKey)),
    kid: "connection-key",
    alg: "RS256",
    use: "sig",
  };
  const authorizationCodes = new Map<
    string,
    { challenge: string; redirectUri: string; subject: string }
  >();
  await createCertificate(keyPath, certificatePath);
  await Bun.write(
    preloadPath,
    `const nativeFetch = globalThis.fetch;
const fixtureFetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== "https://api.brightdata.com") return nativeFetch(input, init);
  const authorization = new Headers(init?.headers).get("authorization");
  if (authorization !== "Bearer valid-bright-token") return new Response(null, { status: 401 });
  if (url.pathname === "/status") return Response.json({ status: "active" });
  if (url.pathname === "/datasets/v3/scrape") {
    return Response.json([{ title: "Wireless earbuds", url: "https://example.com/product", price: 49 }]);
  }
  return new Response(null, { status: 404 });
};
Object.assign(fixtureFetch, { preconnect: nativeFetch.preconnect });
globalThis.fetch = fixtureFetch as typeof fetch;
`,
  );
  const issuerServer = Bun.serve({
    port: issuerPort,
    tls: { key: Bun.file(keyPath), cert: Bun.file(certificatePath) },
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
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
      if (path === "/authorize") {
        const state = url.searchParams.get("state") ?? "";
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        const challenge = url.searchParams.get("code_challenge") ?? "";
        if (
          !state ||
          !redirectUri ||
          !challenge ||
          url.searchParams.get("code_challenge_method") !== "S256" ||
          url.searchParams.get("resource") !== resource
        ) {
          return new Response("Invalid authorization request", { status: 400 });
        }
        const code = `code_${crypto.randomUUID()}`;
        authorizationCodes.set(code, {
          challenge,
          redirectUri,
          subject: "principal-a",
        });
        const callback = new URL(redirectUri);
        callback.searchParams.set("state", state);
        callback.searchParams.set("code", code);
        return new Response(null, { status: 303, headers: { location: callback.href } });
      }
      if (path === "/token" && request.method === "POST") {
        const body = new URLSearchParams(await request.text());
        const code = body.get("code") ?? "";
        const pending = authorizationCodes.get(code);
        authorizationCodes.delete(code);
        const challenge = base64url(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(body.get("code_verifier") ?? ""),
          ),
        );
        if (
          !pending ||
          challenge !== pending.challenge ||
          body.get("redirect_uri") !== pending.redirectUri ||
          body.get("resource") !== resource
        ) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        return Response.json({
          access_token: await accessToken(pending.subject),
          token_type: "Bearer",
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  const child = Bun.spawn(
    [process.execPath, "run", "--preload", preloadPath, "src/main.ts"],
    {
    cwd: projectRoot,
    env: {
      ...cleanEnvironment(),
      MCP_TRANSPORT: "http",
      MCP_AUTH_MODE: "oidc",
      MCP_PUBLIC_URL: resource,
      MCP_OIDC_ISSUER: issuer,
      MCP_OIDC_CLIENT_ID: "connection-check",
      MCP_VAULT_PATH: hostedVaultPath,
      MCP_VAULT_KEY: vaultKey,
      BRIGHTDATA_PROFILE: "live",
      PORT: String(mcpPort),
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    },
      stdout: "ignore",
      stderr: "pipe",
    },
  );

  try {
    await waitForServer(`http://127.0.0.1:${mcpPort}/`, child);
    const tokenA = await accessToken("principal-a");
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${mcpPort}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${tokenA}` } } },
    );
    const client = new Client(
      { name: "connection-url-check", version: "0.1.0" },
      { capabilities: { elicitation: { url: {} } } },
    );
    const completions: string[] = [];
    client.setNotificationHandler(
      ElicitationCompleteNotificationSchema,
      async ({ params }) => {
        completions.push(params.elicitationId);
      },
    );
    await client.connect(transport);
    try {
      let elicitation: UrlElicitationRequiredError | undefined;
      let toolResult: unknown;
      try {
        toolResult = await client.callTool({
          name: "run_dataset",
          arguments: {
            datasetId: "amazon-products-search",
            operation: "search",
            arguments: { query: "wireless earbuds", pages: 1 },
          },
        });
      } catch (error) {
        if (error instanceof UrlElicitationRequiredError) elicitation = error;
      }
      const requested = elicitation?.elicitations[0];
      assert(
        requested?.mode === "url" &&
          requested.url.startsWith(`${resource.replace("/mcp", "")}/connections/brightdata?state=`),
        `A URL-capable hosted client did not receive principal-bound connection elicitation: ${JSON.stringify({
          error: elicitation?.message,
          requested,
          toolResult,
        })}`,
      );

      const connected = await completeHostedConnection(requested.url);
      assert(connected.status === 200, "The hosted token form did not complete.");
      for (let attempt = 0; attempt < 50 && completions.length === 0; attempt += 1) {
        await Bun.sleep(20);
      }
      assert(
        completions.includes(requested.elicitationId),
        "The hosted MCP transport did not deliver connection completion.",
      );
      await assertVaultDoesNotContain(hostedVaultPath, "valid-bright-token");

      const retried = await client.callTool({
        name: "run_dataset",
        arguments: {
          datasetId: "amazon-products-search",
          operation: "search",
          arguments: { query: "wireless earbuds", pages: 1 },
        },
      });
      assert(!retried.isError, "The original hosted workflow failed after connection.");

      const tokenB = await accessToken("principal-b");
      const stolenSession = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenB}`,
          "content-type": "application/json",
          "mcp-protocol-version": "2025-11-25",
          "mcp-session-id": transport.sessionId ?? "",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert(stolenSession.status === 404, "An MCP session crossed authenticated principals.");

      const revoked = await completeHostedConnection(
        `${resource.replace("/mcp", "")}/connections/brightdata/revoke`,
      );
      assert(revoked.status === 200, "The hosted credential could not be revoked.");
      let connectionRequired = false;
      try {
        await client.callTool({
          name: "run_dataset",
          arguments: {
            datasetId: "amazon-products-search",
            operation: "search",
            arguments: { query: "wireless earbuds", pages: 1 },
          },
        });
      } catch (error) {
        connectionRequired = error instanceof UrlElicitationRequiredError;
      }
      assert(connectionRequired, "Revocation left the hosted credential usable.");
    } finally {
      await client.close();
    }

    const fallback = new Client({ name: "connection-fallback-check", version: "0.1.0" });
    await fallback.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${mcpPort}/mcp`),
        { requestInit: { headers: { authorization: `Bearer ${await accessToken("principal-c")}` } } },
      ),
    );
    try {
      const result = await fallback.callTool({
        name: "run_dataset",
        arguments: {
          datasetId: "amazon-products-search",
          operation: "search",
          arguments: { query: "wireless earbuds", pages: 1 },
        },
      });
      const content = Array.isArray(result.content) ? result.content : [];
      const message = content[0]?.type === "text" ? content[0].text : "";
      assert(
        result.isError && message.includes("https://127.0.0.1") && !message.includes("paste"),
        `A client without URL elicitation did not receive the manual connection route: ${message}`,
      );
    } finally {
      await fallback.close();
    }
  } finally {
    child.kill();
    await child.exited;
    issuerServer.stop(true);
  }

  async function accessToken(subject: string) {
    return new SignJWT({
      scope: "mcp:access bright:datasets:run",
      client_id: "connection-check",
    })
      .setProtectedHeader({ alg: "RS256", kid: "connection-key" })
      .setIssuer(issuer)
      .setAudience(resource)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(privateKey);
  }

  async function completeHostedConnection(startUrl: string) {
    const started = await fetch(asLocalUrl(startUrl), { redirect: "manual" });
    assert(started.status === 303, "The hosted connection route did not start authorization.");
    const authorized = await fetch(requiredHeader(started, "location"), {
      redirect: "manual",
      tls: { rejectUnauthorized: false },
    });
    assert(authorized.status === 303, "The authorization server did not return a code.");
    const callback = await fetch(asLocalUrl(requiredHeader(authorized, "location")), {
      redirect: "manual",
    });
    const setCookie = callback.headers.get("set-cookie");
    if (!setCookie) return callback;

    const body = await callback.text();
    const csrf = body.match(/name="csrf" value="([^"]+)"/)?.[1];
    assert(csrf, "The hosted token form omitted CSRF state.");
    return fetch(asLocalUrl(`${resource.replace("/mcp", "")}/connections/brightdata`), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: setCookie.split(";", 1)[0]!,
        origin: new URL(resource).origin,
      },
      body: new URLSearchParams({ csrf, apiToken: "valid-bright-token" }),
    });
  }
}

async function assertVaultDoesNotContain(path: string, secret: string) {
  const files = await readdir(temporaryDirectory);
  for (const file of files.filter((name) => name.startsWith(path.split("/").at(-1)!))) {
    assert(!(await readFile(join(temporaryDirectory, file))).includes(secret), "The vault wrote a plaintext credential.");
  }
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
  assert((await process.exited) === 0, "OpenSSL could not create a temporary HTTPS certificate.");
}

async function waitForServer(url: string, child: Bun.Subprocess) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      const stderr = child.stderr instanceof ReadableStream
        ? await new Response(child.stderr).text()
        : "stderr unavailable";
      throw new Error(`Protected MCP exited during startup: ${stderr}`);
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

function requiredHeader(response: Response, name: string) {
  const value = response.headers.get(name);
  assert(value, `Response omitted ${name}.`);
  return value;
}

function cleanEnvironment() {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    BRIGHTDATA_API_KEY: "",
    BRIGHTDATA_CREDENTIAL_SOURCE: "auto",
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

function base64url(value: ArrayBuffer) {
  return Buffer.from(new Uint8Array(value)).toString("base64url");
}

function asLocalUrl(value: string) {
  const url = new URL(value);
  url.protocol = "http:";
  return url;
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
