import { useEffect } from "react";
import { createRoot } from "react-dom/client";

type ServerDatum = {
  successfulRuns: number;
  passRate: number;
  averageTokens: number;
  medianLatency: number;
  averageTools: number;
};
type TaskDatum = {
  label: string;
  brightData: ServerDatum;
  bright: ServerDatum;
  quality: { brightData: number; bright: number };
};
type QualityDimension = { label: string; brightData: number; bright: number };

declare global {
  interface Window {
    benchmark: {
      model: string;
      judgeModel: string;
      runsPerCase: number;
      tasks: TaskDatum[];
      quality: { scale: { minimum: number; maximum: number }; dimensions: QualityDimension[] };
      preference: { brightData: number; bright: number; ties: number };
      overallQuality: { brightData: number; bright: number };
      contextGate: {
        runsPerServer: number;
        current: Record<"bright" | "brightData", { averageTokens: number }>;
      };
    };
  }
}

const colors = { brightData: "#a371f7", bright: "#438cf5" } as const;
const plot = { left: 210, right: 1080, top: 34, bottom: 430 };

function BenchmarkCharts() {
  const { tasks, model, judgeModel, quality, preference, overallQuality, runsPerCase, contextGate } = window.benchmark;
  const efficiencyTasks = tasks.map((task) => task.label === "Current search"
    ? {
        ...task,
        bright: { ...task.bright, averageTokens: contextGate.current.bright.averageTokens },
        brightData: { ...task.brightData, averageTokens: contextGate.current.brightData.averageTokens },
      }
    : task);
  useEffect(() => {
    let frames = 0;
    const ready = () => {
      if (++frames < 4) requestAnimationFrame(ready);
      else document.body.dataset.ready = "true";
    };
    requestAnimationFrame(ready);
  }, []);

  return (
    <main className="w-[1200px] bg-[#0d1117] text-neutral-50">
      <Chart id="benchmark-outcomes" title="Bright MCP leads the five-turn benchmark" subtitle="Matched conversations · higher is better on every row" meta={meta(model, runsPerCase)}>
        <OutcomeScorecard tasks={tasks} quality={overallQuality} preference={preference} />
      </Chart>
      <Chart id="benchmark-completion" title="Where each MCP completes the job" subtitle="Tool-use pass rate by workflow" meta={meta(model, runsPerCase)}>
        <PairedBars tasks={tasks} value={(datum) => datum.passRate * 100} domain={100} format={(value) => `${Math.round(value)}%`} />
      </Chart>
      <Chart id="benchmark-latency" title="How long successful workflows take" subtitle="Median end-to-end latency · lower is better · failures stay in completion rate" meta={meta(model, runsPerCase)}>
        <PairedBars tasks={tasks} value={(datum) => datum.medianLatency / 1000} domain={latencyDomain(tasks)} format={(value) => `${value.toFixed(1)}s`} formatValue={(value, datum) => `${value.toFixed(1)}s · n=${datum.successfulRuns}`} />
      </Chart>
      <Chart id="benchmark-preference" title={preferenceTitle(preference)} subtitle="Matched runs · ties remain ties" meta={`${judgeModel} judge`}>
        <Preference values={preference} />
      </Chart>
      <Chart id="benchmark-radar" title={qualityTitle(quality.dimensions)} subtitle={`Blind judge scores · every spoke uses the same ${quality.scale.minimum}–${quality.scale.maximum} scale`} meta={`${judgeModel} judge`}>
        <Radar dimensions={quality.dimensions} maximum={quality.scale.maximum} />
      </Chart>
      <Chart id="benchmark-efficiency" title="How much context successful workflows use" subtitle="Average total tokens · lower is better · Search uses the targeted rerun" meta={`Search n=${contextGate.runsPerServer} · other rows n=${runsPerCase}`}>
        <PairedBars
          tasks={efficiencyTasks}
          value={(datum) => datum.averageTokens}
          domain={tokenDomain(efficiencyTasks)}
          format={(value) => Math.round(value).toLocaleString("en-US")}
        />
      </Chart>
      <Chart id="benchmark-complexity" title="How much tool work successful workflows take" subtitle="Average MCP tool calls among successful runs" meta={meta(model, runsPerCase)}>
        <PairedBars tasks={tasks} value={(datum) => datum.averageTools} domain={Math.max(...tasks.flatMap(({ bright, brightData }) => [bright.averageTools, brightData.averageTools]), 1)} format={(value) => value.toFixed(1)} />
      </Chart>
    </main>
  );
}

function Chart({ id, title, subtitle, meta: detail, children }: { id: string; title: string; subtitle: string; meta: string; children: React.ReactNode }) {
  return (
    <section id={id} className="h-[640px] w-[1200px] bg-[#0d1117] p-10">
      <header className="flex items-start justify-between gap-8">
        <div>
          <h1 className="m-0 text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-neutral-400">{subtitle}</p>
        </div>
        <p className="mt-1 font-mono text-xs text-neutral-500">{detail}</p>
      </header>
      <Legend />
      <figure className="mt-4 h-[460px] w-full">{children}</figure>
    </section>
  );
}

function Legend() {
  return (
    <div className="mt-4 flex gap-5 text-xs text-neutral-300" aria-hidden="true">
      <span className="flex items-center gap-2"><i className="h-3 w-3 bg-[#438cf5]" />Bright MCP</span>
      <span className="flex items-center gap-2"><i className="h-3 w-3 bg-[#a371f7]" />Official Bright Data MCP</span>
    </div>
  );
}

function OutcomeScorecard({ tasks, quality, preference }: {
  tasks: TaskDatum[];
  quality: { brightData: number; bright: number };
  preference: { brightData: number; bright: number; ties: number };
}) {
  const successful = {
    bright: tasks.reduce((sum, task) => sum + task.bright.successfulRuns, 0),
    brightData: tasks.reduce((sum, task) => sum + task.brightData.successfulRuns, 0),
  };
  const totalRuns = tasks.length * window.benchmark.runsPerCase;
  const preferenceTotal = preference.bright + preference.brightData + preference.ties;
  const rows = [
    {
      label: "Completed workflows",
      detail: `${totalRuns} matched runs`,
      bright: successful.bright / totalRuns,
      brightData: successful.brightData / totalRuns,
      format: (value: number, server: "bright" | "brightData") => `${successful[server]}/${totalRuns} · ${Math.round(value * 100)}%`,
    },
    {
      label: "Blind answer quality",
      detail: "mean across five judged dimensions",
      bright: quality.bright / 10,
      brightData: quality.brightData / 10,
      format: (_value: number, server: "bright" | "brightData") => `${quality[server].toFixed(2)}/10`,
    },
    {
      label: "Judge preference",
      detail: `${preference.ties} ties retained`,
      bright: preference.bright / preferenceTotal,
      brightData: preference.brightData / preferenceTotal,
      format: (value: number, server: "bright" | "brightData") => `${preference[server]} of ${preferenceTotal} · ${Math.round(value * 100)}%`,
    },
  ];
  const x = (value: number) => 300 + value * 730;
  return <svg viewBox="0 0 1120 460" role="img" className="h-full w-full">
    <Patterns />
    {rows.map((row, index) => {
      const y = 72 + index * 120;
      return <g key={row.label}>
        <text x="0" y={y} className="label">{row.label}</text>
        <text x="0" y={y + 19} className="axis">{row.detail}</text>
        <rect x="300" y={y - 17} width={Math.max(1, x(row.bright) - 300)} height="14" fill="url(#blue-dither)" />
        <rect x="300" y={y + 7} width={Math.max(1, x(row.brightData) - 300)} height="14" fill="url(#purple-dither)" />
        <text x={Math.min(x(row.bright) + 10, 1075)} y={y - 5} className="value">{row.format(row.bright, "bright")}</text>
        <text x={Math.min(x(row.brightData) + 10, 1075)} y={y + 20} className="value">{row.format(row.brightData, "brightData")}</text>
      </g>;
    })}
  </svg>;
}

function PairedBars({ tasks, value, domain, format, formatValue = format }: { tasks: TaskDatum[]; value: (datum: ServerDatum, task: TaskDatum, server: "bright" | "brightData") => number; domain: number; format: (value: number) => string; formatValue?: (value: number, datum: ServerDatum, task: TaskDatum, server: "bright" | "brightData") => string }) {
  const x = (number: number) => plot.left + (number / domain) * (plot.right - plot.left);
  return (
    <svg viewBox="0 0 1120 460" role="img" className="h-full w-full">
      <Patterns />
      {[0, 0.25, 0.5, 0.75, 1].map((tick) => <g key={tick}><line x1={x(domain * tick)} x2={x(domain * tick)} y1={plot.top} y2={plot.bottom} stroke="#30363d" /><text x={x(domain * tick)} y="454" textAnchor="middle" className="axis">{format(domain * tick)}</text></g>)}
      {tasks.map((task, index) => {
        const y = 56 + index * 48;
        const bright = value(task.bright, task, "bright");
        const brightData = value(task.brightData, task, "brightData");
        return <g key={task.label}>
          <text x="0" y={y + 5} className="label">{task.label}</text>
          <rect x={plot.left} y={y - 12} width={Math.max(1, x(bright) - plot.left)} height="10" fill="url(#blue-dither)" />
          <rect x={plot.left} y={y + 3} width={Math.max(1, x(brightData) - plot.left)} height="10" fill="url(#purple-dither)" />
          <text x={Math.min(x(bright) + 8, 1090)} y={y - 3} className="value">{formatValue(bright, task.bright, task, "bright")}</text>
          <text x={Math.min(x(brightData) + 8, 1090)} y={y + 13} className="value">{formatValue(brightData, task.brightData, task, "brightData")}</text>
        </g>;
      })}
    </svg>
  );
}

function Radar({ dimensions, maximum }: { dimensions: QualityDimension[]; maximum: number }) {
  const center = { x: 560, y: 225 };
  const radius = 155;
  const point = (index: number, value: number, extra = 0) => {
    const angle = -Math.PI / 2 + (index / dimensions.length) * Math.PI * 2;
    const distance = radius * value + extra;
    return { x: center.x + Math.cos(angle) * distance, y: center.y + Math.sin(angle) * distance };
  };
  const points = (server: "bright" | "brightData") => dimensions.map((dimension, index) => {
    const position = point(index, dimension[server] / maximum);
    return `${position.x},${position.y}`;
  }).join(" ");
  return (
    <svg viewBox="0 0 1120 460" role="img" className="h-full w-full">
      <Patterns />
      {[0.2, 0.4, 0.6, 0.8, 1].map((level) => <polygon key={level} points={dimensions.map((_, index) => { const p = point(index, level); return `${p.x},${p.y}`; }).join(" ")} fill="none" stroke="#30363d" />)}
      {dimensions.map((dimension, index) => {
        const edge = point(index, 1);
        const label = point(index, 1, 38);
        const anchor = label.x < center.x - 20 ? "end" : label.x > center.x + 20 ? "start" : "middle";
        return <g key={dimension.label}>
          <line x1={center.x} y1={center.y} x2={edge.x} y2={edge.y} stroke="#30363d" />
          <text x={label.x} y={label.y + 5} textAnchor={anchor} className="label">{dimension.label}</text>
        </g>;
      })}
      <polygon points={points("brightData")} fill="url(#purple-dither)" fillOpacity="0.35" stroke={colors.brightData} strokeWidth="3" />
      <polygon points={points("bright")} fill="url(#blue-dither)" fillOpacity="0.35" stroke={colors.bright} strokeWidth="3" />
      {(["brightData", "bright"] as const).flatMap((server) => dimensions.map((dimension, index) => {
        const p = point(index, dimension[server] / maximum);
        return <circle key={`${server}-${dimension.label}`} cx={p.x} cy={p.y} r="5" fill={`url(#${server === "bright" ? "blue" : "purple"}-dither)`} stroke={colors[server]} />;
      }))}
      <text x={center.x + 8} y={center.y - radius * 0.5} className="axis">{maximum / 2}</text>
      <text x={center.x + 8} y={center.y - radius} className="axis">{maximum}</text>
    </svg>
  );
}

function Preference({ values }: { values: { brightData: number; bright: number; ties: number } }) {
  const total = values.bright + values.brightData + values.ties;
  const rows = [
    { label: "Bright MCP", value: values.bright, fill: "url(#blue-dither)" },
    { label: "Official Bright Data MCP", value: values.brightData, fill: "url(#purple-dither)" },
    { label: "Tie", value: values.ties, fill: "#484f58" },
  ];
  const x = (value: number) => 210 + (value / Math.max(total, 1)) * 820;
  return <svg viewBox="0 0 1120 460" role="img" className="h-full w-full">
    <Patterns />
    {rows.map((row, index) => <g key={row.label}>
      <text x="0" y={105 + index * 105} className="label">{row.label}</text>
      <rect x="210" y={80 + index * 105} width={Math.max(1, x(row.value) - 210)} height="34" rx="4" fill={row.fill} />
      <text x={Math.min(x(row.value) + 12, 1070)} y={104 + index * 105} className="value">{row.value} · {total ? Math.round(row.value / total * 100) : 0}%</text>
    </g>)}
  </svg>;
}

function Patterns() {
  return <defs>
    <pattern id="blue-dither" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="2" height="2" fill={colors.bright} /><rect x="2" y="2" width="2" height="2" fill={colors.bright} /></pattern>
    <pattern id="purple-dither" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="2" height="2" fill={colors.brightData} /><rect x="2" y="2" width="2" height="2" fill={colors.brightData} /></pattern>
  </defs>;
}

function meta(model: string, runs: number) {
  return `${model} · ${runs} runs/case`;
}

function latencyDomain(tasks: TaskDatum[]) {
  const maximum = Math.max(...tasks.flatMap(({ bright, brightData }) => [bright.medianLatency, brightData.medianLatency])) / 1000;
  return Math.ceil(maximum * 1.2 / 10) * 10;
}

function tokenDomain(tasks: TaskDatum[]) {
  const maximum = Math.max(...tasks.flatMap(({ bright, brightData }) => [bright.averageTokens, brightData.averageTokens]));
  return Math.ceil(maximum * 1.15 / 10_000) * 10_000;
}

function preferenceTitle(preference: { brightData: number; bright: number }) {
  return `Blind judge preferred Bright MCP ${preference.bright}–${preference.brightData}`;
}

function qualityTitle(dimensions: QualityDimension[]) {
  const wins = dimensions.filter(({ bright, brightData }) => bright > brightData).length;
  return wins === dimensions.length
    ? `Bright MCP wins all ${wins} quality dimensions`
    : `Bright MCP wins ${wins} of ${dimensions.length} quality dimensions`;
}

const root = document.getElementById("root");
if (!root) throw new Error("Benchmark chart root is missing.");
createRoot(root).render(<BenchmarkCharts />);
