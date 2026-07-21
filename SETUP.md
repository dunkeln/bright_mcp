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

Local development uses stdio with your local credential. Hosted HTTP serves
`/mcp` and requires `MCP_PUBLIC_URL` plus a caller-provided Bearer key.

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
filter, and full Deep Lookup runs are paid on the caller's account and
require acknowledgement in their typed inputs; Deep Lookup also requires a
pre-trigger maximum-cost cap. Preview remains its default.

## Browser profile

The live browser profile uses Bright Data Browser API credentials, not the
regular API token:

```dotenv
MCP_BROWSER_PROFILE=brightdata
BRIGHTDATA_BROWSER_USERNAME=replace-with-your-browser-api-username
BRIGHTDATA_BROWSER_PASSWORD=replace-with-your-browser-api-password
```

No local browser is launched or downloaded. To run the opt-in paid remote
navigation check, also set `BRIGHTDATA_BROWSER_CHECK=1`, then run:

```bash
bun run check:compat
```

## Hosted authorization

Set `MCP_PUBLIC_URL=https://<host>/mcp`. Clients send
their Bright Data API key as a Bearer token from their own environment. The
server uses its hash as the session identity, keeps the key only in bounded
memory for at most one hour, and never stores it or includes it in MCP
content. Hosted mode requires HTTPS, rejects deployment-global credentials, and
requires the Bearer key on every MCP request. Set `MCP_ALLOWED_ORIGINS` to a
comma-separated browser-origin allowlist when needed.
