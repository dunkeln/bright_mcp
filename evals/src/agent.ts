import { HostRunner, MCPClientManager } from "@mcpjam/sdk";
import { useCases } from "./cases";
import { safeError, serverLabel, type ServerId, writeReport } from "./mcp";

const apiKey = required("OPENROUTER_API_KEY");
const configuredModel = required("OPENROUTER_MODEL");
const model = configuredModel.startsWith("openrouter/")
  ? configuredModel
  : `openrouter/${configuredModel}`;
const runs = integer("EVAL_RUNS", 20, 1, 100);
const selectedCases = process.env.EVAL_CASE
  ? useCases.filter(({ id }) => id === process.env.EVAL_CASE)
  : useCases;
if (selectedCases.length === 0) throw new Error(`Unknown EVAL_CASE: ${process.env.EVAL_CASE}`);

const upstream = new URL("https://mcp.brightdata.com/mcp");
upstream.searchParams.set("token", required("BRIGHTDATA_API_KEY"));
const manager = new MCPClientManager(undefined, { defaultTimeout: 60_000 });

const results: AgentResult[] = [];
try {
  await Promise.all([
    manager.connectToServer("bright", { url: "https://bright-mcp.onrender.com/mcp" }),
    manager.connectToServer("upstream", { url: upstream.toString() }),
  ]);
  const tools = {
    bright: await manager.getToolsForAiSdk("bright"),
    upstream: await manager.getToolsForAiSdk("upstream"),
  };
  const jobs = shuffle(
    selectedCases.flatMap((useCase) =>
      (["bright", "upstream"] as const).flatMap((server) =>
        Array.from({ length: runs }, (_, run) => ({ useCase, server, run: run + 1 })),
      ),
    ),
  );

  for (const [index, job] of jobs.entries()) {
    const runner = new HostRunner({
      tools: tools[job.server],
      model,
      apiKey,
      temperature: 0.1,
      maxSteps: 5,
      mcpClientManager: manager,
    });
    const result = await runner.run(job.useCase.prompt, { timeoutMs: 120_000 });
    const expectedTool = searchTool(job.server);
    const query = result.getToolArguments(expectedTool)?.query;
    const toolSelected = result.hasToolCall(expectedTool);
    const argumentsValid = typeof query === "string" && query.trim().length > 0;
    const responseComplete = result.text.trim().length > 0;
    results.push({
      caseId: job.useCase.id,
      server: job.server,
      run: job.run,
      passed: toolSelected && argumentsValid && responseComplete && !result.hasError(),
      toolSelected,
      argumentsValid,
      responseComplete,
      toolsCalled: result.toolsCalled(),
      inputTokens: result.inputTokens(),
      outputTokens: result.outputTokens(),
      tokenCount: result.totalTokens(),
      latencyMs: result.e2eLatencyMs(),
      llmLatencyMs: result.llmLatencyMs(),
      mcpLatencyMs: result.mcpLatencyMs(),
      ...(result.hasError() ? { error: safeError(result.getError()) } : {}),
    });
    console.log(`${index + 1}/${jobs.length} ${job.useCase.id} ${serverLabel(job.server)}`);
  }
} finally {
  await Promise.allSettled([
    manager.disconnectServer("bright"),
    manager.disconnectServer("upstream"),
  ]);
}

await writeReport("agent", {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  mode: "mcpjam-openrouter-tool-use",
  model,
  runsPerCase: runs,
  providerParity: process.env.EVAL_PROVIDER_PARITY === "live" ? "live" : "demo",
  grading:
    "Pass requires the server's search tool, a non-empty query, a non-empty final response, and no runner error. Factual answer quality is not graded.",
  results,
});

type AgentResult = {
  caseId: string;
  server: ServerId;
  run: number;
  passed: boolean;
  toolSelected: boolean;
  argumentsValid: boolean;
  responseComplete: boolean;
  toolsCalled: string[];
  inputTokens: number;
  outputTokens: number;
  tokenCount: number;
  latencyMs: number;
  llmLatencyMs: number;
  mcpLatencyMs: number;
  error?: string;
};

function searchTool(server: ServerId) {
  return server === "bright" ? "search_web" : "search_engine";
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function integer(name: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function shuffle<T>(values: T[]) {
  return values
    .map((value) => ({ value, order: crypto.getRandomValues(new Uint32Array(1))[0] }))
    .toSorted((left, right) => left.order - right.order)
    .map(({ value }) => value);
}
