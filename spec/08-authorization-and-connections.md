# Bright Data credentials

Bright MCP is user-funded. A hosted deployment MUST NOT use a deployment-wide
Bright Data credential or silently substitute fixture data.

## Hosted BYOK

Hosted Streamable HTTP clients MUST send their Bright Data API key as an
environment-backed `Authorization: Bearer` header over HTTPS. The server MUST:

- require the key on every MCP request;
- bind sessions, results, tasks, and resources to a one-way key digest;
- retain the raw key only in a bounded in-memory cache for at most one hour;
- never persist, log, return, or place the key in model-visible content; and
- reject deployment-global Bright Data credentials at startup.

The bearer is the upstream Bright Data credential, not a separately issued MCP
OAuth token. Revocation and replacement happen in the caller's Bright Data
account and client environment.

The hosted browser profile is a distinct credential boundary. `/mcp/browser`
MUST accept caller-owned Scraping Browser username/password through HTTPS Basic
authorization, bind sessions and artifacts to a namespaced digest of both
values, retain the raw pair only in bounded memory for at most one hour, and
never accept the regular API key as a substitute. Data profiles MUST NOT accept
Browser API credentials.

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
- Hosted result and task access MUST be authorized against the initiating key
  digest, not possession of an opaque ID alone.
- Invalid, rejected, or insufficient credentials MUST fail closed.
