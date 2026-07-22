# V1 browser capability

## Boundary and profile

The browser profile controls Bright Data Scraping Browser: a remote Chromium
session reached over CDP/WebSocket. It MUST NOT launch or expose a local browser.
The profile is separate because it has a different credential, state, cost,
open-world mutation, and four-tool contract. It has no data tools and no
required MCP app.

## Tool surface

- `browser_navigate`: accept a destination union of `{kind: "url", url}`,
  `{kind: "back"}`, or `{kind: "forward"}`. URL navigation MAY create a session;
  history navigation requires an owned existing session.
- `browser_observe`: return one bounded typed observation: accessibility snapshot,
  readable text, HTML, screenshot resource, or bounded network summary.
- `browser_interact`: perform one action from a discriminated union: click, type,
  select, press, wait for a declared condition, or scroll.
- `browser_close`: idempotently close an owned session and release resources.

Selectors, timeouts, observation sizes, redirects, downloads, and action counts
MUST be bounded. Arbitrary scripts, raw CDP commands, local paths, extension
installation, and credential-bearing URLs MUST NOT be accepted.

## Port and adapter

Core depends on an injected `BrowserProvider` for create/navigate, observe,
interact, and close. The Bright Data browser adapter alone owns the CDP endpoint,
authentication, Playwright objects, upstream errors, and cleanup. MCP schemas and
canonical browser results MUST NOT expose Playwright or CDP types.

`playwright-core` is the sole browser client candidate for v1 and MUST pass the
Bun compatibility gate before its version is frozen. The full `playwright`
package and bundled browser downloads are excluded.

## Session and resource rules

- Session IDs are opaque, unguessable, principal-bound, TTL-limited, and subject
  to per-principal and global concurrency limits.
- Session state lives behind an injected bounded store; no tool owns global state.
- Screenshots and large observations use authorization-checked, expiring resources.
- Close, expiry, cancellation, transport loss, and shutdown all attempt cleanup.
- Logs and errors MUST redact credentials, CDP URLs, cookies, page secrets, and
  sensitive form values.
