# V1 agent contracts

The V1 base profile MUST expose exactly these six model-visible tools. All tools MUST provide MCP
annotations describing read-only, destructive, idempotent, and open-world
behavior accurately.

## `search_web`

Purpose: find current web resources for one or more related research angles.

- Input: one to five ordered non-empty queries with optional engine, locale,
  and pagination cursor.
- Output: one ordered result group per query containing title, URL, summary,
  continuation cursor, or isolated error.
- Search MUST use SERP and MUST NOT expose a mode that switches to another
  Bright Data product with different access, cost, latency, or failure semantics.
- Engine-specific response envelopes MUST NOT escape the adapter.
- Page content MUST be acquired explicitly through `read_web`; search results
  remain compact so one discovery call cannot exhaust the model context.

## `read_web`

Purpose: retrieve exact readable evidence from one or more known URLs.

- Input: one to five HTTP(S) URLs.
- Output: one ordered Markdown preview per URL, a complete principal-bound
  resource URI, or a normalized item error.
- Batch execution is part of this contract; no separate batch tool is exposed.
- The contract has no format or extraction mode. A truncated inline preview MUST
  retain the complete Markdown through its returned resource.

## `extract_web`

Purpose: extract temporary structured fields from known URLs.

- Input: one to five known HTTP(S) URLs, one to twenty named field descriptions,
  and Deep Lookup preview/cost controls.
- Output: the canonical dataset result below, with source URLs represented in
  the extracted rows.
- The tool MUST use a real structured extraction backend and MUST NOT label
  regex, selector guesses, or caller-side Markdown interpretation as completed
  extraction.
- Preview is the default. Full extraction requires explicit cost acknowledgement
  and a caller-supplied maximum-cost cap.

## `research_web`

Purpose: turn an open-ended objective into a sourced structured table.

- Input: non-empty objective, result limit, preview flag, and full-run cost controls.
- Output: the canonical dataset result below.
- Use this tool when the relevant pages are not known. Known-page reading and
  extraction remain `read_web` and `extract_web` respectively.
- Preview is the default. Full research requires explicit cost acknowledgement
  and a caller-supplied maximum-cost cap.

## `find_datasets`

Purpose: find Bright Data datasets relevant to an agent's stated task.

- Input: non-empty natural-language `query`; optional result limit of 1–10.
- Output: ranked executable definitions with stable ID, title, description,
  supported operations, an input JSON Schema for each operation, and documented
  limits and examples.
- V1 operation kinds are `collect` and `search`; a dataset MAY support either or
  both. Search schemas describe filters, sorting, page size, and continuation.
- Output MUST contain only candidates accepted by `run_dataset`.

## `run_dataset`

Purpose: execute one maintained dataset capability.

- Input: dataset ID, one operation returned by discovery, and a strict argument
  union for URL collection, keyword collection, or filtered record search. The
  selected dataset applies its narrower discovered schema before execution.
- Output: the canonical dataset result below.
- Triggering and polling are internal; the agent sees one logical operation.
- Execution SHOULD be task-backed when the client negotiates task support and
  MUST preserve the same logical result when it does not.
- A completed call MUST include a bounded preview and a resource link to the
  completed result artifact.
- Paid operations MUST require an explicit acknowledgement.
- Tool metadata MUST reference the versioned workbench app resource.

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
`09-browser-capability.md`; it MUST NOT alter these six contracts.
