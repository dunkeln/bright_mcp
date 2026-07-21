# Remote MCP A/B evaluations

This isolated Bun package compares the two published remote MCP servers. It
does not import the Bright MCP application, start a local server, or share the
root package's dependencies or lockfile.

## Run

BrightData MCP requires a Bright Data API key and currently charges one
credit for each search. The use-case suite makes seven BrightData MCP searches.

```bash
cd evals
bun install --frozen-lockfile
bun run eval
```

From the repository root, the complete run-and-publish pipeline is:

```bash
bun run benchmark
```

Run either layer independently:

```bash
bun run check
bun run usecases
```

Reports are written to the ignored `evals/.artifacts/` directory. Agent reports
retain responses and tool evidence for blind judging; they never contain API
tokens and must not be published.

## What is deterministic

`bun run check` verifies both published servers initialize, expose their frozen
five-tool surfaces, require a search query in their schema, and reject a missing
query. A failure means the remote contract drifted or became unavailable.

`bun run usecases` directly executes the seven scenarios advertised in the
BrightData MCP README against each server's search tool. It verifies successful,
non-empty, bounded MCP results and records latency and result size.

The repeated agent suite covers two workflows each for Acquire, Extract,
Research, and Operate. It accepts different valid tool paths for each MCP, then
checks requested output fields, provenance, honest capability boundaries,
latency, calls, and token use. Latency is wall-clock time from the prompt to the
final response, including both model and MCP work. Live factual values are not
independently graded. A stronger judge model compares matched, anonymously
labeled artifacts for task fulfillment, evidence grounding, information
density, source quality, and actionability. Deterministic passes remain separate
from judge scores.

## Latest tool-use benchmark

<!-- benchmark:start -->

`openrouter/anthropic/claude-haiku-4.5` · 10 runs/case · 2026-07-21

| Case | Pass Bright/BrightData | Tokens Bright/BrightData | p50 latency Bright/BrightData | Calls Bright/BrightData |
|---|---:|---:|---:|---:|
| Acquire · Current search | 0% / 30% | 6812 / 9645 | 5.5s / 13.3s | 2.20 / 2.60 |
| Acquire · Known pages | 100% / 100% | 7086 / 6380 | 5.5s / 6.8s | 2.30 / 3.60 |
| Extract · npm record | 100% / 100% | 8788 / 7471 | 6.4s / 7.1s | 3.00 / 2.40 |
| Extract · PyPI record | 100% / 90% | 8892 / 6937 | 6.5s / 92.9s | 3.00 / 2.70 |
| Research · Local research | 80% / 60% | 9486 / 26597 | 9.2s / 11.0s | 4.00 / 5.90 |
| Research · Current events | 0% / 20% | 7467 / 57325 | 7.1s / 9.1s | 5.70 / 6.60 |
| Operate · Product snapshot | 0% / 20% | 6189 / 12874 | 4.6s / 4.9s | 2.00 / 1.80 |
| Operate · Recurring delivery | 100% / 100% | 6292 / 1730 | 5.5s / 2.2s | 2.00 / 0.00 |

A pass requires a valid workflow tool path, populated arguments, the requested output fields and provenance, and no runner error. Factual values are not independently graded.
<!-- benchmark:end -->
