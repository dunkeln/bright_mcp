# End-to-end MCP workflow evaluation

This benchmark tests the product bet behind Bright MCP: an agent should spend its
context on decisions, not on replaying deterministic provider workflows. The unit
of evaluation is therefore a complete conversation, not an isolated tool call.

Each matched case gives the same model five authored turns with Bright MCP and the
official Bright Data MCP. The agent must acquire evidence, carry it across turns,
recover from failures, and deliver the requested final shape. This exposes costs
that single-call benchmarks miss: tool selection, evidence growth, retries, model
round trips, and whether useful structure pays off later in the conversation.

The package is isolated from the Bright MCP application and the root lockfile. Its
scripts disable MCPJam's anonymous usage telemetry; only ignored local artifacts
retain responses and tool evidence.

## The question under test

The MCP keeps judgment-bearing choices model-visible and owns the mechanics underneath them. The benchmark asks whether that boundary produces better completed workflows over several turns: grounded answers, fewer wasted decisions, controlled context, and recovery that does not require the model to rediscover provider behavior.

The comparison is intentionally narrow. It covers two Acquire workflows and one Operate workflow available to the benchmark account. It does not establish universal
Bright Data coverage or direct upstream speed.

## Current tool-use benchmark

<!-- benchmark:start -->
> **Provisional five-run snapshot:** the direction favors Bright MCP; rerun the judge before final publication.

Profile `current-entitlements` · agent `openrouter/anthropic/claude-haiku-4.5` · judge `anthropic/claude-sonnet-5` · 5 runs/case · 2026-07-23

**Test setup:** MCPJam HostRunner (`@mcpjam/sdk` 2.0.0 on Bun 1.3.14, macOS arm64) gave both MCPs the same five-turn prompts, Bright Data account credential, and `openrouter/anthropic/claude-haiku-4.5` agent through OpenRouter at temperature 0.1 for 5 runs per workflow. Runs were scheduled as matched pairs, two pairs at a time; calls within each conversation stayed sequential with a 120-second turn timeout. Each agent saw only its MCP's advertised tools and could take its own valid path to the same requested output. `anthropic/claude-sonnet-5` then judged anonymized answers against their tool evidence, with a label-swap check for position bias.
Search and Known Pages compared Bright's Web profile with the official default surface; Marketplace compared Bright's Marketplace profile with the official ecommerce tool group. Tool sequences were not forced to match because the surface design is part of the comparison; each side received its declared path length plus two recovery steps.

Extract and Research are excluded because general Deep Lookup is unavailable for the benchmark account.
Recurring delivery is excluded because durable scheduling is still a WIP capability.
Across 15 matched runs, Bright completed 14 workflows and Bright Data completed 13. Bright scored 7.59/10 versus 6.43/10 and won blind preference 9–4, with 2 ties.

| Case | Pass: Bright / Official | Recovered: Bright / Official | Quality: Bright / Official |
|---|---:|---:|---:|
| Acquire · Current search | 100% / 80% | 100% / 80% | 6.16 / 5.44 |
| Acquire · Known pages | 100% / 100% | 0% / 0% | 8.48 / 8.68 |
| Operate · Marketplace data retrieval | 80% / 80% | 0% / 0% | 8.12 / 5.16 |

A pass requires one parseable JSON payload, raw or in a single Markdown fence, with the requested output fields and provenance; brief surrounding text is ignored. Intended workflow selection, successful expected-tool execution, clean execution, and recovered errors remain separate artifact dimensions. Quality is a blind 0–10 integer average across task fulfillment, evidence grounding, information density, source quality, and actionability. Label-swap agreement: 67%.

![Outcome scorecard comparing completion, blind answer quality, and judge preference](../assets/benchmark-outcomes.png)

Bright's smaller, intent-shaped surface works like guardrails: the model sees the decisions it must make, while retries, polling, and result shaping stay inside the MCP. That helped completion and answer quality here. The official MCP's broader direct surface is more flexible and can be better for expert agents that already understand Bright Data's product map.

![Paired horizontal bars comparing workflow completion](../assets/benchmark-completion.png)

Bright completed every Search run because bounded recovery stayed inside the tool. The official MCP's thinner Search path is easier to understand and cheaper when it succeeds, but it lets more upstream behavior reach the model; one such run failed here. Both MCPs were equally reliable on Known Pages and Marketplace.

### MCP efficiency diagnostics

These measurements include model reasoning and tool execution. Tokens, latency, and calls use successful runs only; failed runs remain in completion rate and are never counted as fast or cheap successes. These describe the observed agent path and must not be read as direct-MCP latency.

| Case | Successful runs: Bright / Official | Tokens/success¹: Bright / Official | Successful agent p50: Bright / Official | Calls/success: Bright / Official |
|---|---:|---:|---:|---:|
| Acquire · Current search | 5/5 / 4/5 | 80,628 / 169,547 | 71.7s / 70.2s | 5.00 / 5.00 |
| Acquire · Known pages | 5/5 / 5/5 | 19,468 / 18,985 | 20.8s / 20.8s | 1.20 / 2.00 |
| Operate · Marketplace data retrieval | 4/5 / 4/5 | 28,455 / 166,517 | 22.1s / 25.3s | 2.00 / 1.25 |

¹ Current Search tokens use the targeted 3-pair rerun shown below; that row's success, latency, and call columns retain the published five-run benchmark. Other token rows also retain the five-run benchmark.

For Current Search successful runs, mean latency was 68.5s for Bright MCP versus 69.5s for Bright Data MCP; p50 was 71.7s versus 70.2s. With 5 versus 4 successful samples, neither statistic establishes latency superiority.

![Paired horizontal bars comparing successful-workflow latency](../assets/benchmark-latency.png)

The official MCP was slightly faster on successful Search, which matches its shorter direct search-and-scrape route. Known Pages tied, and Bright was faster on Marketplace despite using an extra discovery step. The main lesson is not that one stack is always faster; each architecture wins on a different path.

![Paired horizontal bars comparing successful-run token use](../assets/benchmark-efficiency.png)

The targeted three-run Search rerun measured 80,628 tokens for Bright versus 169,547 for the official MCP. Bright's context fell 39% from its earlier 131,866-token baseline after readable-page normalization and stronger summary-sufficiency guidance; one run answered from compact summaries without opening pages. The sample is a regression signal, not a stable production estimate. Other rows retain the published five-run snapshot.

![Paired horizontal bars comparing successful-run tool calls](../assets/benchmark-complexity.png)

Bright won Known Pages calls by accepting several URLs in one typed batch. The official MCP won Marketplace calls because its broader, dataset-specific surface can jump straight to an operation. Bright deliberately spends one call on discovery so the model chooses from a typed catalog instead of guessing a provider tool.

### Judged answer quality

The blind judge favored Bright MCP in aggregate preference and across all five quality dimensions. Label-swap agreement was 67%, below the 75% publication gate, so rerun before treating the magnitude as final.

![Radar chart comparing blind answer-quality dimensions](../assets/benchmark-radar.png)

Bright's bounded, structured handoffs likely made evidence easier to carry across five turns, so it led every aggregate quality dimension. The exception worth preserving is Known Pages: the official MCP scored slightly higher there, evidence that its direct Markdown scraper is already well-shaped for simple reading jobs.

![Horizontal bars comparing blind pairwise preference](../assets/benchmark-preference.png)

The 9–4 result was not uniform. Bright won Marketplace 5–0 and Search 3–2; the official MCP won Known Pages 2–1, with 2 ties. That is the architectural split in one picture: Bright helps most when a workflow needs discovery and controlled transitions, while the official MCP shines when a mature direct tool already matches the job.

<!-- benchmark:end -->

## Run

The official Bright Data MCP requires a Bright Data API key and currently charges
one credit for each search. The use-case suite makes seven official MCP searches.

```bash
cd evals
bun install --frozen-lockfile
bun run eval
```

From the repository root, the complete run-and-publish pipeline is:

```bash
bun run benchmark
```

Agent runs execute as matched Bright MCP/official MCP pairs. `EVAL_CONCURRENCY=4`
runs two pairs at once; use a lower even value if either provider throttles.
Each agent's own tool calls remain sequential. `EVAL_TURNS` selects how many
authored conversation turns to run and defaults to five; prior turns are passed
back as explicit model context.

Run either layer independently:

```bash
bun run check
bun run usecases
```

Reports are written to the ignored `evals/.artifacts/` directory. Agent reports
retain responses and tool evidence for blind judging; they never contain API
tokens and must not be published.

`bun run report:write` validates those private artifacts, publishes only the
metrics needed by `evals/results/published-benchmark.json`, then regenerates the
README blocks and charts from that snapshot. `bun run report:check` uses the
committed snapshot, so publication drift can be checked without private traces.

## What is deterministic

`bun run check` runs MCPJam's deterministic protocol conformance checks against
both published servers and every Bright MCP profile, then verifies the frozen
tool surfaces, profile boundaries, output-schema dialects, and rejection of
empty calls to required-input tools. Before statistical runs, it also records whether Bright MCP can execute
unbilled extraction and research previews and verifies that the maintained Amazon
product-search collector is discoverable. Deep Lookup availability is informational;
marketplace discovery is blocking because the Operate workflow depends on it.

`bun run usecases` directly executes the seven scenarios advertised in the
official Bright Data MCP README against each server's search tool. It verifies successful,
non-empty, bounded MCP results and records latency and result size.

The paired agent sample uses five-turn conversations under the explicit
`current-entitlements` profile and covers two Acquire workflows and one Operate workflow. Extract and Research are
commented out because this account's Deep Lookup access is restricted to
business-email queries; re-enable them only after both preview probes pass.
Recurring delivery is also commented out while durable scheduling remains a WIP
capability.
The suite accepts different valid tool paths for each MCP, then
checks requested output fields, provenance,
latency, calls, and token use. Latency is wall-clock time from the prompt to the
final response, including both model and MCP work. Live factual values are not
independently graded. A stronger judge model compares matched, anonymously
labeled artifacts with anchored 0–10 integer scores for task fulfillment,
evidence grounding, information density, source quality, and actionability.
Deterministic passes remain separate
from judge scores. Results support claims about Acquire and Operate under this
profile, not successful execution of all seven published tools.
