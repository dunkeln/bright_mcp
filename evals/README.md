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

Live facts, search quality, and model tool selection are not deterministic.
Those results must be graded over repeated agent runs before they support public
positioning claims. The current Bright MCP deployment also uses its demo
provider, so this scaffold does not yet claim provider-quality parity.

## Latest tool-use benchmark

<!-- benchmark:start -->
No agent benchmark has been published yet.
<!-- benchmark:end -->
