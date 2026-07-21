import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { workflowCases } from "../evals/src/workflows";
import { buildAppAssets } from "./app-build";

const mode = process.argv[2];
if (!["--write", "--check", "--preview"].includes(mode ?? "")) throw new Error("Use --write, --check, or --preview.");

const report = (await Bun.file(new URL("../evals/.artifacts/agent.json", import.meta.url)).json()) as Report;
const tasks = workflowCases.map(({ id, shortLabel }) => ({
  label: shortLabel,
  brightData: summarize(report.results.filter((result) => result.caseId === id && result.server === "upstream")),
  bright: summarize(report.results.filter((result) => result.caseId === id && result.server === "bright")),
}));
const complete = workflowCases.every(({ id }) => (["bright", "upstream"] as const).every((server) => report.results.filter((result) => result.caseId === id && result.server === server).length === report.runsPerCase));
if (mode !== "--preview" && !complete) process.exit(0);

const charts = ["completion", "efficiency", "latency", "complexity"] as const;
const temporaryDirectory = await mkdtemp(join(tmpdir(), "bright-benchmark-"));
try {
  const assets = await buildAppAssets({
    entrypoint: new URL("benchmark-chart.tsx", import.meta.url),
    outputDirectory: new URL(`file://${temporaryDirectory}/`),
    minify: true,
    stylesheet: new URL("benchmark-chart.css", import.meta.url),
  });
  const css = await Bun.file(assets.css).text();
  const javascript = await Bun.file(assets.javascript).text();
  const data = {
    model: report.model,
    runsPerCase: report.runsPerCase,
    tasks,
    latency: {
      brightData: report.results.filter(({ server }) => server === "upstream").map(({ latencyMs }) => latencyMs),
      bright: report.results.filter(({ server }) => server === "bright").map(({ latencyMs }) => latencyMs),
    },
  };
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script>window.benchmark=${safeJson(data)}</script><script type="module">${javascript.replaceAll("</script", "<\\/script")}</script></body></html>`;
  const browser = await chromium.launch({ executablePath: await browserPath(), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 2560 }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load" });
    await page.waitForSelector("body[data-ready=true]");
    for (const chart of charts) {
      const actual = mode === "--preview"
        ? previewPath(process.argv[3], chart)
        : mode === "--check"
          ? join(temporaryDirectory, `benchmark-${chart}.png`)
          : new URL(`../assets/benchmark-${chart}.png`, import.meta.url).pathname;
      await page.locator(`#benchmark-${chart}`).screenshot({ path: actual });
      if (mode === "--check") await assertCurrent(chart, actual);
    }
  } finally {
    await browser.close();
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

type Result = { caseId: string; server: "bright" | "upstream"; passed: boolean; tokenCount: number; latencyMs: number; toolsCalled: string[] };
type Report = { model: string; runsPerCase: number; results: Result[] };

function summarize(results: Result[]) {
  return {
    passRate: results.length ? results.filter(({ passed }) => passed).length / results.length : 0,
    averageTokens: average(results.map(({ tokenCount }) => tokenCount)),
    averageTools: average(results.map(({ toolsCalled }) => toolsCalled.length)),
  };
}
function average(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function safeJson(value: unknown) { return JSON.stringify(value).replaceAll("<", "\\u003c"); }
function previewPath(directory: string | undefined, chart: string) {
  if (!directory) throw new Error("Preview output directory is required.");
  return join(directory, `benchmark-${chart}.png`);
}
async function assertCurrent(chart: string, actualPath: string) {
  const expected = new Uint8Array(await Bun.file(new URL(`../assets/benchmark-${chart}.png`, import.meta.url)).arrayBuffer());
  const actual = new Uint8Array(await Bun.file(actualPath).arrayBuffer());
  if (expected.length !== actual.length || expected.some((byte, index) => byte !== actual[index])) throw new Error(`Generated benchmark ${chart} chart is stale.`);
}
async function browserPath() {
  const candidates = [process.env.CHROME_PATH, Bun.which("google-chrome"), Bun.which("chromium"), "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  for (const candidate of candidates) if (candidate && await Bun.file(candidate).exists()) return candidate;
  throw new Error("Chrome, Chromium, or Brave is required to render README charts.");
}
