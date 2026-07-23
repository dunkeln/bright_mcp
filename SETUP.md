# Setup

Use the Bun version in `.bun-version`.

```bash
bun install --frozen-lockfile
bun run build
bun run typecheck
bun run check:adapters
bun run check:browser
bun run check:compat
bun run check:coverage
MCP_TRANSPORT=stdio bun run start
```

Local development uses stdio with your local credential. Hosted HTTP serves the
fixed capability endpoints under `/mcp` and requires `MCP_PUBLIC_URL` plus
caller-provided credentials.

## Develop the MCP App

Run the dataset workbench in a normal browser with schema-valid fixture data:

```bash
bun run dev:app
```

Open `http://localhost:3000`. Changes under `src/` rebuild the production-aligned
bundle and reload the preview. Set `APP_PORT` to use another port. This preview
does not start the MCP server, use credentials, or call Bright Data; verify the
final host bridge through the MCP compatibility check and a real MCP Apps host.

## Bright Data credentials

Credentials are required. Bright MCP never substitutes demo data in a running
server.

For live dataset and web calls on macOS, prefer the system Keychain:

```bash
bun run connect:brightdata
```

Then set `BRIGHTDATA_CREDENTIAL_SOURCE=keychain` in the MCP process environment.
Run `bun run disconnect:brightdata` before replacing or revoking the stored
token.

For headless local development, set environment variables in the process that
starts the MCP server. Bun also reads a gitignored `.env.local`, so this is a
valid local alternative:

```dotenv
BRIGHTDATA_API_KEY=replace-with-your-api-token
```

SERP and Web Unlocker zones are discovered automatically. If one is missing,
the first relevant call creates `bright_mcp_serp` or `bright_mcp_unlocker` using
Bright Data's account API. Zone creation requires an Admin or Ops key and may
affect billing. Explicit `BRIGHTDATA_SERP_ZONE` and
`BRIGHTDATA_UNLOCKER_ZONE` overrides remain available for existing zones.

Never commit a populated environment file. Credentials and zone names are read
only by the composition root and never enter tool inputs or results.

`search_web` uses caller-funded SERP. Dataset collection, Marketplace search/
filter, and full `extract_web` or `research_web` runs are paid on the caller's account and
require acknowledgement in their typed inputs; full extraction and research
also require a pre-trigger maximum-cost cap. Preview remains their default.

## Browser profile

The live browser profile uses the same Bright Data API key as the data tools and
resolves an existing active Browser API zone internally:

```dotenv
MCP_BROWSER_PROFILE=brightdata
```

Exactly one active Browser API zone is selected automatically. If the account
has multiple active zones, set `BRIGHTDATA_BROWSER_ZONE` for local stdio or add
`?zone=<name>` to the hosted `/mcp/browser` URL. The server never creates a
Browser API zone.

No local browser is launched or downloaded. To run the opt-in paid remote
navigation check, also set `BRIGHTDATA_BROWSER_CHECK=1`, then run:

```bash
bun run check:compat
```

For stdio, select one stable surface with
`MCP_PROFILE=all|web|deep-lookup|marketplace|browser`. The default is `all`;
`browser` also requires `MCP_BROWSER_PROFILE=brightdata`.

## Hosted authorization

Set `MCP_PUBLIC_URL=https://<host>/mcp`. `/mcp`, `/mcp/web`,
`/mcp/deep-lookup`, `/mcp/marketplace`, and `/mcp/browser` accept the caller's
Bright Data API key through `X-Bright-API-Key`. The MCP client owns the secret
and sends it on every request. Claude Code plugins bind it from sensitive
`userConfig`; Codex plugins may send it as a bearer credential so each client's
install-time vault can own the secret. The browser surface resolves native zone
credentials internally. The server uses a hash as the session identity, keeps
the raw key only for the active request or upstream operation, and never caches,
persists, or includes it in MCP content. Hosted mode
requires HTTPS, rejects deployment-global credentials, and requires the
surface's authorization on every MCP request. Set `MCP_ALLOWED_ORIGINS` to a
comma-separated browser-origin allowlist when needed.
