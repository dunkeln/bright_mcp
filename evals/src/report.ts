import { benchmarkProfile, workflowCases } from "./workflows";

const mode = process.argv[2];
if (mode !== "--write" && mode !== "--check") throw new Error("Use --write or --check.");

const projectRoot = new URL("../../", import.meta.url);
const rootReadme = new URL("README.md", projectRoot);
const evalReadme = new URL("evals/README.md", projectRoot);
const publishedResult = new URL("../results/published-benchmark.json", import.meta.url);
const contextGate = await Bun.file(new URL("../results/current-search-gate.json", import.meta.url)).json() as {
  schemaVersion: number;
  runsPerServer: number;
  current: Record<"bright" | "brightData", { averageTokens: number }>;
};
if (contextGate.schemaVersion !== 2) throw new Error("Invalid Current Search context gate.");
const { report, judge } = mode === "--write"
  ? await publishResult()
  : await readPublishedResult();
validate(report);
validateJudge(judge, report);
const { minimum: scoreMinimum, maximum: scoreMaximum } = judge.scale;
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
const currentSearch = allSummaries.find(({ label }) => label.endsWith("Current search"));
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
const publishable = complete && report.runsPerCase >= 5 && judge.sideAgreement >= 0.75;
const testSetup = `**Test setup:** MCPJam HostRunner (\`@mcpjam/sdk\` 2.0.0 on Bun 1.3.14, macOS arm64) gave both MCPs the same five-turn prompts, Bright Data account credential, and \`${report.model}\` agent through OpenRouter at temperature 0.1 for ${report.runsPerCase} runs per workflow. Runs were scheduled as matched pairs, two pairs at a time; calls within each conversation stayed sequential with a 120-second turn timeout. Each agent saw only its MCP's advertised tools and could take its own valid path to the same requested output. \`${judge.model}\` then judged anonymized answers against their tool evidence, with a label-swap check for position bias.`;
const rootBlock = publishable
  ? [
      testSetup,
      "",
      "![Outcome scorecard comparing completion, blind answer quality, and judge preference](./assets/benchmark-outcomes.png)",
      "",
      `Bright MCP completed ${passCount(activeResults, "bright")}/${runCount(activeResults, "bright")} workflows, scored ${quality(judge, undefined, "bright").toFixed(2)}/${scoreMaximum}, and won blind preference ${judgeWins.bright}–${judgeWins.upstream}. In plain English: Bright behaves more like a guided route with typed, bounded handoffs, while the official MCP behaves more like a broad toolbox. The guided route helped this five-turn benchmark; the toolbox remains stronger when an agent needs maximum provider coverage or already knows the exact Bright Data operation.`,
      "",
      "![Radar chart comparing blind answer-quality dimensions](./assets/benchmark-radar.png)",
      "",
      "Bright's structured results and explicit provenance gave the model a cleaner trail from evidence to answer, which likely helped all five judged dimensions. The official MCP still slightly led Known Pages quality, 8.68 to 8.48: its mature Markdown-cleaning path is excellent when the URLs are already known.",
      "",
      "![Horizontal bars comparing blind pairwise preference](./assets/benchmark-preference.png)",
      "",
      `The blind judge preferred Bright MCP ${judgeWins.bright} times versus ${judgeWins.upstream} for the official MCP, with ${judgeWins.ties} ties. Marketplace drove the gap 5–0, where Bright's discover-then-run contract kept the final answer focused. The official MCP won Known Pages 2–1 with 2 ties, showing the value of its simpler direct scraping architecture.`,
      "",
      "![Paired horizontal bars comparing MCP completion by workflow](./assets/benchmark-completion.png)",
      "",
      "Bright owns bounded retries and recovery inside the tool, so one upstream wobble does not automatically become another model decision. The official MCP exposes the provider more directly; that is simpler and efficient when Bright Data responds cleanly, but one Search failure reached the agent in this sample.",
      "",
      "![Paired horizontal bars comparing successful-workflow latency](./assets/benchmark-latency.png)",
      "",
      "The official MCP's direct search-and-scrape route is a real strength: successful Search was slightly faster. Bright's extra boundaries paid off more in Marketplace, while Known Pages tied. Neither architecture makes the upstream network disappear.",
      "",
      "![Paired horizontal bars comparing successful-run token use](./assets/benchmark-efficiency.png)",
      "",
      "The targeted three-run Search rerun measured 80,628 tokens for Bright versus 169,547 for the official MCP. Bright fell 39% from its earlier 131,866-token baseline after readable-page normalization and stronger summary-sufficiency guidance; one run answered from compact search summaries without opening pages. Marketplace retains the published five-run result, where Bright's typed discovery kept the dataset response narrow.",
      "",
      "![Paired horizontal bars comparing average tool calls by workflow](./assets/benchmark-complexity.png)",
      "",
      "Bright batches known URLs, so the agent needed fewer Known Pages calls. The official MCP's dataset-specific tools often reached Marketplace in one call, which is a genuine advantage of exposing more direct product operations. Bright spends an extra discovery call there to keep dataset choice explicit and typed.",
      "",
      "Agent latency, call count, and token use include both model reasoning and MCP",
      "execution; they are workflow measurements, not direct MCP response benchmarks.",
      "",
      "[Method, scenarios, and full results](./evals/README.md#current-tool-use-benchmark)",
    ].join("\n")
  : [
      testSetup,
      "",
      "![Outcome scorecard comparing completion, blind answer quality, and judge preference](./assets/benchmark-outcomes.png)",
      "",
      `**In this five-turn snapshot, Bright MCP leads the product outcomes:** ${passCount(activeResults, "bright")}/${runCount(activeResults, "bright")} completed workflows, ${quality(judge, undefined, "bright").toFixed(2)}/${scoreMaximum} blind quality, and a ${judgeWins.bright}–${judgeWins.upstream} judge preference win. Bright is the guided route: typed outcomes, bounded handoffs, and mechanics handled inside the MCP. The official MCP is the broader toolbox, which is better when coverage and direct provider control matter more than guidance.`,
      "",
      "![Radar chart comparing blind answer-quality dimensions](./assets/benchmark-radar.png)",
      "",
      "Bright's structured evidence and explicit provenance made it easier for the model to build a complete, grounded answer across turns. The official MCP still slightly won Known Pages quality, which fits its strong direct scrape-and-clean architecture.",
      "",
      "![Horizontal bars comparing blind pairwise preference](./assets/benchmark-preference.png)",
      "",
      `The blind judge preferred Bright MCP ${judgeWins.bright} times versus ${judgeWins.upstream} for the official MCP, with ${judgeWins.ties} ties. Bright won Marketplace 5–0; the official MCP won Known Pages 2–1 with 2 ties. That split is useful: Bright's typed workflow helped on multi-step data retrieval, while the official MCP's direct scraper was highly competitive on known URLs.`,
      "",
      "![Paired horizontal bars comparing successful-workflow latency](./assets/benchmark-latency.png)",
      "",
      "Successful Search was effectively tied, with the official MCP slightly ahead; Known Pages tied; Bright led Marketplace. The official MCP benefits from a shorter direct search-and-scrape path, while Bright accepts more internal machinery for recovery, batching, and typed transitions.",
      "",
      "![Paired horizontal bars comparing successful-run token use](./assets/benchmark-efficiency.png)",
      "",
      "The targeted three-run Search rerun measured 80,628 tokens for Bright versus 169,547 for the official MCP. Bright fell 39% from its earlier 131,866-token baseline after readable-page normalization and stronger summary-sufficiency guidance; one run answered from compact summaries without opening pages. Search uses the new regression result, while the other rows retain the published five-run snapshot.",
      "",
      `> Provisional: ${percent(judge.sideAgreement)} label-swap agreement is below the 75% publication gate. The Search context rerun had three pairs and no judge calls, so treat it as a regression signal rather than a stable production estimate.`,
      "",
      "[Evaluation design and provisional results](./evals/README.md#current-tool-use-benchmark)",
    ].join("\n");
const evalBlock = [
  publishable ? "" : "> **Provisional five-run snapshot:** the direction favors Bright MCP; rerun the judge before final publication.\n",
  `Profile \`${report.profile}\` · agent \`${report.model}\` · judge \`${judge.model}\` · ${report.runsPerCase} runs/case · ${report.generatedAt.slice(0, 10)}`,
  "",
  testSetup,
  "Search and Known Pages compared Bright's Web profile with the official default surface; Marketplace compared Bright's Marketplace profile with the official ecommerce tool group. Tool sequences were not forced to match because the surface design is part of the comparison; each side received its declared path length plus two recovery steps.",
  "",
  "Extract and Research are excluded because general Deep Lookup is unavailable for the benchmark account.",
  "Recurring delivery is excluded because durable scheduling is still a WIP capability.",
  `Across ${runCount(activeResults, "bright")} matched runs, Bright completed ${passCount(activeResults, "bright")} workflows and Bright Data completed ${passCount(activeResults, "upstream")}. Bright scored ${quality(judge, undefined, "bright").toFixed(2)}/${scoreMaximum} versus ${quality(judge, undefined, "upstream").toFixed(2)}/${scoreMaximum} and won blind preference ${judgeWins.bright}–${judgeWins.upstream}, with ${judgeWins.ties} ties.`,
  ...(regradedLabels.length
    ? [`${regradedLabels.join(", ")} deterministic results were regraded from stored outputs; agent and judge calls were not rerun.`]
    : []),
  "",
  "| Case | Pass: Bright / Official | Recovered: Bright / Official | Quality: Bright / Official |",
  "|---|---:|---:|---:|",
  ...summaries.map(({ label, bright, upstream, brightQuality, upstreamQuality }) =>
    `| ${label} | ${percent(bright.passRate)} / ${percent(upstream.passRate)} | ${percent(bright.recoveryRate)} / ${percent(upstream.recoveryRate)} | ${brightQuality.toFixed(2)} / ${upstreamQuality.toFixed(2)} |`,
  ),
  "",
  `A pass requires one parseable JSON payload, raw or in a single Markdown fence, with the requested output fields and provenance; brief surrounding text is ignored. Intended workflow selection, successful expected-tool execution, clean execution, and recovered errors remain separate artifact dimensions. Quality is a blind ${scoreMinimum}–${scoreMaximum} integer average across task fulfillment, evidence grounding, information density, source quality, and actionability. Label-swap agreement: ${percent(judge.sideAgreement)}.`,
  "",
  "![Outcome scorecard comparing completion, blind answer quality, and judge preference](../assets/benchmark-outcomes.png)",
  "",
  "Bright's smaller, intent-shaped surface works like guardrails: the model sees the decisions it must make, while retries, polling, and result shaping stay inside the MCP. That helped completion and answer quality here. The official MCP's broader direct surface is more flexible and can be better for expert agents that already understand Bright Data's product map.",
  "",
  "![Paired horizontal bars comparing workflow completion](../assets/benchmark-completion.png)",
  "",
  "Bright completed every Search run because bounded recovery stayed inside the tool. The official MCP's thinner Search path is easier to understand and cheaper when it succeeds, but it lets more upstream behavior reach the model; one such run failed here. Both MCPs were equally reliable on Known Pages and Marketplace.",
  "",
  "### MCP efficiency diagnostics",
  "",
  "These measurements include model reasoning and tool execution. Tokens, latency, and calls use successful runs only; failed runs remain in completion rate and are never counted as fast or cheap successes. These describe the observed agent path and must not be read as direct-MCP latency.",
  "",
  "| Case | Successful runs: Bright / Official | Tokens/success¹: Bright / Official | Successful agent p50: Bright / Official | Calls/success: Bright / Official |",
  "|---|---:|---:|---:|---:|",
  ...summaries.map(({ label, bright, upstream }) => {
    const tokens = label.endsWith("Current search")
      ? `${contextGate.current.bright.averageTokens.toLocaleString("en-US")} / ${contextGate.current.brightData.averageTokens.toLocaleString("en-US")}`
      : `${Math.round(bright.averageTokens).toLocaleString("en-US")} / ${Math.round(upstream.averageTokens).toLocaleString("en-US")}`;
    return `| ${label} | ${bright.successfulRuns}/${bright.runs} / ${upstream.successfulRuns}/${upstream.runs} | ${tokens} | ${seconds(bright.medianLatency)} / ${seconds(upstream.medianLatency)} | ${bright.averageTools.toFixed(2)} / ${upstream.averageTools.toFixed(2)} |`;
  }),
  "",
  `¹ Current Search tokens use the targeted ${contextGate.runsPerServer}-pair rerun shown below; that row's success, latency, and call columns retain the published five-run benchmark. Other token rows also retain the five-run benchmark.`,
  ...(currentSearch
    ? ["", `For Current Search successful runs, mean latency was ${seconds(currentSearch.bright.averageLatency)} for Bright MCP versus ${seconds(currentSearch.upstream.averageLatency)} for Bright Data MCP; p50 was ${seconds(currentSearch.bright.medianLatency)} versus ${seconds(currentSearch.upstream.medianLatency)}. With ${currentSearch.bright.successfulRuns} versus ${currentSearch.upstream.successfulRuns} successful samples, neither statistic establishes latency superiority.`]
    : []),
  "",
  "![Paired horizontal bars comparing successful-workflow latency](../assets/benchmark-latency.png)",
  "",
  "The official MCP was slightly faster on successful Search, which matches its shorter direct search-and-scrape route. Known Pages tied, and Bright was faster on Marketplace despite using an extra discovery step. The main lesson is not that one stack is always faster; each architecture wins on a different path.",
  "",
  "![Paired horizontal bars comparing successful-run token use](../assets/benchmark-efficiency.png)",
  "",
  "The targeted three-run Search rerun measured 80,628 tokens for Bright versus 169,547 for the official MCP. Bright's context fell 39% from its earlier 131,866-token baseline after readable-page normalization and stronger summary-sufficiency guidance; one run answered from compact summaries without opening pages. The sample is a regression signal, not a stable production estimate. Other rows retain the published five-run snapshot.",
  "",
  "![Paired horizontal bars comparing successful-run tool calls](../assets/benchmark-complexity.png)",
  "",
  "Bright won Known Pages calls by accepting several URLs in one typed batch. The official MCP won Marketplace calls because its broader, dataset-specific surface can jump straight to an operation. Bright deliberately spends one call on discovery so the model chooses from a typed catalog instead of guessing a provider tool.",
  "",
  "### Judged answer quality",
  "",
  `The blind judge favored Bright MCP in aggregate preference and across all five quality dimensions. Label-swap agreement was ${percent(judge.sideAgreement)}, below the 75% publication gate, so rerun before treating the magnitude as final.`,
  "",
  "![Radar chart comparing blind answer-quality dimensions](../assets/benchmark-radar.png)",
  "",
  "Bright's bounded, structured handoffs likely made evidence easier to carry across five turns, so it led every aggregate quality dimension. The exception worth preserving is Known Pages: the official MCP scored slightly higher there, evidence that its direct Markdown scraper is already well-shaped for simple reading jobs.",
  "",
  "![Horizontal bars comparing blind pairwise preference](../assets/benchmark-preference.png)",
  "",
  "The 9–4 result was not uniform. Bright won Marketplace 5–0 and Search 3–2; the official MCP won Known Pages 2–1, with 2 ties. That is the architectural split in one picture: Bright helps most when a workflow needs discovery and controlled transitions, while the official MCP shines when a mature direct tool already matches the job.",
  "",
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
  scale: { minimum: 0; maximum: 10 };
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
      scale: rawJudge.scale,
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
    value.schemaVersion !== 3 ||
    !value.model ||
    value.agentModel !== agent.model ||
    value.agentGeneratedAt !== agent.generatedAt ||
    value.runsPerCase !== agent.runsPerCase ||
    !Array.isArray(value.judgments) ||
    value.scale?.minimum !== 0 ||
    value.scale.maximum !== 10 ||
    value.judgments.some(({ scores }) => Object.values(scores).some((dimensions) =>
      Object.values(dimensions).some((score) => !Number.isInteger(score) || score < value.scale.minimum || score > value.scale.maximum)
    )) ||
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
  const successful = results.filter(({ passed }) => passed);
  return {
    runs,
    successfulRuns: successful.length,
    passRate: runs ? successful.length / runs : 0,
    recoveryRate: runs ? results.filter(({ recovered }) => recovered).length / runs : 0,
    averageTools: average(successful.map(({ toolsCalled }) => toolsCalled.length)),
    averageTokens: average(successful.map(({ tokenCount }) => tokenCount)),
    averageLatency: average(successful.map(({ latencyMs }) => latencyMs)),
    medianLatency: median(successful.map(({ latencyMs }) => latencyMs)),
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
