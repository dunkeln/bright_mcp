import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const bun = process.execPath;
const projectRoot = new URL("../", import.meta.url).pathname;

await checkStdio();
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
        "find_datasets,describe_dataset,run_dataset",
      "The dataset slice must expose exactly its three routed tools.",
    );

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
      assert(tools.tools.length === 3, "Bun HTTP did not expose the dataset tools.");
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
  return { ...inherited, ...overrides };
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
