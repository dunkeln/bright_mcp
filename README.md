<div align="center">
  <h1>Bright MCP</h1>
  <i>unofficial iteration on BrightData API served as MCP</i>
</div>

Agent-oriented Bright Data capabilities over MCP, built on Bun. The current
vertical slice includes dataset discovery, exact dataset description, synchronous
demo execution, authorized-in-process result resources, opaque pagination, and a
React table MCP App. Bright Data network calls are the next adapter slice.

## Run locally

Requires the Bun version in `.bun-version`.

```bash
bun install --frozen-lockfile
bun run build
bun run typecheck
bun run check:compat
bun run start
```

The HTTP MCP endpoint is `http://localhost:8787/mcp`; the health endpoint is
`http://localhost:8787/`. Set `MCP_TRANSPORT=stdio` to use stdio instead. The
compatibility check exercises both transports and the complete demo dataset flow.

The current slice exposes `find_datasets`, `describe_dataset`, and `run_dataset`.
The five-tool base profile becomes complete when the later `search_web` and
`scrape` vertical slice lands; no placeholder tools are registered in the meantime.

Set `BRIGHTDATA_API_KEY` to route those dataset tools to the documented Amazon
Products Search scraper. Without it, the server uses the bounded in-memory demo
catalog so the entire MCP and app loop remains runnable. Credentials are read
only by the composition root and never enter tool inputs, results, resources, or
the app.


| Dimension | BrightData MCP | Bright MCP |
|---|---:|---:|
| Model-visible tools | 60+ maximum | 5 base / 9 browser |
| Browser tools | 14 | 4 |
| Dataset tools | One per dataset | 3 composable tools |
| Runtime/toolchain | Node + npm + Vite | Bun-native |
| Production dependencies | 7 plus UI dependencies | Roughly 6–8, profile-dependent |
| API-specific code | Repeated across tools | Central adapters |
| Polling implementations | Repeated | One shared mechanism |
| Schema definitions | Repeated per tool | Catalog/operation-driven |
| Authentication | Mostly embedded configuration | Separate provider boundary |
| Resources/tasks | Limited | First-class |
| Security/session controls | Relatively implicit | Explicit and bounded |
