# Authorization and Bright Data connections

MCP access authorization and Bright Data credential connection are separate
trust boundaries with separate tokens, storage, and failure semantics.

## Remote MCP authorization

Hosted Streamable HTTP deployments that separate MCP access from Bright Data
credentials MUST implement the authorization profile of their negotiated MCP
protocol version, with `2025-11-25` as the v1 compatibility baseline. They MUST
use established authorization-server and token-validation libraries. The MCP
server acts as a protected resource server; it MUST NOT implement an ad-hoc
login protocol.

- Publish OAuth Protected Resource Metadata and require the configured
  authorization server to publish OAuth or OpenID Connect discovery metadata.
- Use authorization-code flow with PKCE and exact redirect URI validation.
- Require the MCP server resource indicator and validate issuer, audience,
  expiry, signature, and required scopes on every request.
- Return standards-compliant `401` and incremental `403 insufficient_scope`
  challenges.
- Require short-lived access tokens and refresh-token rotation where applicable;
  reject expired or invalid tokens.
- Never forward the MCP access token to Bright Data.

Public BYOK deployments MAY instead accept the user's Bright Data API key as an
environment-backed Bearer header over HTTPS. In this profile the bearer is the
upstream credential, not an MCP OAuth access token. The server MUST bind
sessions to a one-way credential digest, retain the raw key only in bounded
memory, require it on every MCP request, and MUST NOT persist or log it.

The authorization policy owns the mapping from scopes to use cases. Dataset
execution and other cost-incurring calls MUST be distinguishable from catalog
inspection when the authorization server supports incremental consent.

## Local stdio credential setup

Stdio deployments MUST NOT pretend to implement HTTP OAuth. They SHOULD resolve
the Bright Data credential from an OS keychain populated by a local login/setup
command. Environment injection MAY be used for CI, containers, and explicit
headless configuration.

Local setup MUST NOT write a credential into repository files, MCP tool
configuration emitted to logs, or command history by default.

## Bright Data credential connection

The public upstream contract uses a Bright Data API token. A missing hosted
connection SHOULD trigger MCP URL-mode elicitation to a server-owned HTTPS
connection page. The page MAY link to the Bright Data token settings page, but
the token MUST be submitted directly to the connection service, never through
form elicitation, a tool argument, the model, or an MCP result.

The connection service MUST:

1. Re-authenticate or verify the initiating MCP principal.
2. Bind short-lived, single-use state to that principal and deployment tenant.
3. Accept the token only over HTTPS, validate it against a bounded upstream call,
   and show a deterministic success or repair message.
4. Encrypt the credential at rest through a secret manager or OS keychain.
5. Notify completion when supported; clients MUST also permit manual retry.
6. Support replacement and revocation without changing tool contracts.

If URL elicitation is unsupported, the server MUST return an actionable
connection-required error pointing to the documented local or hosted setup
route. It MUST NOT ask the agent to obtain or repeat the token.

## Composed providers

Credential resolution MUST use a small injected contract such as
`getCredential(principalContext)`. V1 implementations MAY include:

- keychain provider for interactive local use;
- environment provider for explicit headless use; and
- encrypted vault provider for hosted user- or tenant-bound use.

The Bright Data gateway consumes this contract. Core use cases and the dataset
catalog do not know how credentials are acquired or stored. Providers compose
at the executable root; they do not form an inheritance hierarchy.

## Secret-handling invariants

- Credentials MUST NOT appear in URLs, tool schemas, resources, task state, app
  payloads, logs, traces, errors, analytics, or model context.
- Hosted result and task access MUST be authorized against the initiating
  principal, not possession of an opaque ID alone.
- Connection state MUST expire, resist replay and cross-tenant binding, and be
  auditable without recording secrets.
- Credential validation failures MUST distinguish missing, rejected, expired,
  and insufficient upstream permission without returning upstream secrets.
