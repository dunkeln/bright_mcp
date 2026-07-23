# Runtime and dependency policy

## Bun baseline

Bun is the sole supported v1 runtime, package manager, script runner, test runner,
and server substrate. Production and CI MUST pin the same Bun version. The repo
MUST commit `bun.lock`, use `bun install --frozen-lockfile` in CI, execute TypeScript
directly, use `bun:test`, and prefer `Bun.serve` plus Web-standard MCP transports.

Bun-native `fetch`, WebSocket, streams, `AbortController`, timers, crypto, and
bundling SHOULD replace wrapper packages. Node is neither a supported runtime nor
a fallback deployment target. Node-compatible dependencies remain acceptable only
after they execute under the pinned Bun version.

Bun transpiles but does not type-check TypeScript. `typescript` and `@types/bun`
MUST be dev dependencies, with strict `tsc --noEmit` as a verification command.

## Dependency inventory

Required production dependencies are intentionally few:

- the official pre-stable MCP TypeScript SDK generation, including its server
  package, intentionally selected for its composable packages and Zod 4 support;
- Zod 4 for every MCP boundary and local runtime schema;
- the OpenAI Apps UI SDK package selected by the app implementation;
- `playwright-core`, only when the browser profile is built or enabled;
- `p-limit` for explicit bounded upstream and browser concurrency; and
- `lru-cache` behind session/result store ports for bounded local deployments.

A structured logger such as `pino` MAY be added only after Bun verification and a demonstrated need beyond the injected
logger contract. Optional packages MUST not become core types.

Do not add Ajv, Axios, Express, Hono, FastMCP, a DI container, a retry framework,
an ORM, a queue, the full Playwright package, Vitest, Jest, or a second schema
library without a recorded requirement that Bun, MCP SDK, Zod, or small local
composition cannot meet.

## Version and change policy

- Pin exact direct-dependency and Bun versions; no range prefixes.
- The pre-stable MCP SDK generation and Zod 4 are deliberate choices; pre-stable
  status is an accepted v1 risk. Isolate their types in `src/mcp` so SDK churn
  does not cross into core contracts.
- Renovation is one dependency family at a time with lockfile, typecheck, smoke,
  and contract results recorded.
- Transitive duplication and install size are observed, not optimized speculatively.

## Compatibility gate before implementation

Using the pinned Bun version, a disposable spike MUST prove:

1. MCP SDK plus Zod 4 registers and invokes one tool and reads one resource.
2. Stdio and Bun-hosted Web-standard Streamable HTTP transports both work.
3. Task negotiation and OAuth-authenticated data and browser Streamable HTTP
   execute as specified, with the direct client-secret header fallback verified
   separately.
4. `playwright-core` connects to Bright Data CDP, navigates, observes, and closes.
5. The table app bundle loads as an MCP UI resource in a target host.

Freeze package versions only after this gate passes. A failing item changes the
adapter or package choice; it does not justify leaking SDK types into core.
