import { benchmarkProfile, workflowCases } from "./workflows";

const mode = process.argv[2];
if (mode !== "--write" && mode !== "--check") throw new Error("Use --write or --check.");

const projectRoot = new URL("../../", import.meta.url);
const rootReadme = new URL("README.md", projectRoot);
const evalReadme = new URL("evals/README.md", projectRoot);
const report = (await Bun.file(new URL("../.artifacts/agent.json", import.meta.url)).json()) as Report;
const judge = (await Bun.file(new URL("../.artifacts/judge.json", import.meta.url)).json()) as JudgeReport;
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
      "![Paired horizontal bars comparing MCP completion by workflow](./assets/benchmark-completion.png)",
      "![Radar chart comparing blind answer-quality dimensions](./assets/benchmark-radar.png)",
      "![Horizontal bars comparing blind pairwise preference](./assets/benchmark-preference.png)",
      "![Paired horizontal bars comparing judged answer quality per token budget](./assets/benchmark-quality-cost.png)",
      "![Paired horizontal bars comparing benchmark passes per token budget](./assets/benchmark-efficiency.png)",
      "![Cumulative latency distribution across all benchmark runs](./assets/benchmark-latency.png)",
      "![Paired horizontal bars comparing average tool calls by workflow](./assets/benchmark-complexity.png)",
      "",
      `Bright MCP: ${percent(overall.bright.passRate)} pass · ${quality(judge, undefined, "bright").toFixed(2)}/5 judged quality · ${Math.round(overall.bright.averageTokens)} tokens · ${seconds(overall.bright.medianLatency)} p50. BrightData MCP: ${percent(overall.upstream.passRate)} · ${quality(judge, undefined, "upstream").toFixed(2)}/5 · ${Math.round(overall.upstream.averageTokens)} tokens · ${seconds(overall.upstream.medianLatency)} p50.`,
      `Blind preference: Bright MCP ${judgeWins.bright}, BrightData MCP ${judgeWins.upstream}, ties ${judgeWins.ties}. [Method and tables](./evals/README.md#latest-tool-use-benchmark) · current-entitlements Acquire + Operate profile · \`${report.model}\` · ${report.runsPerCase} runs/case · ${report.generatedAt.slice(0, 10)}.`,
    ].join("\n")
  : "> Benchmark publication requires a complete 10-run comparison and at least 75% judge label-swap agreement.";
const evalBlock = [
  publishable ? "" : "> **Incomplete run:** do not use this table for public claims.\n",
  `Profile \`${report.profile}\` · agent \`${report.model}\` · judge \`${judge.model}\` · ${report.runsPerCase} runs/case · ${report.generatedAt.slice(0, 10)}`,
  "",
  "Extract and Research are excluded because general Deep Lookup is unavailable for the benchmark account.",
  "Recurring delivery is excluded because durable scheduling is still a WIP capability.",
  ...(regradedLabels.length
    ? [`${regradedLabels.join(", ")} deterministic results were regraded from stored outputs; agent and judge calls were not rerun.`]
    : []),
  "",
  "| Case | Pass Bright/BrightData | Recovered Bright/BrightData | Quality Bright/BrightData | Tokens Bright/BrightData | p50 latency Bright/BrightData | Calls Bright/BrightData |",
  "|---|---:|---:|---:|---:|---:|---:|",
  ...summaries.map(({ label, bright, upstream, brightQuality, upstreamQuality }) =>
    `| ${label} | ${percent(bright.passRate)} / ${percent(upstream.passRate)} | ${percent(bright.recoveryRate)} / ${percent(upstream.recoveryRate)} | ${brightQuality.toFixed(2)} / ${upstreamQuality.toFixed(2)} | ${Math.round(bright.averageTokens)} / ${Math.round(upstream.averageTokens)} | ${seconds(bright.medianLatency)} / ${seconds(upstream.medianLatency)} | ${bright.averageTools.toFixed(2)} / ${upstream.averageTools.toFixed(2)} |`,
  ),
  "",
  `A pass requires one parseable JSON payload, raw or in a single Markdown fence, with the requested output fields and provenance; brief surrounding text is ignored. Intended workflow selection, successful expected-tool execution, clean execution, and recovered errors remain separate artifact dimensions. Quality is a blind 1–5 average across task fulfillment, evidence grounding, information density, source quality, and actionability. Label-swap agreement for the original four-case judge run: ${percent(judge.sideAgreement)}.`,
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
  model: string;
  agentModel: string;
  agentGeneratedAt: string;
  runsPerCase: number;
  sideAgreement: number;
  judgments: Array<{ pairId: string; scores: Record<"bright" | "upstream", Scores>; winner: "bright" | "upstream" | "tie" }>;
};
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
