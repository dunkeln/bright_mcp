import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { connect, safeError, serverLabel, type ServerId, writeReport } from "./mcp";

const expectedTools: Record<ServerId, string[]> = {
  bright: ["describe_dataset", "find_datasets", "run_dataset", "scrape", "search_web"],
  upstream: [
    "ask_brightdata_assistant",
    "scrape_as_markdown",
    "scrape_batch",
    "search_engine",
    "search_engine_batch",
  ],
};

const reports = [];
let failed = false;

for (const server of ["bright", "upstream"] as const) {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
  let client: Client | undefined;
  try {
    client = await connect(server);
    const { tools } = await client.listTools();
    const actual = tools.map(({ name }) => name).toSorted();
    record(
      checks,
      "published tool surface has not drifted",
      JSON.stringify(actual) === JSON.stringify(expectedTools[server]),
      `expected ${expectedTools[server].join(", ")}; received ${actual.join(", ")}`,
    );

    const searchName = server === "bright" ? "search_web" : "search_engine";
    const search = tools.find(({ name }) => name === searchName);
    const schema = search?.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    } | undefined;
    const queryProperty = server === "bright" ? "queries" : "query";
    record(checks, "search query is schema-required", schema?.required?.includes(queryProperty) === true);
    record(checks, "search query is schema-declared", queryProperty in (schema?.properties ?? {}));
    record(
      checks,
      "missing search query is rejected",
      await rejects(client, searchName, {}),
    );
  } catch (error) {
    failed = true;
    checks.push({ name: "connect and initialize", ok: false, detail: safeError(error) });
  } finally {
    await client?.close();
  }
  if (checks.some(({ ok }) => !ok)) failed = true;
  reports.push({ server, checks });
}

await writeReport("contracts", {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  mode: "published-remote-servers",
  reports,
});

for (const report of reports) {
  console.log(`\n${serverLabel(report.server)}`);
  for (const check of report.checks) {
    console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}${check.ok ? "" : ` — ${check.detail ?? ""}`}`);
  }
}

if (failed) process.exitCode = 1;

function record(
  checks: Array<{ name: string; ok: boolean; detail?: string }>,
  name: string,
  ok: boolean,
  detail?: string,
) {
  checks.push({ name, ok, ...(ok || !detail ? {} : { detail }) });
}

async function rejects(client: Client, name: string, args: Record<string, unknown>) {
  try {
    const result = await client.callTool({ name, arguments: args });
    return result.isError === true;
  } catch {
    return true;
  }
}
