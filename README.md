<div align="center">
  <img src="./assets/icon.png" alt="Bright MCP" width="320" />
  <br />
  <i>unofficial iteration on BrightData API served as MCP</i>
</div>

Agent-oriented Bright Data capabilities over MCP, built on Bun. The five-tool
base profile batches web research, routes explicit ranked/deep discovery,
searches the caller's live dataset catalog, runs curated collectors and Deep
Lookup, pages upstream snapshots as resources, and renders results in a
transient React MCP workbench.

## Install

Codex:

```bash
codex mcp add bright --url https://bright-mcp.onrender.com/mcp \
  --bearer-token-env-var BRIGHTDATA_API_KEY
```

Claude Code:

```bash
claude mcp add-json bright \
  '{"type":"http","url":"https://bright-mcp.onrender.com/mcp","headers":{"Authorization":"Bearer ${BRIGHTDATA_API_KEY}"}}'
```

Set `BRIGHTDATA_API_KEY` in the client environment first. The key is forwarded
over HTTPS and kept only in a bounded in-memory cache; Bright MCP does not
persist it. Available live capabilities follow the products enabled on that
Bright Data account.

See [SETUP.md](./SETUP.md) for local development, credentials, live checks, and
hosted authorization.

## Benchmarks

<!-- benchmark:start -->
![Paired horizontal bars comparing MCP completion by workflow](./assets/benchmark-completion.png)
![Radar chart comparing MCP capability fingerprints across workflows](./assets/benchmark-radar.png)
![Paired horizontal bars comparing benchmark passes per token budget](./assets/benchmark-efficiency.png)
![Cumulative latency distribution across all benchmark runs](./assets/benchmark-latency.png)
![Paired horizontal bars comparing average tool calls by workflow](./assets/benchmark-complexity.png)

Bright MCP: 60% pass · 7626 tokens · 6.4s p50. BrightData MCP: 65% · 16120 tokens · 7.3s p50.
[Method and tables](./evals/README.md#latest-tool-use-benchmark) · `openrouter/anthropic/claude-haiku-4.5` · 10 runs/case · 2026-07-21.
<!-- benchmark:end -->

| Dimension | BrightData MCP | Bright MCP |
|---|---:|---:|
| Model-visible tools | 60+ maximum | 5 base / 9 browser |
| Browser tools | 14 | 4 |
| Dataset tools | One per dataset | 3 composable tools |
| Dataset catalog | Tool inventory grows with products | Caller-scoped catalog behind discovery |
| Research | Search then agent-managed scraping | Batched SERP or explicit content-inclusive Discover |
| Large results | Returned through tool calls | Lazy, principal-bound snapshot resources |
| Runtime/toolchain | Node + npm + Vite | Bun-native |
| Production dependencies | 7 plus UI dependencies | Roughly 6–8, profile-dependent |
| API-specific code | Repeated across tools | Central adapters |
| Polling implementations | Repeated | One shared mechanism |
| Schema definitions | Repeated per tool | Catalog/operation-driven |
| Credentials | API key in endpoint configuration | BYOK from the client environment; never server-funded |
| Resources/tasks | Limited | First-class |
| Security/session controls | Relatively implicit | Explicit and bounded |
