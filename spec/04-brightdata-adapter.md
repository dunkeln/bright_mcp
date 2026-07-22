# Bright Data adapter

## Ports

Base-profile use cases require five logical ports:

- Search: execute a canonical web-search request.
- Discover: rank a constrained source shortlist through Bright Data Discover.
- Read: execute an ordered batch of canonical readable Markdown or source HTML requests.
- Dataset catalog: find directly executable dataset capabilities.
- Dataset runner: validate and execute one described `collect` or `search` operation.

Ports MAY be structural types or documented function signatures. They MUST NOT
require an inheritance hierarchy.

The browser profile adds the separate `BrowserProvider` port defined in
`09-browser-capability.md`. Dataset and browser adapters MAY share credential,
logging, cancellation, and request-context utilities but not upstream payload types.

## Client ownership

One injected Bright Data gateway MUST own:

- API base URL and bearer authentication.
- User-agent, client identity, request ID, and content headers.
- Finite connection and response timeouts.
- Bounded retries with explicit retryable status/error rules.
- Cancellation propagation.
- Redacted request and response logging.

The gateway MUST resolve credentials through the injected provider for the
trusted request principal. Local deployments MAY inject a single static
credential; hosted deployments MUST resolve a user- or tenant-bound credential.
Credentials MUST never enter core use-case input, tool input, canonical result,
resource URI, app payload, or log record.

## Dataset catalog

- Catalog entries MUST use one stable local ID per live upstream dataset,
  independent of endpoint paths and display names.
- The account-scoped Marketplace list and metadata endpoints MUST supply
  discoverability and output fields, cached by caller principal.
- A small versioned manifest MUST identify documented Scraper API datasets whose
  trigger schema is known, because Marketplace metadata does not expose those
  input schemas. Manifest entries MAY remain discoverable when the account's
  Marketplace list endpoint is unavailable; execution still uses the same
  `marketplace:` ID and lets the upstream product enforce account access.
- Duplicate IDs or invalid schemas MUST fail startup rather than fail during an
  agent call.

## Dataset execution

The adapter MUST perform this sequence once for all datasets:

1. Resolve the catalog entry.
2. Validate and normalize input.
3. Apply adapter-owned defaults and fixed upstream fields.
4. Submit the upstream request.
5. Poll asynchronous work with a deadline, cancellation, and bounded interval.
6. Normalize rows, columns, pagination, warnings, and errors.
7. Enforce result row and serialized-size limits.

Dataset-specific code MAY normalize semantics but MUST NOT duplicate transport,
polling, authentication, retry, or error logic.

Search operations MAY call an upstream record-search API rather than trigger a
collection. That upstream distinction remains adapter-owned; both operations
return the same canonical dataset result and continuation resource semantics.

Supported small Marketplace lookups SHOULD use synchronous Search. Other
Marketplace filters MUST use the asynchronous Filter snapshot path and MUST NOT
silently inherit unsupported sort semantics. Synchronous Search MUST retain
`search_after` and `total_hits` internally so canonical result resources can
continue without exposing an upstream cursor to the agent.

Deep Lookup MUST back `extract_web` and `research_web` without appearing in
dataset discovery. Preview is the default; a full run requires explicit cost
acknowledgement and a maximum-cost cap.

Bright Data Discover MUST back `discover_web`. Its trigger and polling IDs remain
adapter-private; the canonical result contains only the ranked source shortlist.

## Error translation

Authentication, authorization, validation, quota, timeout, cancellation,
upstream availability, and malformed-response failures MUST map to stable local
error codes. Unknown upstream failures MUST be retryable only when evidence
supports retrying.

Raw upstream data MAY be retained in debug-only diagnostics after redaction; it
MUST NOT be returned as the public contract by default.
