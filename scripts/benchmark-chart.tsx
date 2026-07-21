import { useEffect } from "react";
import { createRoot } from "react-dom/client";

type ServerDatum = {
  passRate: number;
  averageTokens: number;
  averageTools: number;
};
type TaskDatum = {
  label: string;
  brightData: ServerDatum;
  bright: ServerDatum;
};

declare global {
  interface Window {
    benchmark: {
      model: string;
      runsPerCase: number;
      tasks: TaskDatum[];
      latency: { brightData: number[]; bright: number[] };
    };
  }
}

const colors = { brightData: "#a371f7", bright: "#438cf5" } as const;
const plot = { left: 210, right: 1080, top: 34, bottom: 430 };

function BenchmarkCharts() {
  const { tasks, latency, model, runsPerCase } = window.benchmark;
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
      <Chart id="benchmark-completion" title="Where each MCP completes the job" subtitle="Tool-use pass rate by workflow" meta={meta(model, runsPerCase)}>
        <PairedBars tasks={tasks} value={(datum) => datum.passRate * 100} domain={100} format={(value) => `${Math.round(value)}%`} />
      </Chart>
      <Chart id="benchmark-radar" title="Capability fingerprint across workflows" subtitle="Tool-use pass rate · every spoke uses the same 0–100% scale" meta={meta(model, runsPerCase)}>
        <Radar tasks={tasks} />
      </Chart>
      <Chart id="benchmark-efficiency" title="How many passing runs each token budget buys" subtitle="Benchmark passes per 10k total tokens · higher is better" meta={meta(model, runsPerCase)}>
        <PairedBars
          tasks={tasks}
          value={(datum) => datum.averageTokens ? datum.passRate * 10_000 / datum.averageTokens : 0}
          domain={efficiencyDomain(tasks)}
          format={(value) => value.toFixed(1)}
        />
      </Chart>
      <Chart id="benchmark-latency" title="How often each MCP finishes quickly" subtitle="Cumulative share of all runs by end-to-end latency" meta={`${latency.bright.length + latency.brightData.length} live runs`}>
        <Latency values={latency} />
      </Chart>
      <Chart id="benchmark-complexity" title="How much tool work each workflow takes" subtitle="Average MCP tool calls per run" meta={meta(model, runsPerCase)}>
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
      <span className="flex items-center gap-2"><i className="h-3 w-3 bg-[#a371f7]" />BrightData MCP</span>
    </div>
  );
}

function PairedBars({ tasks, value, domain, format }: { tasks: TaskDatum[]; value: (datum: ServerDatum) => number; domain: number; format: (value: number) => string }) {
  const x = (number: number) => plot.left + (number / domain) * (plot.right - plot.left);
  return (
    <svg viewBox="0 0 1120 460" role="img" className="h-full w-full">
      <Patterns />
      {[0, 0.25, 0.5, 0.75, 1].map((tick) => <g key={tick}><line x1={x(domain * tick)} x2={x(domain * tick)} y1={plot.top} y2={plot.bottom} stroke="#30363d" /><text x={x(domain * tick)} y="454" textAnchor="middle" className="axis">{format(domain * tick)}</text></g>)}
      {tasks.map((task, index) => {
        const y = 56 + index * 48;
        const bright = value(task.bright);
        const brightData = value(task.brightData);
        return <g key={task.label}>
          <text x="0" y={y + 5} className="label">{task.label}</text>
          <rect x={plot.left} y={y - 12} width={Math.max(1, x(bright) - plot.left)} height="10" fill="url(#blue-dither)" />
          <rect x={plot.left} y={y + 3} width={Math.max(1, x(brightData) - plot.left)} height="10" fill="url(#purple-dither)" />
          <text x={Math.min(x(bright) + 8, 1090)} y={y - 3} className="value">{format(bright)}</text>
          <text x={Math.min(x(brightData) + 8, 1090)} y={y + 13} className="value">{format(brightData)}</text>
        </g>;
      })}
    </svg>
  );
}

function Radar({ tasks }: { tasks: TaskDatum[] }) {
  const center = { x: 560, y: 225 };
  const radius = 155;
  const point = (index: number, value: number, extra = 0) => {
    const angle = -Math.PI / 2 + (index / tasks.length) * Math.PI * 2;
    const distance = radius * value + extra;
    return { x: center.x + Math.cos(angle) * distance, y: center.y + Math.sin(angle) * distance };
  };
  const points = (server: "bright" | "brightData") => tasks.map((task, index) => {
    const position = point(index, task[server].passRate);
    return `${position.x},${position.y}`;
  }).join(" ");
  return (
    <svg viewBox="0 0 1120 460" role="img" className="h-full w-full">
      <Patterns />
      {[0.25, 0.5, 0.75, 1].map((level) => <polygon key={level} points={tasks.map((_, index) => { const p = point(index, level); return `${p.x},${p.y}`; }).join(" ")} fill="none" stroke="#30363d" />)}
      {tasks.map((task, index) => {
        const edge = point(index, 1);
        const label = point(index, 1, 38);
        const anchor = label.x < center.x - 20 ? "end" : label.x > center.x + 20 ? "start" : "middle";
        return <g key={task.label}>
          <line x1={center.x} y1={center.y} x2={edge.x} y2={edge.y} stroke="#30363d" />
          <text x={label.x} y={label.y + 5} textAnchor={anchor} className="label">{task.label}</text>
        </g>;
      })}
      <polygon points={points("brightData")} fill="url(#purple-dither)" fillOpacity="0.35" stroke={colors.brightData} strokeWidth="3" />
      <polygon points={points("bright")} fill="url(#blue-dither)" fillOpacity="0.35" stroke={colors.bright} strokeWidth="3" />
      {(["brightData", "bright"] as const).flatMap((server) => tasks.map((task, index) => {
        const p = point(index, task[server].passRate);
        return <circle key={`${server}-${task.label}`} cx={p.x} cy={p.y} r="5" fill={`url(#${server === "bright" ? "blue" : "purple"}-dither)`} stroke={colors[server]} />;
      }))}
      <text x={center.x + 8} y={center.y - radius * 0.5} className="axis">50%</text>
      <text x={center.x + 8} y={center.y - radius} className="axis">100%</text>
    </svg>
  );
}

function Latency({ values }: { values: { brightData: number[]; bright: number[] } }) {
  const max = Math.max(...values.brightData, ...values.bright);
  const x = (milliseconds: number) => 85 + (milliseconds / max) * 980;
  const y = (rate: number) => 420 - rate * 3.75;
  const path = (items: number[]) => items.toSorted((a, b) => a - b).map((item, index) => `${index ? "L" : "M"}${x(item)},${y(((index + 1) / items.length) * 100)}`).join(" ");
  return (
    <svg viewBox="0 0 1120 460" role="img" className="h-full w-full">
      {[0, 0.5, 1].map((tick) => <g key={tick}><line x1="85" x2="1065" y1={y(tick * 100)} y2={y(tick * 100)} stroke="#30363d" /><text x="70" y={y(tick * 100) + 5} textAnchor="end" className="axis">{tick * 100}%</text></g>)}
      {[0, 0.25, 0.5, 0.75, 1].map((tick) => <text key={tick} x={x(max * tick)} y="454" textAnchor="middle" className="axis">{Math.round(max * tick / 1000)}s</text>)}
      <path d={path(values.brightData)} fill="none" stroke={colors.brightData} strokeWidth="4" />
      <path d={path(values.bright)} fill="none" stroke={colors.bright} strokeWidth="4" />
    </svg>
  );
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

function efficiencyDomain(tasks: TaskDatum[]) {
  const maximum = Math.max(...tasks.flatMap(({ bright, brightData }) => [bright, brightData]).map((datum) => datum.averageTokens ? datum.passRate * 10_000 / datum.averageTokens : 0));
  return Math.ceil(maximum * 2) / 2;
}

const root = document.getElementById("root");
if (!root) throw new Error("Benchmark chart root is missing.");
createRoot(root).render(<BenchmarkCharts />);
