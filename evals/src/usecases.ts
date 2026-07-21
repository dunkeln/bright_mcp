import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { useCases } from "./cases";
import { connect, safeError, type ServerId, writeReport } from "./mcp";

const MAX_RESULT_BYTES = 2_000_000;
const results = [];
let failed = false;

for (const useCase of useCases) {
  for (const server of ["bright", "upstream"] as const) {
    let client: Client | undefined;
    const started = performance.now();
    try {
      client = await connect(server);
      const result = await client.callTool({
        name: searchTool(server),
        arguments: { query: useCase.prompt },
      });
      const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
      const ok =
        result.isError !== true &&
        Array.isArray(result.content) &&
        result.content.length > 0 &&
        bytes <= MAX_RESULT_BYTES;
      if (!ok) failed = true;
      results.push({
        caseId: useCase.id,
        prompt: useCase.prompt,
        server,
        tool: searchTool(server),
        ok,
        durationMs: Math.round(performance.now() - started),
        resultBytes: bytes,
        ...(result.isError ? { error: "tool returned an MCP error" } : {}),
        ...(bytes > MAX_RESULT_BYTES ? { error: `result exceeded ${MAX_RESULT_BYTES} bytes` } : {}),
      });
    } catch (error) {
      failed = true;
      results.push({
        caseId: useCase.id,
        prompt: useCase.prompt,
        server,
        tool: searchTool(server),
        ok: false,
        durationMs: Math.round(performance.now() - started),
        resultBytes: 0,
        error: safeError(error),
      });
    } finally {
      await client?.close();
    }
  }
}

await writeReport("usecases", {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  mode: "published-remote-servers",
  source: "https://github.com/brightdata/brightdata-mcp#example-queries-that-just-work",
  ceiling: "Execution viability only; live-result correctness and agent selection require statistical grading.",
  results,
});

console.table(
  results.map(({ caseId, server, ok, durationMs, resultBytes }) => ({
    case: caseId,
    server,
    status: ok ? "PASS" : "FAIL",
    durationMs,
    resultBytes,
  })),
);

if (failed) process.exitCode = 1;

function searchTool(server: ServerId) {
  return server === "bright" ? "search_web" : "search_engine";
}
