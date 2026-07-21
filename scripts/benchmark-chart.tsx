import { Bar } from "../src/components/dither-kit/bar";
import { BarChart } from "../src/components/dither-kit/bar-chart";
import { BlockLegend } from "../src/components/dither-kit/block-legend";
import { XAxis } from "../src/components/dither-kit/x-axis";
import { YAxis } from "../src/components/dither-kit/y-axis";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";

type ChartDatum = { label: string; brightData: number; bright: number };

declare global {
  interface Window {
    benchmark: { model: string; runsPerCase: number; data: ChartDatum[] };
  }
}

const config = {
  brightData: { label: "BrightData MCP", color: "orange" },
  bright: { label: "Bright MCP", color: "blue" },
} as const;

function BenchmarkChart() {
  const { data, model, runsPerCase } = window.benchmark;
  useEffect(() => {
    let frames = 0;
    const ready = () => {
      if (++frames < 4) requestAnimationFrame(ready);
      else document.body.dataset.ready = "true";
    };
    requestAnimationFrame(ready);
  }, []);

  return (
    <main id="benchmark" className="h-[640px] w-[1200px] bg-neutral-950 p-10 text-neutral-50">
      <header className="flex items-start justify-between gap-8">
        <div>
          <h1 className="m-0 text-2xl font-semibold tracking-tight">
            Tool-use completion by task
          </h1>
          <p className="mt-1 font-mono text-xs text-neutral-400">
            {model} · {runsPerCase} runs per case
          </p>
        </div>
        <BlockLegend config={config} />
      </header>
      <figure className="mt-8 h-[500px] w-full" aria-label="Tool-use completion rate by task">
        <BarChart
          data={data}
          config={config}
          animate={false}
          bloom="off"
          interactive={false}
          margins={{ top: 8, right: 16, bottom: 36, left: 52 }}
        >
          <XAxis dataKey="label" maxTicks={8} />
          <YAxis tickCount={5} tickFormatter={(value) => `${Math.round(value)}%`} />
          <Bar dataKey="brightData" variant="dotted" />
          <Bar dataKey="bright" variant="gradient" />
        </BarChart>
      </figure>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Benchmark chart root is missing.");
createRoot(root).render(<BenchmarkChart />);
