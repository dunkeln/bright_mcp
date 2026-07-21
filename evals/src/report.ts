import { workflowCases } from "./workflows";

const mode = process.argv[2];
if (mode !== "--write" && mode !== "--check") throw new Error("Use --write or --check.");

const projectRoot = new URL("../../", import.meta.url);
const rootReadme = new URL("README.md", projectRoot);
const evalReadme = new URL("evals/README.md", projectRoot);
const report = (await Bun.file(new URL("../.artifacts/agent.json", import.meta.url)).json()) as Report;
validate(report);

const allSummaries = workflowCases.map((useCase) => ({
  label: `${useCase.pillar} · ${useCase.shortLabel}`,
  bright: summarize(report.results.filter((result) => result.caseId === useCase.id && result.server === "bright")),
  upstream: summarize(report.results.filter((result) => result.caseId === useCase.id && result.server === "upstream")),
}));
const summaries = allSummaries.filter(({ bright, upstream }) => bright.runs || upstream.runs);
const overall = {
  bright: summarize(report.results.filter(({ server }) => server === "bright")),
  upstream: summarize(report.results.filter(({ server }) => server === "upstream")),
};
const complete = allSummaries.every(
  ({ bright, upstream }) => bright.runs === report.runsPerCase && upstream.runs === report.runsPerCase,
);
const publishable = complete && report.runsPerCase >= 10;
const rootBlock = publishable
  ? [
      "![Dumbbell chart comparing MCP completion by workflow](./assets/benchmark-completion.png)",
      "![Scatter plot comparing completion and token cost](./assets/benchmark-efficiency.png)",
      "![Cumulative latency distribution across all benchmark runs](./assets/benchmark-latency.png)",
      "![Dumbbell chart comparing average tool calls by workflow](./assets/benchmark-complexity.png)",
      "",
      `Bright MCP: ${percent(overall.bright.passRate)} pass · ${Math.round(overall.bright.averageTokens)} tokens · ${seconds(overall.bright.medianLatency)} p50. BrightData MCP: ${percent(overall.upstream.passRate)} · ${Math.round(overall.upstream.averageTokens)} tokens · ${seconds(overall.upstream.medianLatency)} p50.`,
      `[Method and tables](./evals/README.md#latest-tool-use-benchmark) · \`${report.model}\` · ${report.runsPerCase} runs/case · ${report.generatedAt.slice(0, 10)}.`,
    ].join("\n")
  : "> Benchmark publication requires a complete 10-run comparison across both live MCPs.";
const evalBlock = [
  publishable ? "" : "> **Incomplete run:** do not use this table for public claims.\n",
  `\`${report.model}\` · ${report.runsPerCase} runs/case · ${report.generatedAt.slice(0, 10)}`,
  "",
  "| Case | Pass Bright/BrightData | Tokens Bright/BrightData | p50 latency Bright/BrightData | Calls Bright/BrightData |",
  "|---|---:|---:|---:|---:|",
  ...summaries.map(({ label, bright, upstream }) =>
    `| ${label} | ${percent(bright.passRate)} / ${percent(upstream.passRate)} | ${Math.round(bright.averageTokens)} / ${Math.round(upstream.averageTokens)} | ${seconds(bright.medianLatency)} / ${seconds(upstream.medianLatency)} | ${bright.averageTools.toFixed(2)} / ${upstream.averageTools.toFixed(2)} |`,
  ),
  "",
  "A pass requires a valid workflow tool path, populated arguments, the requested output fields and provenance, and no runner error. Factual values are not independently graded.",
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
  toolsCalled: string[];
  inputTokens: number;
  outputTokens: number;
  tokenCount: number;
  latencyMs: number;
  llmLatencyMs: number;
  mcpLatencyMs: number;
};
type Report = {
  schemaVersion: number;
  generatedAt: string;
  model: string;
  runsPerCase: number;
  results: Result[];
};
function validate(value: Report) {
  if (
    value.schemaVersion !== 1 ||
    !value.model ||
    !Number.isInteger(value.runsPerCase) ||
    !Array.isArray(value.results)
  ) {
    throw new Error("Invalid agent evaluation report.");
  }
}

function summarize(results: Result[]) {
  const runs = results.length;
  return {
    runs,
    passRate: runs ? results.filter(({ passed }) => passed).length / runs : 0,
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
