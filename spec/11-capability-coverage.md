# Semantic capability coverage

## Compatibility target

V1 targets semantic capability compatibility with the reference Bright Data MCP,
not compatibility with its tool names, schemas, counts, implementation, modes, or
bugs. A capability is covered when an agent can reach the same useful outcome
through a documented tool, resource, task, app, prompt, or composition.

Every reference capability MUST have one of three recorded dispositions:

- `composed`: reachable through the V1 public contracts;
- `internalized`: performed automatically by an adapter or protocol primitive; or
- `excluded`: intentionally absent with a user-visible consequence and reason.

An upstream endpoint or newly added reference tool does not automatically become
a requirement. Coverage is judged by agent outcome and Bright Data product
capability, not endpoint inventory.

## V1 reference mapping

| Reference capability | V1 disposition |
|---|---|
| Search, batch search, engines, pagination | `search_web` |
| Intent-ranked research with selected page content | `search_web: ranked | deep` composed with `scrape` |
| Markdown/HTML scrape and batch scrape | `scrape` |
| Schema-directed extraction | `scrape.extraction` via `ExtractionProvider` |
| Web Data collectors | dataset discovery, description, `run_dataset: collect` |
| Dataset fields and filtered record search | description, `run_dataset: search` |
| Deep Lookup question-to-table research | virtual dataset through discovery and `run_dataset: search` |
| Trigger, poll, status, cancellation | adapter plus optional MCP task |
| Result paging and complete artifacts | MCP resources |
| Dataset result tables | optional table MCP app |
| Browser navigation, history, observation, actions | four browser-profile tools |
| Tool groups and Pro mode | deployment capability profiles |
| Session statistics | internalized observability |
| Credential and zone setup | connection and Bright Data adapter boundaries |

The reference scraping-strategy and diagnostic prompts are optional guidance,
not Bright Data service capabilities, and are excluded from mandatory V1.

## Acceptance rule

Maintain a versioned coverage fixture containing the reference capability,
disposition, V1 route, and verification scenario. Release checks MUST fail when
a previously covered capability loses its route or an exclusion lacks a reason.
This fixture MUST NOT generate tool registrations or couple V1 to reference names.
