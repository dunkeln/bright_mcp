<div align="center">
  <img src="./assets/icon.png" alt="Bright MCP" width="320" />
  <br />
  <i>unofficial iteration on BrightData API served as MCP</i>
</div>

Agent-oriented Bright Data capabilities over MCP, built on Bun. The five-tool
base profile includes canonical web search, ordered batch scraping, dataset
discovery and execution, result resources, optional MCP tasks, and a React table
MCP App.

See [SETUP.md](./SETUP.md) for local development, credentials, live checks, and
hosted authorization.

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
