# Bright MCP specification

Status: v1 product and architecture specification.

## Objective

Build an open-source MCP integration that lets an agent discover, invoke, and
interpret Bright Data capabilities without prior knowledge of Bright Data's
internal API or product organization.

The MCP owns the agent-facing contract. Bright Data remains the upstream data
plane for collection, scraping, proxying, discovery, and browser services.

## Required outcomes

- Agent workflows are task-oriented, validated, and understandable.
- Upstream API changes are isolated from MCP contracts.
- Useful capability coverage of the reference Bright Data MCP is preserved by
  composition, without tool-name or tool-count compatibility.
- Results remain useful to an agent without an interactive host.
- Supporting hosts can progressively enhance dataset results through an MCP app.
- Long-running work and complete artifacts use MCP tasks and resources without
  expanding the model-visible tool surface.
- Credentials, resource limits, and service configuration remain user-controlled.
- Bun is the runtime, package manager, test runner, and server substrate; the
  dependency graph remains explicit, pinned, and replaceable at adapters.

## V1 scope

- An all-capabilities profile of seven model-visible tools: `search_web`,
  `discover_web`, `read_web`, `extract_web`, `research_web`, `find_datasets`,
  and `run_dataset`.
- Fixed web, Deep Lookup, and Marketplace profiles exposing the corresponding
  three-, two-, and two-tool groups without runtime tool-list mutation.
- A separate browser profile exposing `browser_navigate`, `browser_observe`,
  `browser_interact`, and `browser_close` for Bright Data Scraping Browser.
- A table MCP app attached to `run_dataset`; it is not a separate tool.
- Complete-page and completed-result resources, with optional task-backed
  execution for `run_dataset`.
- MCP transport authorization, Bright Data credential connection, request
  adaptation, asynchronous polling, result normalization, and error translation.
- Full upstream feature parity is outside v1.

## Specification map

- [01-principles.md](01-principles.md): design laws and tool-surface rules.
- [02-architecture.md](02-architecture.md): boundaries, dependencies, composition.
- [03-tool-contracts.md](03-tool-contracts.md): v1 tools and canonical results.
- [04-brightdata-adapter.md](04-brightdata-adapter.md): upstream integration contract.
- [05-mcp-app.md](05-mcp-app.md): interactive result projection.
- [06-safety-quality-evolution.md](06-safety-quality-evolution.md): threats,
  verification, delivery slices, and change rules.
- [07-protocol-routing.md](07-protocol-routing.md): tools, resources, tasks, and
  capability fallbacks.
- [08-authorization-and-connections.md](08-authorization-and-connections.md):
  MCP authorization and Bright Data credential connection.
- [09-browser-capability.md](09-browser-capability.md): remote browser tools,
  sessions, resources, and adapter boundary.
- [10-runtime-and-dependencies.md](10-runtime-and-dependencies.md): Bun runtime,
  package policy, dependency inventory, and compatibility gates.
- [11-capability-coverage.md](11-capability-coverage.md): semantic compatibility
  target, reference mappings, and exclusions.

`.codex/memories/brightdata_mcp.md` is reference material about another
implementation. It is not a design authority for this project.
