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
published tool surfaces, verifies Bright MCP's Web, Deep Lookup, and Marketplace
profile boundaries, requires a search query in each server's schema, and rejects a missing
query. Before statistical runs, it also records whether Bright MCP can execute
unbilled extraction and research previews and verifies that the maintained Amazon
product-search collector is discoverable. Deep Lookup availability is informational;
marketplace discovery is blocking because the Operate workflow depends on it.

`bun run usecases` directly executes the seven scenarios advertised in the
BrightData MCP README against each server's search tool. It verifies successful,
non-empty, bounded MCP results and records latency and result size.

The repeated agent suite uses the explicit `current-entitlements` profile and
covers two Acquire workflows and one Operate workflow. Extract and Research are
commented out because this account's Deep Lookup access is restricted to
business-email queries; re-enable them only after both preview probes pass.
Recurring delivery is also commented out while durable scheduling remains a WIP
capability.
The suite accepts different valid tool paths for each MCP, then
checks requested output fields, provenance,
latency, calls, and token use. Latency is wall-clock time from the prompt to the
final response, including both model and MCP work. Live factual values are not
independently graded. A stronger judge model compares matched, anonymously
labeled artifacts for task fulfillment, evidence grounding, information
density, source quality, and actionability. Deterministic passes remain separate
from judge scores. Results support claims about Acquire and Operate under this
profile, not successful execution of all six published tools.

## Full tool-use benchmark (pre-routing baseline)

<!-- benchmark:start -->

Profile `current-entitlements` · agent `openrouter/anthropic/claude-haiku-4.5` · judge `anthropic/claude-sonnet-5` · 10 runs/case · 2026-07-22

Extract and Research are excluded because general Deep Lookup is unavailable for the benchmark account.
Recurring delivery is excluded because durable scheduling is still a WIP capability.
Across 30 matched runs, both MCPs completed 29 workflows. Bright scored 4.51/5 versus 3.78/5 and won blind preference 17–3, with 10 ties.
This full study predates the narrow-profile routing, summary-sufficiency, and retry-ownership fixes. Its quality judgments remain useful; its Current search latency, token, and call-count row is a pre-fix baseline, not a measurement of the current implementation.

| Case | Pass Bright/BrightData | Recovered Bright/BrightData | Quality Bright/BrightData |
|---|---:|---:|---:|
| Acquire · Current search | 90% / 90% | 0% / 10% | 4.14 / 3.86 |
| Acquire · Known pages | 100% / 100% | 0% / 0% | 4.78 / 4.44 |
| Operate · Marketplace data retrieval | 100% / 100% | 0% / 0% | 4.60 / 3.04 |

A pass requires one parseable JSON payload, raw or in a single Markdown fence, with the requested output fields and provenance; brief surrounding text is ignored. Intended workflow selection, successful expected-tool execution, clean execution, and recovered errors remain separate artifact dimensions. Quality is a blind 1–5 average across task fulfillment, evidence grounding, information density, source quality, and actionability. Label-swap agreement: 100%.

### Pre-fix efficiency diagnostics

These measurements include model reasoning and tool execution. They diagnose the historical agent path and must not be read as current direct-MCP latency.

| Case | Tokens Bright/BrightData | Agent p50 (LLM + MCP) Bright/BrightData | Calls Bright/BrightData |
|---|---:|---:|---:|
| Acquire · Current search | 14900 / 5741 | 51.5s / 15.7s | 2.50 / 1.60 |
| Acquire · Known pages | 6822 / 4634 | 14.3s / 14.3s | 1.00 / 2.00 |
| Operate · Marketplace data retrieval | 14292 / 26085 | 12.2s / 11.7s | 2.00 / 1.00 |
<!-- benchmark:end -->

## Engineering regression note (not publishable)

A three-pair current-search gate was used to diagnose the web-profile changes. It had no judge calls and ran before the final summary-sufficiency instruction, so it is intentionally excluded from benchmark claims. The stored artifact remains available for regression analysis in `results/current-search-gate.json`.
