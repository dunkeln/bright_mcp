import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type ServerId = "bright" | "upstream";

const endpoints: Record<ServerId, string> = {
  bright: "https://bright-mcp.onrender.com/mcp",
  upstream: "https://mcp.brightdata.com/mcp",
};

export async function connect(server: ServerId, path = "/mcp") {
  const url = server === "bright"
    ? new URL(path, endpoints.bright)
    : new URL(endpoints.upstream);
  const token = process.env.BRIGHTDATA_API_KEY;
  if (!token) throw new Error("BRIGHTDATA_API_KEY is required for published MCP checks.");
  if (server === "upstream") {
    url.searchParams.set("token", token);
  }

  const client = new Client({ name: "bright-mcp-evals", version: "0.1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: server === "bright"
        ? { headers: { authorization: `Bearer ${token}` } }
        : undefined,
    }),
  );
  return client;
}

export function serverLabel(server: ServerId) {
  return server === "bright" ? "Bright MCP" : "BrightData MCP";
}

export function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const token = process.env.BRIGHTDATA_API_KEY;
  return token ? message.replaceAll(token, "[redacted]") : message;
}

export async function writeReport(name: string, report: unknown) {
  const token = process.env.BRIGHTDATA_API_KEY;
  const json = JSON.stringify(report, null, 2);
  await Bun.write(
    new URL(`../.artifacts/${name}.json`, import.meta.url),
    `${token ? json.replaceAll(token, "[redacted]") : json}\n`,
  );
}
