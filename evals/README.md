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
> Benchmark refresh pending for the six-tool intent surface.
<!-- benchmark:end -->
