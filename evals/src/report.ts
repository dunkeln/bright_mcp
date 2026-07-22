import { benchmarkProfile, workflowCases } from "./workflows";

const mode = process.argv[2];
if (mode !== "--write" && mode !== "--check") throw new Error("Use --write or --check.");

const projectRoot = new URL("../../", import.meta.url);
const rootReadme = new URL("README.md", projectRoot);
const evalReadme = new URL("evals/README.md", projectRoot);
const publishedResult = new URL("../results/published-benchmark.json", import.meta.url);
const { report, judge } = mode === "--write"
  ? await publishResult()
  : await readPublishedResult();
validate(report);
validateJudge(judge, report);
const activeCaseIds = new Set<string>(workflowCases.map(({ id }) => id));
const activeResults = report.results.filter(({ caseId }) => activeCaseIds.has(caseId));
const activeJudgments = judge.judgments.filter(({ pairId }) => activeCaseIds.has(pairId.split(":")[0]!));
const regradedLabels = (report.regradedCases ?? []).flatMap((id) => {
  const useCase = workflowCases.find((candidate) => candidate.id === id);
  return useCase ? [useCase.shortLabel] : [];
});

const allSummaries = workflowCases.map((useCase) => ({
  label: `${useCase.pillar} · ${useCase.shortLabel}`,
  bright: summarize(report.results.filter((result) => result.caseId === useCase.id && result.server === "bright")),
  upstream: summarize(report.results.filter((result) => result.caseId === useCase.id && result.server === "upstream")),
  brightQuality: quality(judge, useCase.id, "bright"),
  upstreamQuality: quality(judge, useCase.id, "upstream"),
}));
const summaries = allSummaries.filter(({ bright, upstream }) => bright.runs || upstream.runs);
const overall = {
  bright: summarize(activeResults.filter(({ server }) => server === "bright")),
  upstream: summarize(activeResults.filter(({ server }) => server === "upstream")),
};
const judgeWins = {
  bright: activeJudgments.filter(({ winner }) => winner === "bright").length,
  upstream: activeJudgments.filter(({ winner }) => winner === "upstream").length,
  ties: activeJudgments.filter(({ winner }) => winner === "tie").length,
};
const complete = allSummaries.every(
  ({ bright, upstream }) => bright.runs === report.runsPerCase && upstream.runs === report.runsPerCase,
);
const publishable = complete && report.runsPerCase >= 10 && judge.sideAgreement >= 0.75;
const rootBlock = publishable
  ? [
      "Bright MCP uses `@mcpjam/sdk` to run real-world agent workflows against its",
      "published MCP endpoints. The suite checks task completion, tool selection,",
      "valid arguments, provenance, latency, tool calls, token use, and answer quality.",
      "",
      "![Paired horizontal bars comparing MCP completion by workflow](./assets/benchmark-completion.png)",
      "",
      `*Bright MCP completed ${passCount(activeResults, "bright")} of ${runCount(activeResults, "bright")} workflows; Bright Data MCP completed ${passCount(activeResults, "upstream")} of ${runCount(activeResults, "upstream")}.*`,
      "",
      "![Radar chart comparing blind answer-quality dimensions](./assets/benchmark-radar.png)",
      "",
      "*Blind scoring compares task fulfillment, grounding, information density, source quality, and actionability.*",
      "",
      "![Horizontal bars comparing blind pairwise preference](./assets/benchmark-preference.png)",
      "",
      `*The blind judge preferred Bright MCP ${judgeWins.bright} times versus ${judgeWins.upstream} for Bright Data MCP, with ${judgeWins.ties} ties.*`,
      "",
      "![Paired horizontal bars comparing judged answer quality per token budget](./assets/benchmark-quality-cost.png)",
      "",
      "*Quality per token shows where richer answers repay their context cost.*",
      "",
      "![Paired horizontal bars comparing benchmark passes per token budget](./assets/benchmark-efficiency.png)",
      "",
      "*Passing runs per token compares workflow completion against total model context used.*",
      "",
      "![Paired horizontal bars comparing average tool calls by workflow](./assets/benchmark-complexity.png)",
      "",
      "*Average tool calls show the agent path each workflow required.*",
      "",
      `In the comparative baseline, Bright MCP completed ${passCount(activeResults, "bright")} of ${runCount(activeResults, "bright")} workflows; Bright Data MCP completed ${passCount(activeResults, "upstream")} of ${runCount(activeResults, "upstream")}.`,
      `Bright MCP scored ${quality(judge, undefined, "bright").toFixed(2)}/5 versus ${quality(judge, undefined, "upstream").toFixed(2)}/5 in blind answer-quality grading and was`,
      `preferred in ${judgeWins.bright} runs versus ${judgeWins.upstream}, with ${judgeWins.ties} ties.`,
      "",
      "This study predates the current profile routing and retry changes. Its quality",
      "results remain useful, while its latency, call-count, and token measurements",
      "should be treated as a historical baseline.",
      "",
      "[Method, scenarios, and full results](./evals/README.md#full-tool-use-benchmark-pre-routing-baseline)",
    ].join("\n")
  : "> Benchmark publication requires a complete 10-run comparison and at least 75% judge label-swap agreement.";
const evalBlock = [
  publishable ? "" : "> **Incomplete run:** do not use this table for public claims.\n",
  `Profile \`${report.profile}\` · agent \`${report.model}\` · judge \`${judge.model}\` · ${report.runsPerCase} runs/case · ${report.generatedAt.slice(0, 10)}`,
  "",
  "Extract and Research are excluded because general Deep Lookup is unavailable for the benchmark account.",
  "Recurring delivery is excluded because durable scheduling is still a WIP capability.",
  `Across ${runCount(activeResults, "bright")} matched runs, Bright completed ${passCount(activeResults, "bright")} workflows and Bright Data completed ${passCount(activeResults, "upstream")}. Bright scored ${quality(judge, undefined, "bright").toFixed(2)}/5 versus ${quality(judge, undefined, "upstream").toFixed(2)}/5 and won blind preference ${judgeWins.bright}–${judgeWins.upstream}, with ${judgeWins.ties} ties.`,
  "This full study predates the narrow-profile routing, summary-sufficiency, and retry-ownership fixes. Its quality judgments remain useful; its Current search latency, token, and call-count row is a pre-fix baseline, not a measurement of the current implementation.",
  ...(regradedLabels.length
    ? [`${regradedLabels.join(", ")} deterministic results were regraded from stored outputs; agent and judge calls were not rerun.`]
    : []),
  "",
  "| Case | Pass Bright/BrightData | Recovered Bright/BrightData | Quality Bright/BrightData |",
  "|---|---:|---:|---:|",
  ...summaries.map(({ label, bright, upstream, brightQuality, upstreamQuality }) =>
    `| ${label} | ${percent(bright.passRate)} / ${percent(upstream.passRate)} | ${percent(bright.recoveryRate)} / ${percent(upstream.recoveryRate)} | ${brightQuality.toFixed(2)} / ${upstreamQuality.toFixed(2)} |`,
  ),
  "",
  `A pass requires one parseable JSON payload, raw or in a single Markdown fence, with the requested output fields and provenance; brief surrounding text is ignored. Intended workflow selection, successful expected-tool execution, clean execution, and recovered errors remain separate artifact dimensions. Quality is a blind 1–5 average across task fulfillment, evidence grounding, information density, source quality, and actionability. Label-swap agreement: ${percent(judge.sideAgreement)}.`,
  "",
  "### Pre-fix efficiency diagnostics",
  "",
  "These measurements include model reasoning and tool execution. They diagnose the historical agent path and must not be read as current direct-MCP latency.",
  "",
  "| Case | Tokens Bright/BrightData | Agent p50 (LLM + MCP) Bright/BrightData | Calls Bright/BrightData |",
  "|---|---:|---:|---:|",
  ...summaries.map(({ label, bright, upstream }) =>
    `| ${label} | ${Math.round(bright.averageTokens)} / ${Math.round(upstream.averageTokens)} | ${seconds(bright.medianLatency)} / ${seconds(upstream.medianLatency)} | ${bright.averageTools.toFixed(2)} / ${upstream.averageTools.toFixed(2)} |`,
  ),
].join("\n");

const files = [
  { url: rootReadme, expected: replaceBlock(await Bun.file(rootReadme).text(), rootBlock) },
  { url: evalReadme, expected: replaceBlock(await Bun.file(evalReadme).text(), evalBlock) },
];
if (mode === "--write") {
  for (const file of files) await Bun.write(file.url, file.expected);
  console.log(`Updated ${files.length} benchmark artifacts.`);
} else {
  const stale: string[] = [];
  for (const file of files) {
    if (!(await Bun.file(file.url).exists()) || (await Bun.file(file.url).text()) !== file.expected) {
      stale.push(file.url.pathname);
    }
  }
  if (stale.length) throw new Error(`Generated benchmark files are stale:\n${stale.join("\n")}`);
  console.log("Benchmark artifacts are current.");
}

type Result = {
  caseId: string;
  server: "bright" | "upstream";
  run: number;
  passed: boolean;
  recovered: boolean;
  toolsCalled: string[];
  inputTokens: number;
  outputTokens: number;
  tokenCount: number;
  latencyMs: number;
};
type Report = {
  schemaVersion: number;
  profile: string;
  generatedAt: string;
  model: string;
  runsPerCase: number;
  regradedCases?: string[];
  results: Result[];
};
type Scores = Record<"taskFulfillment" | "evidenceGrounding" | "informationDensity" | "sourceQuality" | "actionability", number>;
type JudgeReport = {
  schemaVersion: number;
  generatedAt: string;
  model: string;
  agentModel: string;
  agentGeneratedAt: string;
  runsPerCase: number;
  sideAgreement: number;
  rubric: Array<keyof Scores>;
  judgments: Array<{ pairId: string; scores: Record<"bright" | "upstream", Scores>; winner: "bright" | "upstream" | "tie" }>;
};

type PublishedResult = {
  schemaVersion: 1;
  report: Report;
  judge: JudgeReport;
};

async function publishResult(): Promise<PublishedResult> {
  const rawReport = (await Bun.file(new URL("../.artifacts/agent.json", import.meta.url)).json()) as Report;
  const rawJudge = (await Bun.file(new URL("../.artifacts/judge.json", import.meta.url)).json()) as JudgeReport;
  validate(rawReport);
  validateJudge(rawJudge, rawReport);
  const value: PublishedResult = {
    schemaVersion: 1,
    report: {
      ...rawReport,
      results: rawReport.results.map((result) => ({
        caseId: result.caseId,
        server: result.server,
        run: result.run,
        passed: result.passed,
        recovered: result.recovered,
        toolsCalled: result.toolsCalled,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        tokenCount: result.tokenCount,
        latencyMs: result.latencyMs,
      })).toSorted((left, right) =>
        left.caseId.localeCompare(right.caseId) ||
        left.server.localeCompare(right.server) ||
        left.run - right.run
      ),
    },
    judge: {
      schemaVersion: rawJudge.schemaVersion,
      generatedAt: rawJudge.generatedAt,
      model: rawJudge.model,
      agentModel: rawJudge.agentModel,
      agentGeneratedAt: rawJudge.agentGeneratedAt,
      runsPerCase: rawJudge.runsPerCase,
      sideAgreement: rawJudge.sideAgreement,
      rubric: rawJudge.rubric,
      judgments: rawJudge.judgments.map(({ pairId, scores, winner }) => ({
        pairId,
        scores,
        winner,
      })).toSorted((left, right) => left.pairId.localeCompare(right.pairId)),
    },
  };
  await Bun.write(publishedResult, `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

async function readPublishedResult(): Promise<PublishedResult> {
  const value = await Bun.file(publishedResult).json() as PublishedResult;
  if (value.schemaVersion !== 1) throw new Error("Invalid published benchmark result.");
  return value;
}
function validate(value: Report) {
  if (
    value.schemaVersion !== 7 ||
    value.profile !== benchmarkProfile ||
    !value.model ||
    !Number.isInteger(value.runsPerCase) ||
    !Array.isArray(value.results)
  ) {
    throw new Error("Invalid agent evaluation report.");
  }
}

function validateJudge(value: JudgeReport, agent: Report) {
  if (
    value.schemaVersion !== 2 ||
    !value.model ||
    value.agentModel !== agent.model ||
    value.agentGeneratedAt !== agent.generatedAt ||
    value.runsPerCase !== agent.runsPerCase ||
    !Array.isArray(value.judgments) ||
    workflowCases.some(({ id }) =>
      value.judgments.filter(({ pairId }) => pairId.startsWith(`${id}:`)).length !== agent.runsPerCase
    )
  ) throw new Error("Invalid or incomplete judge report.");
}

function quality(value: JudgeReport, caseId: string | undefined, server: "bright" | "upstream") {
  const judgments = value.judgments.filter(({ pairId }) =>
    caseId ? pairId.startsWith(`${caseId}:`) : activeCaseIds.has(pairId.split(":")[0]!)
  );
  return average(judgments.flatMap(({ scores }) => Object.values(scores[server])));
}

function summarize(results: Result[]) {
  const runs = results.length;
  return {
    runs,
    passRate: runs ? results.filter(({ passed }) => passed).length / runs : 0,
    recoveryRate: runs ? results.filter(({ recovered }) => recovered).length / runs : 0,
    averageTools: average(results.map(({ toolsCalled }) => toolsCalled.length)),
    averageTokens: average(results.map(({ tokenCount }) => tokenCount)),
    medianLatency: median(results.map(({ latencyMs }) => latencyMs)),
  };
}

function passCount(results: Result[], server: Result["server"]) {
  return results.filter((result) => result.server === server && result.passed).length;
}

function runCount(results: Result[], server: Result["server"]) {
  return results.filter((result) => result.server === server).length;
}

function replaceBlock(markdown: string, content: string) {
  const start = "<!-- benchmark:start -->";
  const end = "<!-- benchmark:end -->";
  const from = markdown.indexOf(start);
  const to = markdown.indexOf(end);
  if (from < 0 || to < from) throw new Error("README benchmark markers are missing or out of order.");
  return `${markdown.slice(0, from + start.length)}\n${content}\n${markdown.slice(to)}`;
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function seconds(milliseconds: number) {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}
