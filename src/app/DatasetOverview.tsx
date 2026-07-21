import { Button } from "@openai/apps-sdk-ui/components/Button";
import {
  ChevronLeft,
  ChevronRight,
} from "@openai/apps-sdk-ui/components/Icon";
import { Bar } from "@/components/dither-kit/bar";
import { BarChart } from "@/components/dither-kit/bar-chart";
import { Tooltip } from "@/components/dither-kit/tooltip";
import { XAxis } from "@/components/dither-kit/x-axis";
import { YAxis } from "@/components/dither-kit/y-axis";
import type { DatasetProfile } from "../core/contracts";

type DatasetOverviewProps = {
  profiles: DatasetProfile[];
  profileIndex: number;
  rowCount: number;
  onProfileIndexChange: (index: number) => void;
};

export function DatasetOverview({
  profiles,
  profileIndex,
  rowCount,
  onProfileIndexChange,
}: DatasetOverviewProps) {
  const profile = profiles[profileIndex];
  if (!profile) {
    return (
      <section
        className="rounded-xl border border-subtle p-6 text-center text-sm text-secondary"
        aria-label="Table overview"
      >
        No useful columns are available to profile.
      </section>
    );
  }

  const move = (direction: number) => {
    onProfileIndexChange(
      (profileIndex + direction + profiles.length) % profiles.length,
    );
  };
  const config = {
    count: { label: "Rows", color: "blue" },
  } as const;

  return (
    <section
      className="rounded-xl border border-subtle p-3 sm:p-4"
      aria-label="Table overview"
    >
      <header className="grid grid-cols-[36px_minmax(0,1fr)_36px] items-center gap-2">
        <Button
          variant="ghost"
          color="secondary"
          size="sm"
          uniform
          aria-label="Previous column"
          title="Previous column"
          onClick={() => move(-1)}
        >
          <ChevronLeft className="size-4 rtl:rotate-180" aria-hidden="true" />
        </Button>
        <div className="min-w-0 text-center">
          <h2 className="truncate text-sm font-semibold">{profile.label}</h2>
          <p className="text-xs capitalize text-secondary">
            {profile.kind} · {profileIndex + 1} of {profiles.length} · {rowCount} rows
          </p>
        </div>
        <Button
          variant="ghost"
          color="secondary"
          size="sm"
          uniform
          aria-label="Next column"
          title="Next column"
          onClick={() => move(1)}
        >
          <ChevronRight className="size-4 rtl:rotate-180" aria-hidden="true" />
        </Button>
      </header>

      <figure className="mt-5">
        <figcaption className="mb-2 text-xs text-secondary">
          {profile.kind === "category" || profile.kind === "boolean"
            ? "Most common values"
            : "Distribution"}
        </figcaption>
        <div className="h-56 w-full" aria-label={`${profile.label} distribution`}>
          <BarChart
            data={profile.buckets}
            config={config}
            bloom="low"
            animationDuration={550}
          >
            <XAxis dataKey="label" maxTicks={6} />
            <YAxis tickCount={4} />
            <Tooltip labelKey="label" />
            <Bar dataKey="count" variant="dotted" />
          </BarChart>
        </div>
      </figure>

      <dl className="mt-4 grid grid-flow-col grid-rows-2 gap-x-3 gap-y-1 overflow-x-auto">
        {profile.stats.map((stat) => (
          <div key={stat.label} className="min-w-20">
            <dt className="text-[11px] text-secondary">{stat.label}</dt>
            <dd className="m-0 text-sm font-medium">{stat.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
