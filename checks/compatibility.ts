import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import {
  CallToolResultSchema,
  CreateMessageRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { datasetResultSchema } from "../src/core/contracts";
import {
  assert,
  testEnvironment as environment,
  waitForServer,
} from "./compatibility-support";

const bun = process.execPath;
const projectRoot = new URL("../", import.meta.url).pathname;

await checkStdio();
await checkSamplingExtraction();
await checkTaskExecution();
await checkBrowserProfile();
if (process.env.BRIGHTDATA_BROWSER_CHECK === "1") {
  await checkRealBrowser();
}
await checkHttp();
console.log("MCP tool, resource, stdio, and Bun HTTP compatibility passed.");

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
    assert(
      tools.tools.map((tool) => tool.name).join(",") ===
        "search_web,scrape,find_datasets,describe_dataset,run_dataset",
      "The base profile must expose exactly its five routed tools.",
    );
    assertToolAnnotations(tools.tools);
    const runDatasetMeta = tools.tools.find((tool) => tool.name === "run_dataset")
      ?._meta as
      | {
          ui?: { resourceUri?: string };
          "ui/resourceUri"?: string;
          "openai/outputTemplate"?: string;
        }
      | undefined;
    const datasetTableUri = "ui://bright-mcp/dataset-table-v1.html";
    assert(
      runDatasetMeta?.ui?.resourceUri === datasetTableUri &&
        runDatasetMeta["ui/resourceUri"] === datasetTableUri &&
        runDatasetMeta["openai/outputTemplate"] === datasetTableUri,
      "run_dataset did not advertise the versioned app resource consistently.",
    );
    await assertToolRejected(client, "search_web", { query: "" });
    await assertToolRejected(client, "scrape", { urls: ["file:///tmp/nope"] });
    await assertToolRejected(client, "find_datasets", { query: "", limit: 0 });
    await assertToolRejected(client, "describe_dataset", { datasetId: "" });
    await assertToolRejected(client, "run_dataset", {
      datasetId: "ecommerce-products",
      operation: "search",
      arguments: { query: "e", unknown: true },
    });

    const searched = await client.callTool({
      name: "search_web",
      arguments: { query: "Bright Data" },
    });
    assert(!searched.isError, "search_web failed.");

    const scraped = await client.callTool({
      name: "scrape",
      arguments: {
        urls: ["https://example.com/one", "https://example.com/two"],
        format: "markdown",
      },
    });
    assert(!scraped.isError, "scrape failed.");
    const scrapeResult = scraped.structuredContent as {
      results?: Array<{ url?: string }>;
    };
    assert(
      scrapeResult.results?.map((item) => item.url).join(",") ===
        "https://example.com/one,https://example.com/two",
      "scrape did not preserve input order.",
    );

    const extraction = await client.callTool({
      name: "scrape",
      arguments: {
        urls: ["https://example.com/"],
        extraction: {
          instructions: "Return the page title.",
          fields: { title: { kind: "string" } },
        },
      },
    });
    const unavailable = extraction.structuredContent as {
      results?: Array<{ extractionError?: { code?: string } }>;
    };
    assert(
      unavailable.results?.[0]?.extractionError?.code ===
        "extraction_provider_unavailable",
      "scrape did not explain that the host lacks a sampling provider.",
    );

    const privateTarget = await client.callTool({
      name: "scrape",
      arguments: { urls: ["http://127.0.0.1/private"] },
    });
    assert(privateTarget.isError, "scrape accepted a private-network URL.");

    const found = await client.callTool({
      name: "find_datasets",
      arguments: { query: "e-commerce products" },
    });
    assert(!found.isError, "find_datasets failed.");

    const described = await client.callTool({
      name: "describe_dataset",
      arguments: { datasetId: "ecommerce-products" },
    });
    assert(!described.isError, "describe_dataset failed.");

    const run = await client.callTool({
      name: "run_dataset",
      arguments: {
        datasetId: "ecommerce-products",
        operation: "search",
        arguments: { query: "e", limit: 20 },
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
    const page = await client.readResource({ uri: result.page.nextResourceUri });
    assert(page.contents.length === 1, "The result page was not readable.");

    const collected = await client.callTool({
      name: "run_dataset",
      arguments: {
        datasetId: "ecommerce-products",
        operation: "collect",
        arguments: { productIds: ["product-5", "product-1"] },
      },
    });
    const collection = collected.structuredContent as {
      operation?: string;
      rows?: Array<{ productId?: string }>;
    };
    assert(
      !collected.isError &&
        collection.operation === "collect" &&
        collection.rows?.map((row) => row.productId).join(",") ===
          "product-5,product-1",
      "run_dataset collect did not preserve the requested record order.",
    );

    const widget = await client.readResource({
      uri: datasetTableUri,
    });
    assert(
      widget.contents[0]?.mimeType === "text/html;profile=mcp-app",
      "The app resource has the wrong MIME type.",
    );
  } finally {
    await client.close();
  }
}

async function checkSamplingExtraction() {
  const transport = new StdioClientTransport({
    command: bun,
    args: ["run", "src/main.ts"],
    cwd: projectRoot,
    env: environment({ MCP_TRANSPORT: "stdio" }),
    stderr: "pipe",
  });
  const client = new Client(
    { name: "bright-extraction-check", version: "0.1.0" },
    { capabilities: { sampling: {} } },
  );
  client.setRequestHandler(CreateMessageRequestSchema, async () => ({
    role: "assistant",
    content: { type: "text", text: JSON.stringify({ title: "Demo page" }) },
    model: "compatibility-fixture",
    stopReason: "endTurn",
  }));
  await client.connect(transport);
  try {
    const extraction = await client.callTool({
      name: "scrape",
      arguments: {
        urls: ["https://example.com/"],
        extraction: {
          instructions: "Return the page title.",
          fields: { title: { kind: "string" } },
        },
      },
    });
    const result = extraction.structuredContent as {
      results?: Array<{
        extraction?: {
          data?: { title?: string };
          provenance?: { provider?: string; model?: string };
        };
      }>;
    };
    assert(!extraction.isError, "Sampling-backed extraction failed.");
    assert(
      result.results?.[0]?.extraction?.data?.title === "Demo page" &&
        result.results[0].extraction?.provenance?.provider === "mcp-sampling" &&
        result.results[0].extraction?.provenance?.model === "compatibility-fixture",
      "Sampling-backed extraction lost validated data or provenance.",
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
    env: environment({ MCP_TRANSPORT: "stdio", MCP_BROWSER_PROFILE: "demo" }),
    stderr: "pipe",
  });
  const client = new Client({ name: "bright-browser-check", version: "0.1.0" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert(
      tools.tools.map((tool) => tool.name).join(",") ===
        "search_web,scrape,find_datasets,describe_dataset,run_dataset,browser_navigate,browser_observe,browser_interact,browser_close",
      "The browser profile must expose exactly nine tools.",
    );
    assertToolAnnotations(tools.tools);
    for (const name of ["browser_interact", "browser_close"]) {
      assert(
        tools.tools.find((tool) => tool.name === name)?.annotations
          ?.destructiveHint === true,
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
      arguments: { sessionId, kind: "text" },
    });
    assert(!observation.isError, "browser_observe failed.");

    const interaction = await client.callTool({
      name: "browser_interact",
      arguments: { sessionId, action: { kind: "scroll", deltaY: 200 } },
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
    const resourceUri = (
      screenshot.structuredContent as { resource?: { uri?: string } }
    ).resource?.uri;
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
  const username = process.env.BRIGHTDATA_BROWSER_USERNAME;
  const password = process.env.BRIGHTDATA_BROWSER_PASSWORD;
  assert(
    username && password,
    "The real browser check requires Bright Data Browser API credentials.",
  );
  const transport = new StdioClientTransport({
    command: bun,
    args: ["run", "src/main.ts"],
    cwd: projectRoot,
    env: environment({
      MCP_TRANSPORT: "stdio",
      MCP_BROWSER_PROFILE: "brightdata",
      BRIGHTDATA_BROWSER_USERNAME: username,
      BRIGHTDATA_BROWSER_PASSWORD: password,
    }),
    stderr: "pipe",
  });
  const client = new Client({ name: "bright-real-browser-check", version: "0.1.0" });
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
      arguments: { sessionId, kind: "text" },
    });
    assert(!observation.isError, "Real Bright Data browser observation failed.");
  } finally {
    if (sessionId) {
      await client.callTool({ name: "browser_close", arguments: { sessionId } });
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
          arguments: { query: "e", limit: 5 },
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
      MCP_BROWSER_PROFILE: "demo",
      PORT: String(port),
    }),
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    await waitForServer(
      `http://127.0.0.1:${port}/`,
      process,
      "The Bun HTTP server did not start.",
    );
    const client = new Client({ name: "bright-http-check", version: "0.1.0" });
    let browserSessionId = "";
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
      ),
    );
    try {
      const tools = await client.listTools();
      assert(tools.tools.length === 9, "Bun HTTP did not expose the browser profile.");
      const navigation = await client.callTool({
        name: "browser_navigate",
        arguments: { destination: { kind: "url", url: "https://example.com/" } },
      });
      browserSessionId =
        (navigation.structuredContent as { sessionId?: string }).sessionId ?? "";
      assert(browserSessionId, "Bun HTTP browser navigation omitted its session.");
    } finally {
      await client.close();
    }

    const replacement = new Client({
      name: "bright-http-reconnect-check",
      version: "0.1.0",
    });
    await replacement.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
      ),
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

async function assertToolRejected(
  client: Client,
  name: string,
  args: Record<string, unknown>,
) {
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
    for (const name of [
      "readOnlyHint",
      "destructiveHint",
      "idempotentHint",
      "openWorldHint",
    ]) {
      assert(
        typeof tool.annotations?.[name] === "boolean",
        `${tool.name} omitted the ${name} annotation.`,
      );
    }
  }
}
