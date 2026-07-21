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

Reports are written to the ignored `evals/.artifacts/` directory. They contain
metrics and sanitized failures, never result bodies, endpoint URLs, or tokens.

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
latency, calls, and token use. Live factual values are not independently graded.
The current Bright MCP deployment also uses its demo provider, so this scaffold
does not yet claim provider-quality parity.

## Latest tool-use benchmark

<!-- benchmark:start -->
No agent benchmark has been published yet.
<!-- benchmark:end -->
