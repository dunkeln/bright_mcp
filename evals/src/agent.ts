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
    const startedAt = performance.now();
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
    ) || called.includes("scrape");
    const argumentsValid = pathArgumentsValid && openedSources;
    const responseComplete = result.text.trim().length > 0;
    const outcomeValid = validatesOutcome(result.text, job.useCase);
    const toolEvidence = result.getToolMessages();
    const successfulTools = successfulToolExecutions(toolEvidence);
    const toolExecutionValid = path.every((choices) =>
      choices.some((tool) => successfulTools.has(tool))
    );
    const toolExecutionClean =
      !result.hasError() && !hasToolExecutionError(toolEvidence);
    const passed =
      toolSelected &&
      argumentsValid &&
      toolExecutionValid &&
      responseComplete &&
      outcomeValid;
    results.push({
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

function hasToolExecutionError(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasToolExecutionError);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.type === "error-text" ||
    record.isError === true ||
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
    const output = record.output as { value?: { isError?: boolean } } | undefined;
    if (output?.value?.isError !== true) tools.add(record.toolName);
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
    model?: string;
    runsPerCase?: number;
    results?: AgentResult[];
  };
  return report.schemaVersion === 4 && report.model === model && report.runsPerCase === runs && Array.isArray(report.results)
    ? report.results
    : [];
}

function resultKey(result: Pick<AgentResult, "caseId" | "server" | "run">) {
  return `${result.caseId}:${result.server}:${result.run}`;
}

async function persist() {
  await writeReport("agent", {
    schemaVersion: 4,
    generatedAt: new Date().toISOString(),
    mode: "mcpjam-openrouter-tool-use",
    model,
    runsPerCase: runs,
    grading:
      "Pass requires a valid tool path, populated arguments, at least one successful execution for each required workflow step, and the required outcome fields and provenance. Recovered tool errors are reported separately. Factual values are not independently graded.",
    results,
  });
}
