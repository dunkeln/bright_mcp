# Architecture

## Dependency direction

```text
MCP transport / BYOK credential boundary
            ↓
MCP tools, resources, and tasks
            ↓
Agent-oriented use cases
            ↓
Canonical contracts and ports
            ↓
Bright Data adapters
            ↓
Bright Data APIs
```

Dependencies MUST point downward. Upstream payloads and MCP protocol objects
MUST NOT become core domain models.

## Responsibilities

### MCP boundary

- Registers tools and resources, converts MCP input to use-case input, and maps
  canonical results to MCP content and `structuredContent`.
- Selects a startup-fixed or path-fixed capability profile before registration;
  it does not mutate tool inventory from runtime entitlement probes.
- Negotiates optional task and app capabilities without changing use-case
  meaning.
- Contains no credential collection, polling, or upstream response parsing.

### Credential boundary

- Binds hosted sessions to a digest of the caller's Bright Data key.
- Resolves local credentials from explicit environment or Keychain input.
- Keeps Bright Data credentials out of use-case input,
  tool schemas, canonical results, resources, and app payloads.
- Keeps browser sessions isolated while deriving their native zone credentials
  from the same API-key principal used by data profiles.

### Core

- Defines source search, intent-ranked source discovery, exact page reading, ad
  hoc extraction, open-ended research, catalog discovery, and maintained dataset execution use cases, plus
  browser session use cases when that profile is enabled.
- Exact reading returns bounded readable Markdown or source HTML previews plus
  complete transient resources. Ad hoc extraction and research use Deep Lookup; maintained
  structured extraction remains in dataset execution.
- Owns canonical result and error contracts.
- Depends only on injected ports.

### Bright Data adapter

- Owns upstream authorization-header construction from resolved credentials,
  URLs, timeouts, retries, polling, request shapes, response parsing, and error
  mapping.
- Combines the caller-scoped Marketplace catalog, a small executable collector
  manifest, Deep Lookup, synchronous record search, and asynchronous
  snapshots behind the stable core ports.
- Implements the ports required by core use cases.
- Browser support is a separate adapter implementing `BrowserProvider`; it uses
  Bright Data's remote Scraping Browser and does not become a local browser host.

### MCP app

- Projects canonical structured results for human inspection and selection.
- Contains no Bright Data client and receives no credentials.

## Composition root

The executable entrypoint MUST perform all wiring:

1. Read and validate Bun runtime configuration.
2. Construct the transport-bound credential provider.
3. Construct the Bright Data gateway, adapter implementations, and catalog.
4. Inject ports into core use cases.
5. Register MCP tools, resources, optional tasks, and the app resource.
6. Start stdio or the Bun-hosted Web-standard MCP transport.

No module other than the composition root MAY read environment variables or
construct production dependencies.

## Suggested module boundaries

```text
src/core/          canonical contracts, ports, use cases, errors
src/adapters/      Bright Data client, catalog, polling, normalization
src/browser/       browser contracts, sessions, and Bright Data CDP adapter
src/connections/   local and hosted credential providers
src/mcp/           tool/resource registration and MCP result mapping
src/app/           interactive result projection
src/main.*         composition root
```

TypeScript on Bun is specified; exact file names are not. Boundary behavior is.

## Change isolation acceptance rule

Given an upstream fixture whose field names or polling envelope changes, only
the Bright Data adapter and its fixture MAY require modification when the
canonical meaning is unchanged.
