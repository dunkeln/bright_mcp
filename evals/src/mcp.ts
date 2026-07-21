import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type ServerId = "bright" | "upstream";

const endpoints: Record<ServerId, string> = {
  bright: "https://bright-mcp.onrender.com/mcp",
  upstream: "https://mcp.brightdata.com/mcp",
};

export async function connect(server: ServerId) {
  const url = new URL(endpoints[server]);
  if (server === "upstream") {
    const token = process.env.BRIGHTDATA_API_KEY;
    if (!token) throw new Error("BRIGHTDATA_API_KEY is required for upstream checks.");
    url.searchParams.set("token", token);
  }

  const client = new Client({ name: "bright-mcp-evals", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(url));
  return client;
}

export function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const token = process.env.BRIGHTDATA_API_KEY;
  return token ? message.replaceAll(token, "[redacted]") : message;
}

export async function writeReport(name: string, report: unknown) {
  await Bun.write(
    new URL(`../.artifacts/${name}.json`, import.meta.url),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}
