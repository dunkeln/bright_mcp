import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { datasetResultSchema } from "../src/core/contracts";
import { createOAuthService } from "../src/connections/oauth";
import { DATASET_WORKBENCH_URI } from "../src/mcp/dataset-tools";
import { assert, testEnvironment as environment, waitForServer } from "./compatibility-support";

const bun = process.execPath;
const projectRoot = new URL("../", import.meta.url).pathname;

await checkStdio();
await checkTaskExecution();
await checkBrowserProfile();
await checkOAuth();
if (process.env.BRIGHTDATA_BROWSER_CHECK === "1") {
  await checkRealBrowser();
}
await checkHttp();
console.log("MCP tool, resource, OAuth, stdio, and Bun HTTP compatibility passed.");

async function checkOAuth() {
  const origin = "https://bright.example";
  const resource = `${origin}/mcp`;
  const redirectUri = "http://127.0.0.1:4567/callback";
  const oauth = createOAuthService({
    issuer: new URL(resource),
    resourceUrls: new Set([resource]),
    encryptionKey: crypto.getRandomValues(new Uint8Array(32)),
    validateApiKey: async (apiKey) => apiKey === "valid-key",
  });
  const registration = await oauth.handle(
    new Request(`${origin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Compatibility check",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
      }),
    }),
  );
  assert(registration?.status === 201, "OAuth dynamic registration failed.");
  const clientId = (await registration.json() as { client_id?: string }).client_id;
  assert(clientId, "OAuth registration omitted the client ID.");

  const verifier = "a".repeat(43);
  const challenge = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  ).toString("base64url");
  const authorizationUrl = new URL(`${origin}/oauth/authorize`);
  authorizationUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
    state: "state",
  }).toString();
  const page = await oauth.handle(new Request(authorizationUrl));
  const requestToken = (await page?.text())
    ?.match(/name="request" value="([^"]+)"/)?.[1];
  assert(requestToken, "OAuth authorization page omitted its sealed request.");

  const approval = await oauth.handle(
    new Request(`${origin}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        request: requestToken,
        api_key: "valid-key",
      }),
    }),
  );
  assert(approval?.status === 302, "OAuth BYOK approval failed.");
  assert(
    !approval.headers.get("set-cookie")?.includes("valid-key"),
    "OAuth exposed the Bright Data key in its browser cookie.",
  );
  const code = new URL(approval.headers.get("location")!).searchParams.get("code");
  assert(code, "OAuth approval omitted the authorization code.");
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    resource,
  });
  const token = await oauth.handle(
    new Request(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody,
    }),
  );
  assert(token?.status === 200, "OAuth authorization-code exchange failed.");
  const issued = await token.json() as {
    access_token?: string;
    refresh_token?: string;
  };
  const accessToken = issued.access_token;
  assert(accessToken, "OAuth token response omitted the access token.");
  assert(issued.refresh_token, "OAuth token response omitted the refresh token.");
  const authenticated = await oauth.authenticate(
    new Request(resource, {
      headers: { authorization: `Bearer ${accessToken}` },
    }),
    resource,
  );
  assert(
    authenticated?.apiKey === "valid-key",
    "OAuth access token did not recover the caller credential.",
  );
  assert(
    !(await oauth.authenticate(
      new Request(resource, {
        headers: { authorization: `Bearer ${accessToken}` },
      }),
      `${origin}/mcp/browser`,
    )),
    "OAuth accepted an access token for the wrong MCP resource.",
  );
  const replay = await oauth.handle(
    new Request(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody,
    }),
  );
  assert(replay?.status === 400, "OAuth accepted a replayed authorization code.");
  const refreshed = await oauth.handle(
    new Request(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: issued.refresh_token,
        client_id: clientId,
        resource,
      }),
    }),
  );
  assert(refreshed?.status === 200, "OAuth refresh-token exchange failed.");
}

async function checkStdio() {
  const transport = new StdioClientTransport({
    command: bun,
    args: ["run", "src/main.ts"],
    cwd: projectRoot,
    env: environment({ MCP_TRANSPORT: "stdio" }),
    stderr: "pipe",
  });
  const client = new Client({ name: "bright-mcp-check", version: "0.1.0" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assertCompatibleToolSchemas(tools.tools);
    assert(
      tools.tools.map((tool) => tool.name).join(",") ===
        "search_web,discover_web,read_web,extract_web,research_web,find_datasets,run_dataset",
      "The all profile must expose exactly its seven routed tools.",
    );
    assertToolAnnotations(tools.tools);
    assert(
      tools.tools.find(({ name }) => name === "find_datasets")?.annotations?.openWorldHint === true,
      "find_datasets must disclose that discovery consults an external account catalog.",
    );
    const searchProperties = tools.tools.find(({ name }) => name === "search_web")?.inputSchema
      .properties as Record<string, unknown> | undefined;
    const findProperties = tools.tools.find(({ name }) => name === "find_datasets")?.inputSchema
      .properties as { limit?: { maximum?: number } } | undefined;
    const runArguments = tools.tools.find(({ name }) => name === "run_dataset")?.inputSchema
      .properties?.arguments as { anyOf?: unknown[] } | undefined;
    assert(
      searchProperties && Object.keys(searchProperties).join(",") === "queries",
      "search_web exposed an execution-product mode instead of one search contract.",
    );
    assert(
      findProperties?.limit?.maximum === 5,
      "find_datasets discovery breadth drifted from the bounded five-candidate contract.",
    );
    assert(
      runArguments?.anyOf?.length === 4,
      "run_dataset did not advertise its four maintained-data argument shapes.",
    );
    assert(
      !JSON.stringify(runArguments).includes('"cursor"'),
      "run_dataset exposed an upstream Marketplace cursor instead of resource continuation.",
    );
    assert(
      tools.tools.find(({ name }) => name === "search_web")?.description
        ?.includes("bright_mcp_serp") &&
        tools.tools.find(({ name }) => name === "read_web")?.description
          ?.includes("bright_mcp_unlocker"),
      "Web tools did not disclose first-use Bright Data zone creation.",
    );
    const runDatasetMeta = tools.tools.find((tool) => tool.name === "run_dataset")?._meta as
      | {
          ui?: { resourceUri?: string };
          "ui/resourceUri"?: string;
          "openai/outputTemplate"?: string;
        }
      | undefined;
    assert(
      runDatasetMeta?.ui?.resourceUri === DATASET_WORKBENCH_URI &&
        runDatasetMeta["ui/resourceUri"] === DATASET_WORKBENCH_URI &&
        runDatasetMeta["openai/outputTemplate"] === DATASET_WORKBENCH_URI,
      "run_dataset did not advertise the versioned app resource consistently.",
    );
    await assertToolRejected(client, "search_web", { queries: [] });
    await assertToolRejected(client, "discover_web", {
      query: "sources",
      publishedAfter: "2026-07-22",
      publishedBefore: "2026-07-21",
    });
    await assertToolRejected(client, "read_web", {
      urls: ["file:///tmp/nope"],
    });
    await assertToolRejected(client, "extract_web", {
      urls: ["https://example.com/"],
    });
    await assertToolRejected(client, "research_web", { query: "" });
    await assertToolRejected(client, "find_datasets", { query: "", limit: 0 });
    await assertToolRejected(client, "run_dataset", {
      datasetId: "ecommerce-products",
      operation: "search",
      arguments: { query: "e", unknown: true },
    });

    const searched = await client.callTool({
      name: "search_web",
      arguments: { queries: [{ query: "Bright Data" }] },
    });
    assert(!searched.isError, "search_web failed.");

    const discovered = await client.callTool({
      name: "discover_web",
      arguments: {
        query: "web data platforms",
        intent: "Find primary product documentation",
        limit: 2,
      },
    });
    assert(!discovered.isError, "discover_web failed.");
    assert(
      (discovered.structuredContent as { results?: unknown[] }).results?.length === 2,
      "discover_web omitted its ranked shortlist.",
    );

    const read = await client.callTool({
      name: "read_web",
      arguments: {
        urls: ["https://example.com/one", "https://example.com/two"],
      },
    });
    assert(!read.isError, "read_web failed.");
    const readResult = read.structuredContent as {
      results?: Array<{ url?: string; resourceUri?: string }>;
    };
    assert(
      readResult.results?.map((item) => item.url).join(",") ===
        "https://example.com/one,https://example.com/two",
      "read_web did not preserve input order.",
    );
    const webPage = await client.readResource({
      uri: readResult.results?.[0]?.resourceUri ?? "",
    });
    assert(webPage.contents[0]?.mimeType === "text/markdown", "read_web resource failed.");

    const source = await client.callTool({
      name: "read_web",
      arguments: {
        urls: ["https://example.com/source"],
        representation: "source",
      },
    });
    assert(!source.isError, "read_web source representation failed.");
    const sourceResult = source.structuredContent as {
      results?: Array<{ resourceUri?: string; mediaType?: string }>;
    };
    assert(
      sourceResult.results?.[0]?.mediaType === "text/html",
      "read_web source representation advertised the wrong media type.",
    );
    const sourcePage = await client.readResource({
      uri: sourceResult.results?.[0]?.resourceUri ?? "",
    });
    assert(
      sourcePage.contents[0]?.mimeType === "text/html" &&
        "text" in sourcePage.contents[0] &&
        sourcePage.contents[0].text.startsWith("<!doctype html>"),
      "read_web source resource did not preserve HTML.",
    );

    await assertToolRejected(client, "read_web", {
      urls: ["https://example.com/"],
      format: "html",
    });
    await assertToolRejected(client, "read_web", {
      urls: ["https://example.com/"],
      extraction: { instructions: "Return the page title." },
    });

    const privateTarget = await client.callTool({
      name: "read_web",
      arguments: { urls: ["http://127.0.0.1/private"] },
    });
    assert(privateTarget.isError, "read_web accepted a private-network URL.");

    const extracted = await client.callTool({
      name: "extract_web",
      arguments: {
        urls: ["https://example.com/"],
        fields: [{ name: "title", description: "Page title" }],
      },
    });
    assert(!extracted.isError, "extract_web failed.");

    const researched = await client.callTool({
      name: "research_web",
      arguments: { query: "Compare public web data products", preview: true },
    });
    assert(!researched.isError, "research_web failed.");

    const found = await client.callTool({
      name: "find_datasets",
      arguments: { query: "e-commerce products" },
    });
    assert(!found.isError, "find_datasets failed.");
    assert(
      ((
        found.structuredContent as {
          datasets?: Array<{ operations?: unknown[] }>;
        }
      ).datasets?.[0]?.operations?.length ?? 0) > 0,
      "find_datasets omitted its directly executable contract.",
    );

    const run = await client.callTool({
      name: "run_dataset",
      arguments: {
        datasetId: "ecommerce-products",
        operation: "search",
        arguments: {
          filter: { name: "category", operator: "=", value: "audio" },
          limit: 20,
          acknowledgeCost: true,
        },
      },
    });
    assert(!run.isError, "run_dataset failed.");
    const result = run.structuredContent as {
      artifact?: { uri?: string };
      page?: { nextResourceUri?: string };
    };
    assert(result.artifact?.uri, "run_dataset omitted its artifact URI.");
    assert(result.page?.nextResourceUri, "run_dataset omitted its next page URI.");
    assert(
      datasetResultSchema.safeParse(run.structuredContent).success,
      "run_dataset returned an invalid canonical result.",
    );
    const canonical = run.structuredContent as Record<string, unknown>;
    assert(
      !datasetResultSchema.safeParse({ ...canonical, rowRefs: [] }).success,
      "The canonical result accepted misaligned row references.",
    );
    const columns = canonical.columns as unknown[];
    assert(
      columns[0] !== undefined &&
        !datasetResultSchema.safeParse({
          ...canonical,
          columns: [columns[0], columns[0]],
        }).success,
      "The canonical result accepted duplicate column keys.",
    );

    const artifact = await client.readResource({ uri: result.artifact.uri });
    assert(artifact.contents.length === 1, "The result artifact was not readable.");
    const page = await client.readResource({
      uri: result.page.nextResourceUri,
    });
    assert(page.contents.length === 1, "The result page was not readable.");

    const collected = await client.callTool({
      name: "run_dataset",
      arguments: {
        datasetId: "ecommerce-products",
        operation: "collect",
        arguments: {
          urls: ["https://example.com/product-5", "https://example.com/product-1"],
          acknowledgeCost: true,
        },
      },
    });
    const collection = collected.structuredContent as {
      operation?: string;
      rows?: Array<{ productId?: string }>;
    };
    assert(
      !collected.isError &&
        collection.operation === "collect" &&
        collection.rows?.map((row) => row.productId).join(",") === "product-5,product-1",
      "run_dataset collect did not preserve the requested record order.",
    );

    const widget = await client.readResource({
      uri: DATASET_WORKBENCH_URI,
    });
    assert(
      widget.contents[0]?.mimeType === "text/html;profile=mcp-app",
      "The app resource has the wrong MIME type.",
    );
  } finally {
    await client.close();
  }
}

async function checkBrowserProfile() {
  const transport = new StdioClientTransport({
    command: bun,
    args: ["run", "src/main.ts"],
    cwd: projectRoot,
    env: environment({
      MCP_TRANSPORT: "stdio",
      MCP_PROFILE: "browser",
      MCP_BROWSER_PROFILE: "fixture",
    }),
    stderr: "pipe",
  });
  const client = new Client({ name: "bright-browser-check", version: "0.1.0" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert(
      tools.tools.map((tool) => tool.name).join(",") ===
        "browser_navigate,browser_observe,browser_interact,browser_close",
      "The browser profile must expose exactly its four browser tools.",
    );
    assertToolAnnotations(tools.tools);
    for (const name of ["browser_interact", "browser_close"]) {
      assert(
        tools.tools.find((tool) => tool.name === name)?.annotations?.destructiveHint === true,
        `${name} did not disclose its destructive state changes.`,
      );
    }
    await assertToolRejected(client, "browser_navigate", {
      destination: { kind: "url", url: "http://127.0.0.1/private" },
    });
    await assertToolRejected(client, "browser_observe", {
      sessionId: "",
      kind: "text",
    });
    await assertToolRejected(client, "browser_interact", {
      sessionId: "missing",
      action: { kind: "script", source: "alert(1)" },
    });
    await assertToolRejected(client, "browser_interact", {
      sessionId: "missing",
      action: { kind: "click", selector: "#continue" },
    });
    await assertToolRejected(client, "browser_close", { sessionId: "" });

    const navigation = await client.callTool({
      name: "browser_navigate",
      arguments: { destination: { kind: "url", url: "https://example.com/" } },
    });
    assert(!navigation.isError, "browser_navigate failed.");
    const sessionId = (navigation.structuredContent as { sessionId?: string }).sessionId;
    assert(sessionId, "browser_navigate omitted its opaque session ID.");

    const observation = await client.callTool({
      name: "browser_observe",
      arguments: { sessionId, kind: "accessibility" },
    });
    assert(!observation.isError, "browser_observe failed.");
    assert(
      (observation.structuredContent as { content?: string }).content?.includes("[ref=e1]"),
      "Accessibility observation omitted stable interaction refs.",
    );

    const interaction = await client.callTool({
      name: "browser_interact",
      arguments: { sessionId, action: { kind: "click", ref: "e1" } },
    });
    assert(!interaction.isError, "browser_interact failed.");

    const back = await client.callTool({
      name: "browser_navigate",
      arguments: { sessionId, destination: { kind: "back" } },
    });
    assert(!back.isError, "browser history navigation failed.");

    const screenshot = await client.callTool({
      name: "browser_observe",
      arguments: { sessionId, kind: "screenshot" },
    });
    assert(!screenshot.isError, "browser screenshot observation failed.");
    const resourceUri = (screenshot.structuredContent as { resource?: { uri?: string } }).resource
      ?.uri;
    assert(resourceUri, "browser screenshot omitted its resource URI.");
    const artifact = await client.readResource({ uri: resourceUri });
    assert(artifact.contents[0]?.mimeType === "image/png", "Screenshot resource failed.");

    const closed = await client.callTool({
      name: "browser_close",
      arguments: { sessionId },
    });
    assert(!closed.isError, "browser_close failed.");
    const closedAgain = await client.callTool({
      name: "browser_close",
      arguments: { sessionId },
    });
    assert(!closedAgain.isError, "browser_close was not idempotent.");
  } finally {
    await client.close();
  }
}

async function checkRealBrowser() {
  const apiKey = process.env.BRIGHTDATA_API_KEY;
  assert(
    apiKey,
    "The real browser check requires BRIGHTDATA_API_KEY.",
  );
  const transport = new StdioClientTransport({
    command: bun,
    args: ["run", "src/main.ts"],
    cwd: projectRoot,
    env: environment({
      MCP_TRANSPORT: "stdio",
      MCP_PROFILE: "browser",
      MCP_BROWSER_PROFILE: "brightdata",
      BRIGHTDATA_API_KEY: apiKey,
      BRIGHTDATA_BROWSER_ZONE: process.env.BRIGHTDATA_BROWSER_ZONE ?? "",
    }),
    stderr: "pipe",
  });
  const client = new Client({
    name: "bright-real-browser-check",
    version: "0.1.0",
  });
  await client.connect(transport);
  let sessionId: string | undefined;
  try {
    const navigation = await client.callTool({
      name: "browser_navigate",
      arguments: { destination: { kind: "url", url: "https://example.com/" } },
    });
    assert(!navigation.isError, "Real Bright Data browser navigation failed.");
    sessionId = (navigation.structuredContent as { sessionId?: string }).sessionId;
    assert(sessionId, "Real browser navigation omitted its session ID.");
    const observation = await client.callTool({
      name: "browser_observe",
      arguments: { sessionId, kind: "accessibility" },
    });
    assert(!observation.isError, "Real Bright Data AI browser observation failed.");
    const ref = (observation.structuredContent as { content?: string }).content?.match(
      /\[ref=((?:f\d+)?e\d+)\]/,
    )?.[1];
    assert(ref, "Real Bright Data AI browser observation omitted interaction refs.");
    const interaction = await client.callTool({
      name: "browser_interact",
      arguments: { sessionId, action: { kind: "click", ref } },
    });
    assert(!interaction.isError, "Real Bright Data ref interaction failed.");
  } finally {
    if (sessionId) {
      await client.callTool({
        name: "browser_close",
        arguments: { sessionId },
      });
    }
    await client.close();
  }
}

async function checkTaskExecution() {
  const transport = new StdioClientTransport({
    command: bun,
    args: ["run", "src/main.ts"],
    cwd: projectRoot,
    env: environment({ MCP_TRANSPORT: "stdio" }),
    stderr: "pipe",
  });
  const client = new Client(
    { name: "bright-task-check", version: "0.1.0" },
    { taskStore: new InMemoryTaskStore(), defaultTaskPollInterval: 25 },
  );
  await client.connect(transport);
  try {
    const stream = client.experimental.tasks.callToolStream(
      {
        name: "run_dataset",
        arguments: {
          datasetId: "ecommerce-products",
          operation: "search",
          arguments: {
            filter: { name: "category", operator: "=", value: "audio" },
            limit: 5,
            acknowledgeCost: true,
          },
        },
      },
      CallToolResultSchema,
      { task: { ttl: 60_000 } },
    );
    let created = false;
    let completed = false;
    for await (const message of stream) {
      if (message.type === "taskCreated") created = true;
      if (message.type === "result") {
        assert(!message.result.isError, "Task-backed run_dataset failed.");
        completed = true;
      }
    }
    assert(created, "run_dataset did not create an MCP task.");
    assert(completed, "run_dataset task did not return its result.");
  } finally {
    await client.close();
  }
}

async function checkHttp() {
  const port = 18_787;
  const process = Bun.spawn([bun, "run", "src/main.ts"], {
    cwd: projectRoot,
    env: environment({
      MCP_TRANSPORT: "http",
      MCP_BROWSER_PROFILE: "fixture",
      PORT: String(port),
    }),
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    await waitForServer(`http://127.0.0.1:${port}/`, process, "The Bun HTTP server did not start.");
    const expectedProfiles = {
      "/mcp": "search_web,discover_web,read_web,extract_web,research_web,find_datasets,run_dataset",
      "/mcp/web": "search_web,discover_web,read_web",
      "/mcp/deep-lookup": "extract_web,research_web",
      "/mcp/marketplace": "find_datasets,run_dataset",
      "/mcp/browser": "browser_navigate,browser_observe,browser_interact,browser_close",
    } as const;
    for (const [path, expected] of Object.entries(expectedProfiles)) {
      const profileClient = new Client({
        name: `bright-http-${path.slice(5) || "all"}-check`,
        version: "0.1.0",
      });
      await profileClient.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${path}`)),
      );
      try {
        const tools = await profileClient.listTools();
        assertCompatibleToolSchemas(tools.tools);
        assert(
          tools.tools.map(({ name }) => name).join(",") === expected,
          `${path} exposed the wrong capability profile.`,
        );
      } finally {
        await profileClient.close();
      }
    }

    const client = new Client({ name: "bright-http-check", version: "0.1.0" });
    let browserSessionId = "";
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/browser`)),
    );
    try {
      const navigation = await client.callTool({
        name: "browser_navigate",
        arguments: {
          destination: { kind: "url", url: "https://example.com/" },
        },
      });
      browserSessionId = (navigation.structuredContent as { sessionId?: string }).sessionId ?? "";
      assert(browserSessionId, "Bun HTTP browser navigation omitted its session.");
    } finally {
      await client.close();
    }

    const replacement = new Client({
      name: "bright-http-reconnect-check",
      version: "0.1.0",
    });
    await replacement.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/browser`)),
    );
    try {
      const stale = await replacement.callTool({
        name: "browser_observe",
        arguments: { sessionId: browserSessionId, kind: "text" },
      });
      assert(stale.isError, "A browser session survived its HTTP transport.");
    } finally {
      await replacement.close();
    }
  } finally {
    process.kill();
    await process.exited;
  }
}

async function assertToolRejected(client: Client, name: string, args: Record<string, unknown>) {
  try {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) return;
  } catch {
    return;
  }
  throw new Error(`${name} accepted invalid input.`);
}

function assertToolAnnotations(
  tools: Array<{ name: string; annotations?: Record<string, unknown> }>,
) {
  for (const tool of tools) {
    for (const name of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
      assert(
        typeof tool.annotations?.[name] === "boolean",
        `${tool.name} omitted the ${name} annotation.`,
      );
    }
  }
}

function assertCompatibleToolSchemas(tools: Array<{ inputSchema: object; outputSchema?: object }>) {
  const schemas = JSON.stringify(
    tools.map(({ inputSchema, outputSchema }) => ({
      inputSchema,
      outputSchema,
    })),
  );
  assert(
    !schemas.includes('"$schema"') &&
      !schemas.includes('"definitions"') &&
      !schemas.includes("#/definitions/"),
    "Tool schemas exposed an incompatible JSON Schema dialect.",
  );
}
