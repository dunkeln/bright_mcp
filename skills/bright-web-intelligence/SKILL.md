---
name: bright-web-intelligence
description: Use Bright MCP for current web search, goal-ranked source discovery, exact page reading, structured extraction from known URLs, open-ended sourced research, and maintained Marketplace dataset discovery or execution. Trigger when a request needs live external evidence, structured web data, source-backed research, or interactive inspection of a Bright dataset result.
---

# Bright Web Intelligence

Use the narrowest Bright MCP tool that directly matches the requested outcome.

## Route by intent

| Source state | Requested outcome | Tool |
|---|---|---|
| Unknown | Compact links and summaries | `search_web` |
| Unknown, constrained by a goal | Ranked source shortlist | `discover_web` |
| Known URLs | Readable evidence | `read_web` |
| Known URLs | Exact source markup | `read_web` with `representation: source` |
| Known URLs | Temporary named fields | `extract_web` |
| Unknown | Sourced structured records | `research_web` |
| Maintained vertical data | Typed records | `find_datasets`, then `run_dataset` |

Do not replace `research_web` with repeated search-and-read calls when the user
asked for a sourced structured table. Do not call `find_datasets` when ordinary
web evidence is sufficient.

## Execute

1. Infer source certainty and output shape from the request.
2. Call one chart-ready or answer-ready tool first; avoid probe calls that do
   not advance the task.
3. Batch related queries or known URLs within the tool limits.
4. Keep preview mode for Deep Lookup unless the user explicitly accepts a full
   paid run and supplies the required cost cap.
5. Follow returned resource URIs for complete content or continuation pages;
   never invent cursors or expose opaque values as user input.
6. Cite returned sources and state when evidence is incomplete, truncated, or
   only a ranked shortlist.

## Handle results

- Treat `extract_web`, `research_web`, and `run_dataset` output as the canonical
  dataset result. Do not reinterpret upstream field names.
- Let compatible clients render the attached Dataset Workbench automatically.
  Never search for or invoke the MCP App as a separate tool.
- Use the workbench for human filtering, sorting, paging, inspection, quality,
  provenance, export, and bounded row selection.
- Continue to provide a useful text answer when the client does not render MCP
  Apps.

## Respect boundaries

- Never ask the user to paste `BRIGHTDATA_API_KEY` into chat. Ask them to
  configure the plugin or client connection when authentication is missing.
- Surface first-use zone creation or paid-run confirmation before proceeding.
- Do not claim that search rank, source volume, or dataset presence proves
  trustworthiness.
- Do not promise durable scheduling; Bright MCP currently discovers and runs
  datasets but does not create recurring delivery schedules.
