import { useCases } from "./cases";

const mode = process.argv[2];
if (mode !== "--write" && mode !== "--check") throw new Error("Use --write or --check.");

const projectRoot = new URL("../../", import.meta.url);
const rootReadme = new URL("README.md", projectRoot);
const evalReadme = new URL("evals/README.md", projectRoot);
const chart = new URL("assets/benchmark.svg", projectRoot);
const report = (await Bun.file(new URL("../.artifacts/agent.json", import.meta.url)).json()) as Report;
validate(report);

const allSummaries = useCases.map((useCase) => ({
  label: title(useCase.id),
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
const publishable = report.providerParity === "live" && complete;
const rootBlock = publishable
  ? [
      "![Dithered forest plot comparing MCP tool-use completion](./assets/benchmark.svg)",
      "",
      `Bright MCP: ${percent(overall.bright.passRate)} pass · ${Math.round(overall.bright.averageTokens)} tokens · ${seconds(overall.bright.medianLatency)} p50. Upstream: ${percent(overall.upstream.passRate)} · ${Math.round(overall.upstream.averageTokens)} tokens · ${seconds(overall.upstream.medianLatency)} p50.`,
      `[Method and tables](./evals/README.md#latest-tool-use-benchmark) · \`${report.model}\` · ${report.runsPerCase} runs/case · ${report.generatedAt.slice(0, 10)}.`,
    ].join("\n")
  : "> Benchmark publication is blocked while the Bright MCP endpoint uses its demo provider.";
const evalBlock = [
  publishable ? "" : "> **Internal dry run:** provider parity is not live; do not use this table for public claims.\n",
  `\`${report.model}\` · ${report.runsPerCase} runs/case · ${report.generatedAt.slice(0, 10)}`,
  "",
  "| Case | Pass B/U | Tokens B/U | p50 latency B/U | Calls B/U |",
  "|---|---:|---:|---:|---:|",
  ...summaries.map(({ label, bright, upstream }) =>
    `| ${label} | ${percent(bright.passRate)} / ${percent(upstream.passRate)} | ${Math.round(bright.averageTokens)} / ${Math.round(upstream.averageTokens)} | ${seconds(bright.medianLatency)} / ${seconds(upstream.medianLatency)} | ${bright.averageTools.toFixed(2)} / ${upstream.averageTools.toFixed(2)} |`,
  ),
  "",
  "B/U = Bright MCP/upstream. A pass requires the intended search tool, a non-empty query and response, and no runner error; factual answer quality is not graded.",
].join("\n");

const files = [
  { url: rootReadme, expected: replaceBlock(await Bun.file(rootReadme).text(), rootBlock) },
  { url: evalReadme, expected: replaceBlock(await Bun.file(evalReadme).text(), evalBlock) },
];
if (publishable) files.push({ url: chart, expected: renderChart(summaries, report) });

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
  providerParity: "demo" | "live";
  results: Result[];
};
type Summary = ReturnType<typeof summarize>;

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

function renderChart(
  summaries: Array<{ label: string; bright: Summary; upstream: Summary }>,
  report: Report,
) {
  const width = 1200;
  const height = 190 + summaries.length * 86;
  const left = 300;
  const right = 1080;
  const x = (value: number) => left + ((value + 1) / 2) * (right - left);
  const rows = summaries.map(({ label, bright, upstream }, index) => {
    const difference = bright.passRate - upstream.passRate;
    const interval = differenceInterval(bright, upstream);
    const y = 150 + index * 86;
    return `<text x="40" y="${y + 6}" class="label">${escapeXml(label)}</text>
    <line x1="${x(interval.low)}" x2="${x(interval.high)}" y1="${y}" y2="${y}" class="interval"/>
    <circle cx="${x(difference)}" cy="${y}" r="11" fill="url(#dither)"/>
    <text x="1110" y="${y + 6}" class="value">${signed(difference)}</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">Bright MCP versus upstream tool-use completion</title>
  <desc id="desc">Forest plot of pass-rate differences with conservative 95 percent intervals.</desc>
  <defs>
    <pattern id="dither" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="3" height="3" fill="#55e7e7"/><rect x="3" y="3" width="3" height="3" fill="#55e7e7"/></pattern>
    <style>.title{fill:#f4f4f4;font:600 26px Inter,Arial}.meta,.axis,.value{fill:#aaa;font:14px ui-monospace,SFMono-Regular,monospace}.label{fill:#ddd;font:16px Inter,Arial}.grid{stroke:#ffffff18}.zero{stroke:#ffffff55}.interval{stroke:#8da8c7;stroke-width:4;stroke-linecap:round}</style>
  </defs>
  <rect width="100%" height="100%" rx="18" fill="#141414"/>
  <text x="40" y="48" class="title">Tool-use completion advantage</text>
  <text x="40" y="78" class="meta">${escapeXml(report.model)} · ${report.runsPerCase} runs per case</text>
  <line x1="${x(-1)}" x2="${x(-1)}" y1="110" y2="${height - 48}" class="grid"/><line x1="${x(0)}" x2="${x(0)}" y1="110" y2="${height - 48}" class="zero"/><line x1="${x(1)}" x2="${x(1)}" y1="110" y2="${height - 48}" class="grid"/>
  <text x="${x(-1)}" y="106" text-anchor="middle" class="axis">upstream</text><text x="${x(0)}" y="106" text-anchor="middle" class="axis">equal</text><text x="${x(1)}" y="106" text-anchor="middle" class="axis">Bright MCP</text>
  ${rows.join("\n  ")}
</svg>\n`;
}

function differenceInterval(bright: Summary, upstream: Summary) {
  const a = wilson(bright.passRate, bright.runs);
  const b = wilson(upstream.passRate, upstream.runs);
  return { low: Math.max(-1, a.low - b.high), high: Math.min(1, a.high - b.low) };
}

function wilson(proportion: number, count: number) {
  if (!count) return { low: 0, high: 1 };
  const z = 1.96;
  const denominator = 1 + (z * z) / count;
  const center = (proportion + (z * z) / (2 * count)) / denominator;
  const margin =
    (z / denominator) *
    Math.sqrt((proportion * (1 - proportion)) / count + (z * z) / (4 * count * count));
  return { low: center - margin, high: center + margin };
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

function signed(value: number) {
  const points = Math.round(value * 100);
  return `${points > 0 ? "+" : ""}${points} pp`;
}

function seconds(milliseconds: number) {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

function title(value: string) {
  return value.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function escapeXml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
