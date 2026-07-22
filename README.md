<div align="center">
  <img src="./assets/icon.png" alt="Bright MCP" width="320" />
  <br />
  <i>unofficial Bright Data MCP</i>
</div>

Agent-oriented Bright Data capabilities over MCP, built on Bun. The seven-tool
all profile separates search, ranked source discovery, exact reading, extraction, research, maintained
dataset discovery, and execution. It pages complete pages and upstream snapshots
as resources and renders structured results in a transient React MCP workbench.

The full seven-tool contract remains at `/mcp`. Entitlement-aligned installs can
use stable three or two-tool surfaces at `/mcp/web`, `/mcp/deep-lookup`, or
`/mcp/marketplace`; Scraping Browser is a separate four-tool surface at
`/mcp/browser`. Tool lists never change after initialization based on a probe.

## Install

Install from [`server.json`](./server.json) in clients that support MCP Registry
remote metadata. The client prompts once for `X-Bright-API-Key`, keeps it in its
own secret store, and adds it to each HTTP request. The key is never exposed to
the model.

Clients that do not yet implement registry secret prompts can reference
`BRIGHTDATA_API_KEY` from their own configuration:

### Plugin

Codex:

```bash
codex plugin marketplace add dunkeln/bright_mcp
codex plugin add bright@bright
```

Claude Code:

```bash
claude plugin marketplace add dunkeln/bright_mcp
claude plugin install bright@bright
```

### MCP

Codex:

```toml
[mcp_servers.bright]
url = "https://bright-mcp.onrender.com/mcp"

[mcp_servers.bright.env_http_headers]
X-Bright-API-Key = "BRIGHTDATA_API_KEY"
```

Claude Code:

```bash
claude mcp add --transport http bright https://bright-mcp.onrender.com/mcp \
  --header "X-Bright-API-Key: ${BRIGHTDATA_API_KEY}"
claude mcp add --transport http bright-browser https://bright-mcp.onrender.com/mcp/browser \
  --header "X-Bright-API-Key: ${BRIGHTDATA_API_KEY}"
```

Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "bright": {
      "url": "https://bright-mcp.onrender.com/mcp",
      "headers": { "X-Bright-API-Key": "${env:BRIGHTDATA_API_KEY}" }
    },
    "bright-browser": {
      "url": "https://bright-mcp.onrender.com/mcp/browser",
      "headers": { "X-Bright-API-Key": "${env:BRIGHTDATA_API_KEY}" }
    }
  }
}
```

The key is forwarded over HTTPS for each request and is not cached or persisted by Bright MCP.
Available live capabilities follow the products enabled on that Bright Data account.
The browser surface selects the account's sole active Browser API zone automatically. For multiple
active zones, append `?zone=<name>` once to the `bright-browser` URL.

Choose the narrowest surface your account and workflow need:

| Endpoint | Tools | Bright Data access | Client header |
|---|---|---|---|
| `/mcp` | All seven data tools | SERP, Discover, Web Unlocker, Deep Lookup, Marketplace as used | `X-Bright-API-Key` |
| `/mcp/web` | `search_web`, `discover_web`, `read_web` | SERP + Discover + Web Unlocker | `X-Bright-API-Key` |
| `/mcp/deep-lookup` | `extract_web`, `research_web` | General Deep Lookup | `X-Bright-API-Key` |
| `/mcp/marketplace` | `find_datasets`, `run_dataset` | Account-visible Marketplace datasets | `X-Bright-API-Key` |
| `/mcp/browser` | Four `browser_*` tools | Scraping Browser | `X-Bright-API-Key`; native zone credentials resolved internally |

Choose among the seven data tools by intent:

| Sources | Needed result | Tool |
|---|---|---|
| Unknown | Compact links and summaries | `search_web` |
| Unknown, goal-constrained | Ranked source shortlist | `discover_web` |
| Known URLs | Readable page evidence | `read_web` |
| Known URLs | Exact source HTML | `read_web` with `representation: source` |
| Known URLs | Temporary named fields | `extract_web` |
| Unknown | Sourced structured records | `research_web` |
| Maintained vertical data | Typed records | `find_datasets` then `run_dataset` |

See [SETUP.md](./SETUP.md) for local development, credentials, live checks, and
hosted authorization.

## Evaluated with MCPJam

<!-- benchmark:start -->
Bright MCP uses `@mcpjam/sdk` to run real-world agent workflows against its
published MCP endpoints. The suite checks task completion, tool selection,
valid arguments, provenance, latency, tool calls, token use, and answer quality.

![Paired horizontal bars comparing MCP completion by workflow](./assets/benchmark-completion.png)

*Bright MCP completed 29 of 30 workflows; Bright Data MCP completed 29 of 30.*

![Radar chart comparing blind answer-quality dimensions](./assets/benchmark-radar.png)

*Blind scoring compares task fulfillment, grounding, information density, source quality, and actionability.*

![Horizontal bars comparing blind pairwise preference](./assets/benchmark-preference.png)

*The blind judge preferred Bright MCP 17 times versus 3 for Bright Data MCP, with 10 ties.*

![Paired horizontal bars comparing judged answer quality per token budget](./assets/benchmark-quality-cost.png)

*Quality per token shows where richer answers repay their context cost.*

![Paired horizontal bars comparing benchmark passes per token budget](./assets/benchmark-efficiency.png)

*Passing runs per token compares workflow completion against total model context used.*

![Paired horizontal bars comparing average tool calls by workflow](./assets/benchmark-complexity.png)

*Average tool calls show the agent path each workflow required.*

In the comparative baseline, Bright MCP completed 29 of 30 workflows; Bright Data MCP completed 29 of 30.
Bright MCP scored 4.51/5 versus 3.78/5 in blind answer-quality grading and was
preferred in 17 runs versus 3, with 10 ties.

This study predates the current profile routing and retry changes. Its quality
results remain useful, while its latency, call-count, and token measurements
should be treated as a historical baseline.

[Method, scenarios, and full results](./evals/README.md#full-tool-use-benchmark-pre-routing-baseline)
<!-- benchmark:end -->
