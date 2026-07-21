import { HostRunner, MCPClientManager } from "@mcpjam/sdk";
import { safeError, serverLabel, type ServerId, writeReport } from "./mcp";
import { workflowCases } from "./workflows";

const apiKey = required("OPENROUTER_API_KEY");
const configuredModel = required("OPENROUTER_MODEL");
const model = configuredModel.startsWith("openrouter/")
  ? configuredModel
  : `openrouter/${configuredModel}`;
const runs = integer("EVAL_RUNS", 10, 1, 100);
const selectedCases = process.env.EVAL_CASE
  ? workflowCases.filter(({ id }) => id === process.env.EVAL_CASE)
  : workflowCases;
if (selectedCases.length === 0) throw new Error(`Unknown EVAL_CASE: ${process.env.EVAL_CASE}`);

const upstream = new URL("https://mcp.brightdata.com/mcp");
upstream.searchParams.set("token", required("BRIGHTDATA_API_KEY"));
const upstreamEcommerce = new URL(upstream);
upstreamEcommerce.searchParams.set("groups", "ecommerce");
const manager = new MCPClientManager(undefined, { defaultTimeout: 60_000 });

const artifact = Bun.file(new URL("../.artifacts/agent.json", import.meta.url));
const previous = await readPrevious();
const expectedRuns = selectedCases.length * 2 * runs;
const results: AgentResult[] = previous.length === expectedRuns ? [] : previous;
try {
  await Promise.all([
    manager.connectToServer("bright", {
      url: "https://bright-mcp.onrender.com/mcp",
      accessToken: required("BRIGHTDATA_API_KEY"),
    }),
    manager.connectToServer("upstream", { url: upstream.toString() }),
    manager.connectToServer("upstream-ecommerce", { url: upstreamEcommerce.toString() }),
  ]);
  const tools = {
    bright: await manager.getToolsForAiSdk("bright"),
    upstream: await manager.getToolsForAiSdk("upstream"),
    upstreamEcommerce: await manager.getToolsForAiSdk("upstream-ecommerce"),
  };
  const completed = new Set(results.map(resultKey));
  const jobs = shuffle(
    selectedCases.flatMap((useCase) =>
      (["bright", "upstream"] as const).flatMap((server) =>
        Array.from({ length: runs }, (_, run) => ({ useCase, server, run: run + 1 })),
      ),
    ).filter((job) => !completed.has(resultKey({
      caseId: job.useCase.id,
      server: job.server,
      run: job.run,
    }))),
  );

  for (const [index, job] of jobs.entries()) {
    const runner = new HostRunner({
      tools:
        job.server === "upstream" &&
        "upstreamProfile" in job.useCase &&
        job.useCase.upstreamProfile === "ecommerce"
          ? tools.upstreamEcommerce
          : tools[job.server],
      model,
      apiKey,
      temperature: 0.1,
      maxSteps: 5,
      mcpClientManager: manager,
    });
    const result = await runner.run(job.useCase.prompt, { timeoutMs: 120_000 });
    const path = job.useCase.toolPath[job.server];
    const called = result.toolsCalled();
    const toolSelected = followsPath(called, path);
    const pathArgumentsValid = path.every((choices) =>
      choices.some((tool) => {
        const arguments_ = result.getToolArguments(tool);
        return arguments_ && Object.keys(arguments_).length > 0;
      }),
    );
    const openedSources = !(
      job.server === "bright" &&
      "requiresOpenedSources" in job.useCase &&
      job.useCase.requiresOpenedSources
    ) || called.includes("scrape") || contentInclusiveSearch(result.getToolArguments("search_web"));
    const argumentsValid = pathArgumentsValid && openedSources;
    const responseComplete = result.text.trim().length > 0;
    const outcomeValid = validatesOutcome(result.text, job.useCase);
    results.push({
      caseId: job.useCase.id,
      pillar: job.useCase.pillar,
      server: job.server,
      run: job.run,
      passed:
        toolSelected && argumentsValid && responseComplete && outcomeValid && !result.hasError(),
      toolSelected,
      argumentsValid,
      responseComplete,
      outcomeValid,
      toolsCalled: called,
      inputTokens: result.inputTokens(),
      outputTokens: result.outputTokens(),
      tokenCount: result.totalTokens(),
      latencyMs: result.e2eLatencyMs(),
      llmLatencyMs: result.llmLatencyMs(),
      mcpLatencyMs: result.mcpLatencyMs(),
      ...(result.hasError() ? { error: safeError(result.getError()) } : {}),
    });
    await persist();
    console.log(`${index + 1}/${jobs.length} ${job.useCase.id} ${serverLabel(job.server)}`);
  }
} finally {
  await Promise.allSettled([
    manager.disconnectServer("bright"),
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
  responseComplete: boolean;
  outcomeValid: boolean;
  toolsCalled: string[];
  inputTokens: number;
  outputTokens: number;
  tokenCount: number;
  latencyMs: number;
  llmLatencyMs: number;
  mcpLatencyMs: number;
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

function validatesOutcome(
  text: string,
  useCase: (typeof workflowCases)[number],
) {
  const fieldsPresent = useCase.requiredKeys.every((key) =>
    new RegExp(`["']${key}["']\\s*:`, "i").test(text),
  );
  const minimumUrls = "minimumUrls" in useCase ? useCase.minimumUrls : 0;
  const urls = new Set(text.match(/https?:\/\/[^\s"'<>]+/g) ?? []);
  const refusalValid =
    !("mustRefuse" in useCase) ||
    /["']supported["']\s*:\s*false/i.test(text);
  return fieldsPresent && urls.size >= minimumUrls && refusalValid;
}

function contentInclusiveSearch(value: Record<string, unknown> | undefined) {
  return value?.includeContent === true &&
    (value.depth === "ranked" || value.depth === "deep");
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
    model?: string;
    runsPerCase?: number;
    results?: AgentResult[];
  };
  return report.model === model && report.runsPerCase === runs && Array.isArray(report.results)
    ? report.results
    : [];
}

function resultKey(result: Pick<AgentResult, "caseId" | "server" | "run">) {
  return `${result.caseId}:${result.server}:${result.run}`;
}

async function persist() {
  await writeReport("agent", {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: "mcpjam-openrouter-tool-use",
    model,
    runsPerCase: runs,
    grading:
      "Pass requires the case's valid tool path, non-empty tool arguments, required output fields and provenance, and no runner error. Factual values are not independently graded.",
    results,
  });
}
