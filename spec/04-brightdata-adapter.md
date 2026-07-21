# Bright Data adapter

## Ports

Base-profile use cases require four logical ports:

- Search: execute a canonical web-search request.
- Scrape: execute an ordered batch of canonical scrape requests.
- Dataset catalog: find and describe dataset capabilities.
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

- Catalog entries MUST use stable local capability IDs independent of endpoint
  paths and upstream display names.
- Each entry MUST define upstream identity, agent description, input schema,
  defaults, limits, and normalization function.
- V1 MAY use a versioned bundled catalog behind the catalog port.
- Replacing the catalog source with an upstream discovery API MUST NOT change
  tool contracts.
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

## Error translation

Authentication, authorization, validation, quota, timeout, cancellation,
upstream availability, and malformed-response failures MUST map to stable local
error codes. Unknown upstream failures MUST be retryable only when evidence
supports retrying.

Raw upstream data MAY be retained in debug-only diagnostics after redaction; it
MUST NOT be returned as the public contract by default.
