import { HostRunner, MCPClientManager } from "@mcpjam/sdk";
import { validatesOutcome } from "./grading";
import { safeError, serverLabel, type ServerId, writeReport } from "./mcp";
import { benchmarkProfile, workflowCases } from "./workflows";

const apiKey = required("OPENROUTER_API_KEY");
const configuredModel = required("OPENROUTER_MODEL");
const model = configuredModel.startsWith("openrouter/")
  ? configuredModel
  : `openrouter/${configuredModel}`;
const runs = integer("EVAL_RUNS", 10, 1, 100);
const concurrency = integer("EVAL_CONCURRENCY", 4, 2, 20);
const artifactName = process.env.EVAL_ARTIFACT?.trim() || "agent";
if (!/^[a-z0-9-]+$/.test(artifactName)) throw new Error("EVAL_ARTIFACT must contain only lowercase letters, numbers, and hyphens.");
if (concurrency % 2) throw new Error("EVAL_CONCURRENCY must be even so Bright/BrightData runs stay paired.");
const selectedCases = process.env.EVAL_CASE
  ? workflowCases.filter(({ id }) => id === process.env.EVAL_CASE)
  : workflowCases;
if (selectedCases.length === 0) throw new Error(`Unknown EVAL_CASE: ${process.env.EVAL_CASE}`);

const upstream = new URL("https://mcp.brightdata.com/mcp");
upstream.searchParams.set("token", required("BRIGHTDATA_API_KEY"));
const upstreamEcommerce = new URL(upstream);
upstreamEcommerce.searchParams.set("groups", "ecommerce");
const manager = new MCPClientManager(undefined, { defaultTimeout: 60_000 });

const artifact = Bun.file(new URL(`../.artifacts/${artifactName}.json`, import.meta.url));
const previous = (await readPrevious()).filter((result) =>
  selectedCases.some(({ id }) => id === result.caseId)
);
const expectedRuns = selectedCases.length * 2 * runs;
const results: AgentResult[] = previous.length === expectedRuns ? [] : previous;
try {
  await Promise.all([
    ...(["web", "marketplace"] as const).map((profile) => manager.connectToServer(`bright-${profile}`, {
      url: new URL(`/mcp/${profile}`, process.env.BRIGHT_MCP_URL?.trim() || "https://bright-mcp.onrender.com").href,
      accessToken: required("BRIGHTDATA_API_KEY"),
    })),
    manager.connectToServer("upstream", { url: upstream.toString() }),
    manager.connectToServer("upstream-ecommerce", { url: upstreamEcommerce.toString() }),
  ]);
  const tools = {
    brightWeb: await manager.getToolsForAiSdk("bright-web"),
    brightMarketplace: await manager.getToolsForAiSdk("bright-marketplace"),
    upstream: await manager.getToolsForAiSdk("upstream"),
    upstreamEcommerce: await manager.getToolsForAiSdk("upstream-ecommerce"),
  };
  const completed = new Set(results.map(resultKey));
  const pendingPairs = shuffle(
    selectedCases.flatMap((useCase) =>
      Array.from({ length: runs }, (_, run) => ({
        jobs: (["bright", "upstream"] as const)
          .map((server) => ({ useCase, server, run: run + 1 }))
          .filter((job) => !completed.has(resultKey({
            caseId: job.useCase.id,
            server: job.server,
            run: job.run,
          }))),
      })),
    ).filter(({ jobs }) => jobs.length),
  );
  const jobCount = pendingPairs.reduce((count, pair) => count + pair.jobs.length, 0);
  type Job = (typeof pendingPairs)[number]["jobs"][number];

  const evaluate = async (job: Job): Promise<AgentResult> => {
    const runner = new HostRunner({
      tools: job.server === "bright"
        ? job.useCase.brightProfile === "web" ? tools.brightWeb : tools.brightMarketplace
        : "upstreamProfile" in job.useCase && job.useCase.upstreamProfile === "ecommerce"
          ? tools.upstreamEcommerce
          : tools.upstream,
      model,
      apiKey,
      temperature: 0.1,
      maxSteps: job.useCase.toolPath[job.server].length + 2,
      mcpClientManager: manager,
    });
    const startedAt = performance.now();
    const result = await runner.run(job.useCase.prompt, { timeoutMs: 120_000 });
    const path = job.useCase.toolPath[job.server];
    const called = result.toolsCalled();
    const toolSelected = followsPath(called, path);
    const responseComplete = result.text.trim().length > 0;
    const outcomeValid = validatesOutcome(result.text, job.useCase);
    const toolEvidence = result.getToolMessages();
    const successfulTools = successfulToolExecutions(toolEvidence);
    const toolExecutionValid = path.every((choices) =>
      choices.some((tool) => successfulTools.has(tool))
    );
    const argumentsValid = toolExecutionValid;
    const toolExecutionClean =
      !result.hasError() && !hasToolExecutionError(toolEvidence);
    const passed = responseComplete && outcomeValid;
    return {
      caseId: job.useCase.id,
      pillar: job.useCase.pillar,
      server: job.server,
      run: job.run,
      passed,
      toolSelected,
      argumentsValid,
      toolExecutionValid,
      toolExecutionClean,
      recovered: passed && !toolExecutionClean,
      responseComplete,
      outcomeValid,
      toolsCalled: called,
      inputTokens: result.inputTokens(),
      outputTokens: result.outputTokens(),
      tokenCount: result.totalTokens(),
      latencyMs: Math.round(performance.now() - startedAt),
      response: result.text,
      toolCalls: result.getToolCalls(),
      toolEvidence,
      ...(result.hasError()
        ? { error: safeError(result.getError()) }
        : toolExecutionClean || passed
          ? {}
          : { error: "MCP tool execution failed." }),
    };
  };

  let finished = 0;
  for (let index = 0; index < pendingPairs.length; index += concurrency / 2) {
    const batch = pendingPairs
      .slice(index, index + concurrency / 2)
      .flatMap(({ jobs }) => jobs);
    const batchResults = await Promise.all(batch.map(evaluate));
    results.push(...batchResults);
    await persist();
    for (const result of batchResults) {
      console.log(`${++finished}/${jobCount} ${result.caseId} ${serverLabel(result.server)}`);
    }
  }
} finally {
  await Promise.allSettled([
    manager.disconnectServer("bright-web"),
    manager.disconnectServer("bright-marketplace"),
    manager.disconnectServer("upstream"),
    manager.disconnectServer("upstream-ecommerce"),
  ]);
}

await persist();

type AgentResult = {
  caseId: string;
  pillar: string;
  server: ServerId;
  run: number;
  passed: boolean;
  toolSelected: boolean;
  argumentsValid: boolean;
  toolExecutionValid: boolean;
  toolExecutionClean: boolean;
  recovered: boolean;
  responseComplete: boolean;
  outcomeValid: boolean;
  toolsCalled: string[];
  inputTokens: number;
  outputTokens: number;
  tokenCount: number;
  latencyMs: number;
  response: string;
  toolCalls: unknown[];
  toolEvidence: unknown[];
  error?: string;
};

function followsPath(called: string[], path: readonly (readonly string[])[]) {
  let position = 0;
  return path.every((choices) => {
    const found = called.findIndex(
      (tool, index) => index >= position && choices.includes(tool),
    );
    if (found < 0) return false;
    position = found + 1;
    return true;
  });
}

function hasToolExecutionError(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasToolExecutionError);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.type === "error-text" ||
    record.isError === true ||
    (typeof record.content === "string" && /^this endpoint is not supported[.!]?$/i.test(record.content.trim())) ||
    ("error" in record && record.error !== undefined) ||
    Object.values(record).some(hasToolExecutionError);
}

function successfulToolExecutions(value: unknown, tools = new Set<string>()) {
  if (Array.isArray(value)) {
    value.forEach((item) => successfulToolExecutions(item, tools));
    return tools;
  }
  if (!value || typeof value !== "object") return tools;
  const record = value as Record<string, unknown>;
  if (record.type === "tool-result" && typeof record.toolName === "string") {
    if (!hasToolExecutionError(record.output)) tools.add(record.toolName);
  }
  Object.values(record).forEach((item) => successfulToolExecutions(item, tools));
  return tools;
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

async function readPrevious(): Promise<AgentResult[]> {
  if (!(await artifact.exists())) return [];
  const report = await artifact.json() as {
    schemaVersion?: number;
    profile?: string;
    model?: string;
    runsPerCase?: number;
    results?: AgentResult[];
  };
  return report.schemaVersion === 7 && report.profile === benchmarkProfile && report.model === model && report.runsPerCase === runs && Array.isArray(report.results)
    ? report.results
    : [];
}

function resultKey(result: Pick<AgentResult, "caseId" | "server" | "run">) {
  return `${result.caseId}:${result.server}:${result.run}`;
}

async function persist() {
  await writeReport(artifactName, {
    schemaVersion: 7,
    generatedAt: new Date().toISOString(),
    mode: "mcpjam-openrouter-tool-use",
    profile: benchmarkProfile,
    model,
    runsPerCase: runs,
    grading:
      "End-to-end pass requires a complete response with the required outcome fields and provenance. Intended tool selection, valid execution of each expected workflow step, clean execution, and recovery are reported as separate dimensions. Factual values are not independently graded.",
    results,
  });
}
