# MCP protocol routing

MCP primitives are selected by control semantics, not by upstream API shape.

## Model-visible tools

The six tools in `03-tool-contracts.md` are the complete base surface. The
browser profile adds only the four tools in `09-browser-capability.md`.
Presentation, polling, paging, and connection setup MUST NOT create tools.

## Resources

The server MUST expose these application-controlled resource families:

- `brightdata://results/{resultId}`: completed canonical result artifact backed
  by bounded local rows or lazy upstream snapshot parts.
- Opaque page URIs returned inside result resources: bounded continuation pages.
- `brightdata://web/{token}`: complete principal-bound Markdown behind a bounded
  `read_web` preview.
- `ui://bright-mcp/dataset-workbench-v2.html`: static workbench app document.
- Opaque browser session and observation resources when the browser profile is enabled.

Dataset definitions are returned directly by `find_datasets`. Result resources
MUST enforce principal ownership, size limits, media type, expiry, and
predictable not-found/expired errors.

## Tasks

`run_dataset` MAY advertise optional task execution. When negotiated, the task
owns durable status, progress, cancellation, and deferred result retrieval.
Upstream job IDs remain adapter-private.

Without task support, `run_dataset` MUST complete through bounded synchronous
waiting with progress and cancellation where supported, or return a normalized
timeout. It MUST NOT expose start, poll, status, or cancel as model-visible tools.

## App routing

The workbench app is a UI resource linked from `run_dataset` metadata. It projects
the same structured result and resource pages available to non-app clients.
App capability negotiation changes presentation only, never execution meaning,
result ownership, or artifact lifetime.

## Deferred primitives

- Prompts are outside v1; future prompts must be explicitly user-invoked
  workflows rather than hidden tool routing.
- Sampling is outside v1.
- Resource subscriptions and roots are outside v1 until a measured workflow
  requires them.
- App-only tools require the same evidence gate as any other added surface and
  MUST remain hidden from the model.

## Capability fallback rule

Every optional primitive MUST have one declared fallback. Lack of task or app
support may reduce durability or presentation quality, but MUST NOT make any of
the six base workflows unavailable. Disabling the browser profile removes its
four tools as one coherent capability rather than leaving partial browser state.
