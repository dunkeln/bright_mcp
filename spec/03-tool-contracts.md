# V1 agent contracts

The V1 base profile MUST expose exactly these five model-visible tools. All tools MUST provide MCP
annotations describing read-only, destructive, idempotent, and open-world
behavior accurately.

## `search_web`

Purpose: find current web resources relevant to a query.

- Input: non-empty `query`; optional engine, locale, and pagination cursor.
- Output: canonical search results containing title, URL, summary, and optional
  continuation cursor.
- Engine-specific response envelopes MUST NOT escape the adapter.

## `scrape`

Purpose: retrieve readable content from one or more known URLs.

- Input: one to five HTTP(S) URLs and an optional `markdown` or `html` format.
- Output: one ordered result per URL with content or a normalized item error.
- Batch execution is part of this contract; no separate batch tool is exposed.
- Optional `extraction` contains bounded instructions plus a typed field
  projection using the contract's supported scalar, object, and array kinds.
  The MCP compiles that projection to Zod 4; it does not accept arbitrary JSON
  Schema or add an `extract` tool.
- Extraction MUST use an injected provider and declare provenance and validation
  failure. It MAY use negotiated MCP sampling but MUST NOT require sampling when
  another configured provider supplies the capability.

## `find_datasets`

Purpose: find Bright Data datasets relevant to an agent's stated task.

- Input: non-empty natural-language `query`; optional result limit of 1–10.
- Output: ranked capability summaries with stable ID, title, summary, and
  required input names.
- Output MUST contain only candidates accepted by `describe_dataset`.

## `describe_dataset`

Purpose: obtain the executable contract for one dataset.

- Input: stable dataset ID returned by `find_datasets`.
- Output: stable ID, title, description, supported operations, an input JSON
  Schema for each operation, and documented limits or examples when available.
- V1 operation kinds are `collect` and `search`; a dataset MAY support either or
  both. Search schemas describe filters, sorting, page size, and continuation.
- Unknown or unavailable IDs MUST return a normalized actionable error.

## `run_dataset`

Purpose: execute one described dataset capability.

- Input: dataset ID, one operation returned by `describe_dataset`, and arguments
  validated against that operation's described schema.
- Output: the canonical dataset result below.
- Triggering and polling are internal; the agent sees one logical operation.
- Execution SHOULD be task-backed when the client negotiates task support and
  MUST preserve the same logical result when it does not.
- A completed call MUST include a bounded preview and a resource link to the
  completed result artifact.
- Tool metadata MUST reference the table app resource.

## Canonical dataset result

```text
DatasetResult {
  schemaVersion: 1
  resultId
  dataset: { id, title }
  operation: collect | search
  columns: [{ key, label, type? }]
  rows: [JSON object]
  rowRefs: [opaque string]
  page: { nextResourceUri?, truncated, totalRows? }
  artifact: { uri, mediaType, expiresAt? }
  warnings: [{ code, message }]?
}
```

- Column keys MUST be unique and every row MUST be JSON-serializable.
- `rowRefs` MUST align one-to-one with `rows`; each value is server-generated,
  unique within the result, opaque to clients, and stable only for the result's
  lifetime.
- Embedded rows are a bounded preview or current page; omission MUST be declared.
- Result and page resource URIs MUST be opaque, authorization-checked, and
  stable only for their stated lifetime.
- `artifact.uri` MUST identify the same canonical result represented by the
  embedded preview; it MUST NOT contain a credential.

## Canonical failure

```text
CapabilityError { code, message, retryable, nextAction?, requestId? }
```

Messages MUST be actionable and MUST NOT contain credentials, raw authorization
headers, or unbounded upstream response bodies.

## Explicit exclusions

- No endpoint-per-dataset tools.
- No `show_tables` or other presentation-only tool.
- No generic untyped action dispatcher.

The opt-in browser profile is specified separately in
`09-browser-capability.md`; it MUST NOT alter these five contracts.
