<div align="center">
  <h1>Bright MCP</h1>
  <i>unofficial iteration on BrightData API served as MCP</i>
</div>

Agent-oriented Bright Data capabilities over MCP, built on Bun. The five-tool
base profile includes canonical web search, ordered batch scraping, dataset
discovery and execution, result resources, optional MCP tasks, and a React table
MCP App.

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

Set `BRIGHTDATA_API_KEY` to route dataset execution to the documented Amazon
Products Search scraper. Set `BRIGHTDATA_SERP_ZONE` and
`BRIGHTDATA_UNLOCKER_ZONE` to route `search_web` and `scrape` through the SERP and
Web Unlocker APIs. Without an API key, bounded in-memory demo ports keep the full
MCP and app loop runnable. Structured extraction requires an injected provider
and otherwise returns an actionable capability error. Credentials and zone names
are read only by the composition root and never enter tool inputs or results.

Set `MCP_BROWSER_PROFILE=demo` to enable the four-tool browser profile against a
bounded fake provider. The default is `disabled`, keeping the model-visible base
surface at five tools. Set the profile to `brightdata` with
`BRIGHTDATA_BROWSER_USERNAME` and `BRIGHTDATA_BROWSER_PASSWORD` to connect
`playwright-core` to Bright Data's remote Browser API; no local browser is
launched or downloaded. Run the opt-in live compatibility gate with
`BRIGHTDATA_BROWSER_CHECK=1 bun run check:compat`; it performs a paid remote
navigation only when explicitly requested.


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
