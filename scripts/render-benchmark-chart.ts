import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { useCases } from "../evals/src/cases";
import { buildAppAssets } from "./app-build";

const mode = process.argv[2];
if (!["--write", "--check", "--preview"].includes(mode ?? "")) {
  throw new Error("Use --write, --check, or --preview.");
}

const report = (await Bun.file(new URL("../evals/.artifacts/agent.json", import.meta.url)).json()) as Report;
const labels: Record<(typeof useCases)[number]["id"], string> = {
  "current-stock-price": "Stock",
  "best-rated-restaurants": "Restaurants",
  "weather-forecast": "Weather",
  "movie-releases": "Movies",
  "social-trends": "Social",
  "npm-package-version": "npm",
  "python-package-readme": "PyPI",
};
const data = useCases.map(({ id }) => ({
  label: labels[id],
  brightData: passRate(report.results.filter((result) => result.caseId === id && result.server === "upstream")),
  bright: passRate(report.results.filter((result) => result.caseId === id && result.server === "bright")),
}));
const complete = useCases.every((useCase) =>
  (["bright", "upstream"] as const).every(
    (server) => report.results.filter((result) => result.caseId === useCase.id && result.server === server).length === report.runsPerCase,
  ),
);
if (mode !== "--preview" && (report.providerParity !== "live" || !complete)) process.exit(0);

const temporaryDirectory = await mkdtemp(join(tmpdir(), "bright-benchmark-"));
try {
  const output = mode === "--preview"
    ? process.argv[3]
    : mode === "--check"
      ? join(temporaryDirectory, "benchmark.png")
      : new URL("../assets/benchmark.png", import.meta.url).pathname;
  if (!output) throw new Error("Preview output path is required.");
  const assets = await buildAppAssets({
    entrypoint: new URL("benchmark-chart.tsx", import.meta.url),
    outputDirectory: new URL(`file://${temporaryDirectory}/`),
    minify: true,
    stylesheet: new URL("benchmark-chart.css", import.meta.url),
  });
  const css = await Bun.file(assets.css).text();
  const javascript = await Bun.file(assets.javascript).text();
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script>window.benchmark=${safeJson({ model: report.model, runsPerCase: report.runsPerCase, data })}</script><script type="module">${javascript.replaceAll("</script", "<\\/script")}</script></body></html>`;
  const browser = await chromium.launch({ executablePath: await browserPath(), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 640 }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load" });
    await page.waitForSelector("body[data-ready=true]");
    await page.locator("#benchmark").screenshot({ path: output });
  } finally {
    await browser.close();
  }

  if (mode === "--check") {
    const expected = new Uint8Array(await Bun.file(new URL("../assets/benchmark.png", import.meta.url)).arrayBuffer());
    const actual = new Uint8Array(await Bun.file(output).arrayBuffer());
    if (expected.length !== actual.length || expected.some((byte, index) => byte !== actual[index])) {
      throw new Error("Generated benchmark chart is stale.");
    }
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

type Report = {
  model: string;
  runsPerCase: number;
  providerParity: "demo" | "live";
  results: Array<{ caseId: string; server: "bright" | "upstream"; passed: boolean }>;
};

function passRate(results: Report["results"]) {
  return results.length ? (results.filter(({ passed }) => passed).length / results.length) * 100 : 0;
}

function safeJson(value: unknown) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

async function browserPath() {
  const candidates = [
    process.env.CHROME_PATH,
    Bun.which("google-chrome"),
    Bun.which("chromium"),
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const candidate of candidates) {
    if (candidate && await Bun.file(candidate).exists()) return candidate;
  }
  throw new Error("Chrome, Chromium, or Brave is required to render the README chart.");
}
