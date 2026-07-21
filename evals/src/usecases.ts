import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { useCases } from "./cases";
import { connect, safeError, serverLabel, type ServerId, writeReport } from "./mcp";

const MAX_RESULT_BYTES = 2_000_000;
type UseCaseResult = {
  caseId: string;
  prompt: string;
  server: ServerId;
  tool: string;
  ok: boolean;
  durationMs: number;
  resultBytes: number;
  error?: string;
};

const artifact = Bun.file(new URL("../.artifacts/usecases.json", import.meta.url));
const previous = await readPrevious();
const expectedRuns = useCases.length * 2;
const results: UseCaseResult[] = previous.length === expectedRuns && previous.every(({ ok }) => ok)
  ? []
  : previous.filter(({ ok }) => ok);
let failed = false;

for (const useCase of useCases) {
  for (const server of ["bright", "upstream"] as const) {
    if (results.some(({ caseId, server: completedServer }) =>
      caseId === useCase.id && completedServer === server)) continue;
    let client: Client | undefined;
    const started = performance.now();
    try {
      client = await connect(server);
      const result = await client.callTool({
        name: searchTool(server),
        arguments: server === "bright"
          ? { queries: [{ query: useCase.prompt }] }
          : { query: useCase.prompt },
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
      await persist();
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
      await persist();
    } finally {
      await client?.close();
    }
  }
}

await persist();

console.table(
  results.map(({ caseId, server, ok, durationMs, resultBytes }) => ({
    case: caseId,
    server: serverLabel(server),
    status: ok ? "PASS" : "FAIL",
    durationMs,
    resultBytes,
  })),
);

if (failed) process.exitCode = 1;

function searchTool(server: ServerId) {
  return server === "bright" ? "search_web" : "search_engine";
}

async function readPrevious(): Promise<UseCaseResult[]> {
  if (!(await artifact.exists())) return [];
  const report = await artifact.json() as { results?: UseCaseResult[] };
  return Array.isArray(report.results) ? report.results : [];
}

async function persist() {
  await writeReport("usecases", {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: "published-remote-servers",
    source: "https://github.com/brightdata/brightdata-mcp#example-queries-that-just-work",
    ceiling: "Execution viability only; live-result correctness and agent selection require statistical grading.",
    results,
  });
}
