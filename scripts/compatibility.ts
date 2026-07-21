import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

const bun = process.execPath;
const projectRoot = new URL("../", import.meta.url).pathname;

await checkStdio();
await checkTaskExecution();
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
    assert(
      extraction.isError,
      "scrape must fail clearly when extraction is requested without a provider.",
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

    const artifact = await client.readResource({ uri: result.artifact.uri });
    assert(artifact.contents.length === 1, "The result artifact was not readable.");
    const page = await client.readResource({ uri: result.page.nextResourceUri });
    assert(page.contents.length === 1, "The result page was not readable.");
    const widget = await client.readResource({
      uri: "ui://bright-mcp/dataset-table",
    });
    assert(
      widget.contents[0]?.mimeType === "text/html;profile=mcp-app",
      "The app resource has the wrong MIME type.",
    );
  } finally {
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
    env: environment({ MCP_TRANSPORT: "http", PORT: String(port) }),
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    await waitForServer(`http://127.0.0.1:${port}/`);
    const client = new Client({ name: "bright-http-check", version: "0.1.0" });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
      ),
    );
    try {
      const tools = await client.listTools();
      assert(tools.tools.length === 5, "Bun HTTP did not expose the base tools.");
    } finally {
      await client.close();
    }
  } finally {
    process.kill();
    await process.exited;
  }
}

async function waitForServer(url: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // The child is still starting.
    }
    await Bun.sleep(50);
  }
  throw new Error("The Bun HTTP server did not start.");
}

function environment(overrides: Record<string, string>): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  return {
    ...inherited,
    BRIGHTDATA_API_KEY: "",
    BRIGHTDATA_SERP_ZONE: "",
    BRIGHTDATA_UNLOCKER_ZONE: "",
    ...overrides,
  };
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
