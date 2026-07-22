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

Agent runs execute as matched Bright/BrightData pairs. `EVAL_CONCURRENCY=4`
runs two pairs at once; use a lower even value if either provider throttles.
Each agent's own tool calls remain sequential.

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
published tool surfaces, require a search query in their schema, and reject a missing
query. Before statistical runs, it also records whether Bright MCP can execute
unbilled extraction and research previews and verifies that the maintained Amazon
product-search collector is discoverable. Deep Lookup availability is informational;
marketplace discovery is blocking because the Operate workflow depends on it.

`bun run usecases` directly executes the seven scenarios advertised in the
BrightData MCP README against each server's search tool. It verifies successful,
non-empty, bounded MCP results and records latency and result size.

The repeated agent suite uses the explicit `current-entitlements` profile and
covers two workflows each for Acquire and Operate. Extract and Research are
commented out because this account's Deep Lookup access is restricted to
business-email queries; re-enable them only after both preview probes pass.
The suite accepts different valid tool paths for each MCP, then
checks requested output fields, provenance, honest capability boundaries,
latency, calls, and token use. Latency is wall-clock time from the prompt to the
final response, including both model and MCP work. Live factual values are not
independently graded. A stronger judge model compares matched, anonymously
labeled artifacts for task fulfillment, evidence grounding, information
density, source quality, and actionability. Deterministic passes remain separate
from judge scores. Results support claims about Acquire and Operate under this
profile, not successful execution of all six published tools.

## Latest tool-use benchmark

<!-- benchmark:start -->

Profile `current-entitlements` · agent `openrouter/anthropic/claude-haiku-4.5` · judge `anthropic/claude-sonnet-5` · 10 runs/case · 2026-07-22

Extract and Research are excluded because general Deep Lookup is unavailable for the benchmark account.

| Case | Pass Bright/BrightData | Recovered Bright/BrightData | Quality Bright/BrightData | Tokens Bright/BrightData | p50 latency Bright/BrightData | Calls Bright/BrightData |
|---|---:|---:|---:|---:|---:|---:|
| Acquire · Current search | 0% / 0% | 0% / 0% | 3.70 / 4.24 | 21579 / 13647 | 90.8s / 56.8s | 3.10 / 2.50 |
| Acquire · Known pages | 100% / 100% | 0% / 10% | 4.68 / 4.68 | 6768 / 4851 | 15.2s / 19.6s | 1.00 / 2.10 |
| Operate · Product snapshot | 100% / 100% | 0% / 0% | 4.04 / 3.22 | 14159 / 32359 | 15.7s / 41.4s | 2.00 / 1.00 |
| Operate · Recurring delivery | 0% / 100% | 0% / 0% | 4.44 / 2.92 | 6881 / 1725 | 5.8s / 2.6s | 1.00 / 0.00 |

A pass requires a complete JSON response with the requested output fields and provenance. Intended workflow selection, successful expected-tool execution, clean execution, and recovered errors remain separate artifact dimensions. Quality is a blind 1–5 average across task fulfillment, evidence grounding, information density, source quality, and actionability. Label-swap agreement: 75%.
<!-- benchmark:end -->
