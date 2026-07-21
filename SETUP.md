# Setup

Use the Bun version in `.bun-version`.

```bash
bun install --frozen-lockfile
bun run build
bun run typecheck
bun run check:adapters
bun run check:browser
bun run check:compat
bun run check:auth
bun run check:connection
bun run check:coverage
bun run start
```

The HTTP MCP endpoint is `http://localhost:8787/mcp`; the health endpoint is
`http://localhost:8787/`. Set `MCP_TRANSPORT=stdio` to use stdio instead.

## Bright Data credentials

Credentials are optional. Without them, the default `auto` profile uses the
bounded demo adapters. Set `BRIGHTDATA_PROFILE=demo` to select them explicitly.

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
BRIGHTDATA_PROFILE=live
BRIGHTDATA_API_KEY=replace-with-your-api-token
BRIGHTDATA_SERP_ZONE=replace-with-your-serp-zone
BRIGHTDATA_UNLOCKER_ZONE=replace-with-your-web-unlocker-zone
```

Never commit a populated environment file. Credentials and zone names are read
only by the composition root and never enter tool inputs or results.

Structured extraction uses MCP host sampling. Hosts without sampling receive an
actionable per-page extraction error while retaining scraped content.

## Browser profile

Use the bounded fake provider locally without credentials:

```dotenv
MCP_BROWSER_PROFILE=demo
```

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

Put the HTTP server behind TLS and set `MCP_AUTH_MODE=oidc`,
`MCP_PUBLIC_URL=https://<host>/mcp`, and `MCP_OIDC_ISSUER` to an HTTPS issuer
with OAuth/OIDC discovery, a JWKS endpoint, and PKCE S256 support. Access tokens
must be signed JWTs with the configured issuer and resource audience, `sub`,
`iat`, `exp`, and a lifetime no longer than `MCP_MAX_TOKEN_AGE_SECONDS` (one hour
by default). Set `MCP_ALLOWED_ORIGINS` to a comma-separated browser-origin
allowlist when needed.

The protected resource advertises `mcp:access`; cost-bearing capabilities use
incremental `bright:web`, `bright:datasets:run`, and `bright:browser` scopes.
`bun run check:auth` starts a temporary issuer and verifies discovery, JWT and
scope enforcement, and cross-principal result isolation.

For real hosted Bright Data calls, set `BRIGHTDATA_PROFILE=live` and configure:

- `MCP_OIDC_CLIENT_ID` and, for a confidential client, `MCP_OIDC_CLIENT_SECRET`;
- the exact redirect URI `https://<host>/connections/brightdata/callback` at the
  authorization server;
- an absolute `MCP_VAULT_PATH` on persistent storage; and
- `MCP_VAULT_KEY` as a secret-manager-injected 32-byte key encoded as 64 hex
  characters.

When a principal has no credential, URL-capable MCP clients receive the secure
connection page. Other clients receive the manual route
`https://<host>/connections/brightdata`. The token is accepted only on that
server page, checked against Bright Data's read-only account-status endpoint,
and encrypted with principal- and deployment-bound AES-GCM before storage.
Replacement uses the same connection route; revocation is available at
`https://<host>/connections/brightdata/revoke`. `bun run check:connection`
verifies PKCE, principal binding, replay resistance, encrypted storage,
completion notification, manual fallback, and session isolation without a real
Bright Data credential.

The built-in hosted vault uses Bun SQLite and therefore targets one Bun instance
with a persistent volume. Replace the credential provider before running
multiple instances that need shared writes. Hosted OIDC mode rejects
deployment-global Bright Data API and Browser API credentials; local/headless
mode may continue to use explicit environment or Keychain settings.
