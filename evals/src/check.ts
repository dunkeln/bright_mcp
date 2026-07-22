import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { connect, safeError, serverLabel, type ServerId, writeReport } from "./mcp";

const expectedTools: Record<ServerId, string[]> = {
  bright: [
    "discover_web",
    "extract_web",
    "find_datasets",
    "read_web",
    "research_web",
    "run_dataset",
    "search_web",
  ],
  upstream: [
    "ask_brightdata_assistant",
    "scrape_as_markdown",
    "scrape_batch",
    "search_engine",
    "search_engine_batch",
  ],
};

const expectedBrightProfiles = {
  "/mcp/web": ["discover_web", "read_web", "search_web"],
  "/mcp/deep-lookup": ["extract_web", "research_web"],
  "/mcp/marketplace": ["find_datasets", "run_dataset"],
  "/mcp/browser": ["browser_close", "browser_interact", "browser_navigate", "browser_observe"],
} as const;

const reports = [];
let failed = false;
type Check = { name: string; ok: boolean; detail?: string; blocking?: false };

for (const server of ["bright", "upstream"] as const) {
  const checks: Check[] = [];
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
    const incompatibleSchemas = tools
      .filter(({ outputSchema }) => !hasCompatibleDialect(outputSchema))
      .map(({ name }) => name);
    record(
      checks,
      "output schemas use an MCP-compatible dialect",
      incompatibleSchemas.length === 0,
      `incompatible tools: ${incompatibleSchemas.join(", ")}`,
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
    if (server === "bright") {
      for (const [path, expected] of Object.entries(expectedBrightProfiles)) {
        let profile: Client | undefined;
        try {
          profile = await connect("bright", path);
          const actual = (await profile.listTools()).tools.map(({ name }) => name).toSorted();
          record(
            checks,
            `${path} exposes its frozen tool surface`,
            JSON.stringify(actual) === JSON.stringify(expected),
            `expected ${expected.join(", ")}; received ${actual.join(", ")}`,
          );
        } catch (error) {
          record(
            checks,
            `${path} exposes its frozen tool surface`,
            false,
            safeError(error),
            path !== "/mcp/browser",
          );
        } finally {
          await profile?.close();
        }
      }
      await probe(checks, client, "known-URL extraction preview is available", "extract_web", {
        urls: ["https://example.com"],
        fields: [{ name: "title", description: "Page title" }],
        preview: true,
      }, false);
      await probe(checks, client, "intent-ranked source discovery is available", "discover_web", {
        query: "Model Context Protocol specification",
        intent: "Find the primary protocol documentation",
        limit: 3,
        language: "en",
      }, false);
      await probe(checks, client, "open-web research preview is available", "research_web", {
        query: "Find one official source describing the Example Domain.",
        limit: 1,
        preview: true,
      }, false);
      await probe(
        checks,
        client,
        "Amazon product search is discoverable",
        "find_datasets",
        { query: "Amazon product search", limit: 3 },
        true,
        (result) => JSON.stringify(result.structuredContent).includes("gd_lwdb4vjm1ehb499uxs"),
      );
    }
  } catch (error) {
    failed = true;
    checks.push({ name: "connect and initialize", ok: false, detail: safeError(error) });
  } finally {
    await client?.close();
  }
  if (checks.some(({ ok, blocking }) => !ok && blocking !== false)) failed = true;
  reports.push({ server, checks });
}

await writeReport("contracts", {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  mode: "published-remote-servers",
  reports,
});

for (const report of reports) {
  console.log(`\n${serverLabel(report.server)}`);
  for (const check of report.checks) {
    const status = check.ok ? "PASS" : check.blocking === false ? "INFO" : "FAIL";
    console.log(`${status} ${check.name}${check.ok ? "" : ` — ${check.detail ?? ""}`}`);
  }
}

if (failed) process.exitCode = 1;

function record(
  checks: Check[],
  name: string,
  ok: boolean,
  detail?: string,
  blocking = true,
) {
  checks.push({ name, ok, ...(ok || !detail ? {} : { detail }), ...(blocking ? {} : { blocking: false }) });
}

async function rejects(client: Client, name: string, args: Record<string, unknown>) {
  try {
    const result = await client.callTool({ name, arguments: args });
    return result.isError === true;
  } catch {
    return true;
  }
}

async function probe(
  checks: Check[],
  client: Client,
  checkName: string,
  toolName: string,
  args: Record<string, unknown>,
  blocking = true,
  validate: (result: Awaited<ReturnType<Client["callTool"]>>) => boolean = () => true,
) {
  try {
    const result = await client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout: 120_000 },
    );
    const ok = result.isError !== true && validate(result);
    record(
      checks,
      checkName,
      ok,
      ok ? undefined : safeError(JSON.stringify(result.content).slice(0, 500)),
      blocking,
    );
  } catch (error) {
    record(checks, checkName, false, safeError(error), blocking);
  }
}

function hasCompatibleDialect(schema: unknown) {
  if (!schema || typeof schema !== "object") return true;
  const dialect = (schema as Record<string, unknown>)["$schema"];
  return typeof dialect !== "string" ||
    /^https?:\/\/json-schema\.org\/draft\/2020-12\/schema#?$/.test(dialect);
}
