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
      <Chart id="benchmark-efficiency" title="Completion versus token cost" subtitle="Upper-left is better: more completed jobs with fewer tokens" meta={meta(model, runsPerCase)}>
        <Efficiency tasks={tasks} />
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

function Efficiency({ tasks }: { tasks: TaskDatum[] }) {
  const maxTokens = Math.ceil(Math.max(...tasks.flatMap(({ bright, brightData }) => [bright.averageTokens, brightData.averageTokens])) / 10_000) * 10_000;
  return (
    <svg viewBox="0 0 1120 460" role="img" className="h-full w-full">
      <Patterns />
      {tasks.map((task, index) => {
        const column = index % 2;
        const row = Math.floor(index / 2);
        const left = 20 + column * 555;
        const top = row * 108;
        const x = (tokens: number) => left + 150 + (tokens / maxTokens) * 370;
        const y = (rate: number) => top + 88 - rate * 0.58;
        return <g key={task.label}>
          <text x={left} y={top + 34} className="label">{task.label}</text>
          <line x1={left + 150} x2={left + 520} y1={top + 88} y2={top + 88} stroke="#30363d" />
          <line x1={x(task.bright.averageTokens)} y1={y(task.bright.passRate * 100)} x2={x(task.brightData.averageTokens)} y2={y(task.brightData.passRate * 100)} stroke="#6e7681" />
          <circle cx={x(task.brightData.averageTokens)} cy={y(task.brightData.passRate * 100) - 3} r="8" fill="url(#purple-dither)" stroke={colors.brightData} />
          <circle cx={x(task.bright.averageTokens)} cy={y(task.bright.passRate * 100) + 3} r="8" fill="url(#blue-dither)" stroke={colors.bright} />
          <text x={x(task.brightData.averageTokens) + 11} y={y(task.brightData.passRate * 100) - 9} className="value">{Math.round(task.brightData.averageTokens / 1000)}k · {Math.round(task.brightData.passRate * 100)}%</text>
          <text x={x(task.bright.averageTokens) + 11} y={y(task.bright.passRate * 100) + 18} className="value">{Math.round(task.bright.averageTokens / 1000)}k · {Math.round(task.bright.passRate * 100)}%</text>
        </g>;
      })}
      <text x="1100" y="454" textAnchor="end" className="axis-title">fewer tokens ← shared scale → more tokens</text>
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

const root = document.getElementById("root");
if (!root) throw new Error("Benchmark chart root is missing.");
createRoot(root).render(<BenchmarkCharts />);
