# Bright Data credentials

Bright MCP is user-funded. A hosted deployment MUST NOT use a deployment-wide
Bright Data credential or silently substitute fixture data.

## Hosted BYOK

Hosted Streamable HTTP clients MUST keep their Bright Data API key in a
client-owned credential. The canonical hosted flow MUST use MCP OAuth 2.1
discovery, dynamic public-client registration, authorization code with S256
PKCE, and resource indicators. The authorization page MAY accept the Bright
Data key only over an HTTPS form POST and MUST validate it before issuing
credentials.

The authorization server MUST remain stateless with respect to durable user
credentials. It MUST seal the key into authenticated-encryption access and
refresh tokens stored by the MCP client. It MAY also use an encrypted,
Secure, HttpOnly, SameSite browser cookie so a second capability endpoint does
not require the key to be pasted again. The deployment MUST own only the
token-encryption key, not a caller credential database.

Clients without MCP OAuth MAY send the key as `X-Bright-API-Key` over HTTPS.
Raw Bright Data keys MUST NOT be accepted as OAuth bearer tokens. If both the
direct header and bearer authorization are present, the request MUST fail
closed. The server MUST:

- require the key on every MCP request;
- advertise protected-resource and authorization-server metadata;
- bind OAuth tokens to the exact requested MCP resource;
- validate registered redirect URIs and PKCE at code exchange;
- reject expired, malformed, tampered, replayed, or wrong-audience tokens;
- bind sessions, results, tasks, and resources to a one-way key digest;
- retain the raw key only for the active request, upstream operation, or
  authenticated-encryption client credential;
- never persist, log, return, or place the key in model-visible content; and
- reject deployment-global Bright Data credentials at startup.

Each hosted MCP session MUST receive an isolated task store. Closing the
session or reaching a task TTL MUST cancel any still-running upstream work
before its task state is discarded.

OAuth refresh tokens MUST expire. Revocation and replacement ultimately happen
by rotating the key in the caller's Bright Data account; rotating the hosted
token-encryption key MAY invalidate all outstanding client credentials.

The hosted browser profile MUST accept the same caller-owned API key through
OAuth or the fallback direct header. It MUST discover active `browser_api` zones and
resolve the selected zone's native username/password internally. With exactly
one active zone it selects that zone automatically; with none it returns an
actionable enablement error; with multiple it requires the optional `zone`
query preference on the browser MCP URL. Resolved native credentials MUST be
retained only for the active browser connection and never returned, logged,
persisted, or exposed to the client. The server MUST NOT create a Browser API
zone automatically.

## Local stdio

Stdio resolves the Bright Data key from macOS Keychain or explicit environment
injection. It MUST fail startup when neither exists. Local setup MUST NOT place a
credential in repository files, emitted tool configuration, or command history
by default.

## Product zones

The adapter MUST discover active zones from the caller's account. When a needed
SERP or Web Unlocker zone is absent, it MUST attempt to create the deterministic
`bright_mcp_serp` or `bright_mcp_unlocker` zone through Bright Data's account
API. The tool description and annotations MUST disclose that first-use account
mutation. Permission or billing failures MUST remain actionable upstream errors;
fixture data is never a fallback.

## Secret invariants

- Credentials MUST NOT appear in URLs, tool schemas, resources, task state, app
  payloads, logs, traces, errors, analytics, or model context.
- Authorization responses MUST use `Cache-Control: no-store`, restrictive CSP,
  no-referrer policy, and exact registered redirects.
- Hosted result and task access MUST be authorized against the initiating key
  digest, not possession of an opaque ID alone.
- Invalid, rejected, or insufficient credentials MUST fail closed.
