# Architecture

## Dependency direction

```text
MCP transport / optional HTTP authorization
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
- Negotiates optional task and app capabilities without changing use-case
  meaning.
- Contains no credential collection, polling, or upstream response parsing.

### Authorization and connection boundary

- Authenticates remote MCP requests and produces a trusted principal context.
- Resolves the deployment-appropriate Bright Data credential provider.
- Keeps MCP access tokens and Bright Data credentials out of use-case input,
  tool schemas, canonical results, resources, and app payloads.

### Core

- Defines search, scrape, catalog discovery, dataset description, and dataset
  execution use cases, plus browser session use cases when that profile is enabled.
- Structured extraction depends on an injected `ExtractionProvider`; provider
  choice and sampling protocol objects MUST NOT enter the scrape contract.
- Owns canonical result and error contracts.
- Depends only on injected ports.

### Bright Data adapter

- Owns upstream authorization-header construction from resolved credentials,
  URLs, timeouts, retries, polling, request shapes, response parsing, and error
  mapping.
- Implements the ports required by core use cases.
- Browser support is a separate adapter implementing `BrowserProvider`; it uses
  Bright Data's remote Scraping Browser and does not become a local browser host.

### MCP app

- Projects canonical structured results for human inspection and selection.
- Contains no Bright Data client and receives no credentials.

## Composition root

The executable entrypoint MUST perform all wiring:

1. Read and validate Bun runtime configuration.
2. Construct transport authorization and the credential provider.
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
src/connections/   credential providers and account-connection flow
src/mcp/           tool/resource registration and MCP result mapping
src/app/           interactive result projection
src/main.*         composition root
```

TypeScript on Bun is specified; exact file names are not. Boundary behavior is.

## Change isolation acceptance rule

Given an upstream fixture whose field names or polling envelope changes, only
the Bright Data adapter and its fixture MAY require modification when the
canonical meaning is unchanged.
