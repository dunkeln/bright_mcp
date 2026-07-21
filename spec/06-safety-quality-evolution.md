# Safety, quality, delivery, and evolution

## Trust boundaries

- MCP input is untrusted and MUST be schema-validated.
- Catalog data is trusted only after startup validation.
- Bright Data responses are untrusted and MUST be shape-checked and bounded.
- Remote pages and browser observations are untrusted and MUST be bounded.
- App content and selection messages are untrusted at each message boundary.

## STRIDE controls

- Spoofing: trust principals only after configured transport authorization;
  resolve Bright Data credentials only through the injected provider; bind
  hosted credentials and result resources to that principal.
- Tampering: validate tool input, catalog definitions, upstream responses, and
  app messages.
- Repudiation: propagate a request ID through MCP, core, adapter, and logs.
- Information disclosure: redact credentials, headers, URL user-info, and
  oversized upstream error bodies; never place credentials in resource or
  connection URLs.
- Denial of service: bound URLs per call, schema depth, polling deadline,
  concurrency, row count, serialized size, and app context updates.
- Elevation of privilege: v1 has no local file or shell tool; browser actions use
  a fixed typed allowlist, principal-bound sessions, and startup-fixed capabilities.

## Verification

- Contract checks MUST prove each tool accepts valid input and rejects invalid
  input at the MCP boundary.
- Adapter fixture checks MUST cover success, polling, timeout, cancellation,
  malformed response, quota, and authentication failures.
- A boundary check MUST demonstrate an upstream shape change is isolated to the
  adapter when canonical meaning is unchanged.
- MCP smoke checks MUST list exactly five base tools and exactly nine tools when
  the browser profile is enabled, then complete each representative workflow.
- Protocol checks MUST cover `run_dataset` with and without task support,
  authorized result-resource paging, and a host without app support.
- Coverage checks MUST exercise dataset collection, filtered dataset search,
  browser history navigation, and schema-validated structured extraction.
- App checks MUST cover fallback content, schema-version rejection, keyboard
  interaction, safe text rendering, and selected-row context.
- Browser checks MUST cover session ownership, expiry, navigation, observation,
  typed interaction, cancellation, close, and credential/CDP-endpoint redaction.

## V1 vertical slices

1. Pass the Bun/package compatibility gate in `10-runtime-and-dependencies.md`.
2. Compose fake ports with `find_datasets`, `describe_dataset`, and synchronous
   `run_dataset` for one representative dataset and result resource.
3. Add the real Bright Data gateway, a local credential provider, one catalog
   entry, polling, and error mapping.
4. Add optional task-backed execution while preserving the synchronous result.
5. Render the canonical result in the table app with text fallback.
6. Add `search_web` and `scrape` through the same core/adapter boundaries.
7. Add the opt-in browser profile through a fake provider, then Bright Data CDP.
8. Add hosted authorization and credential connection as a deployment slice.
9. Expand the catalog as data; do not expand either profile's tool surface.

Each slice MUST run end to end before the next begins. Full upstream parity is
not a release gate.

Semantic capability coverage is a release gate as defined in
`11-capability-coverage.md`; undocumented disappearance of a reference capability
is a failure even when the new MCP intentionally uses fewer tools.

## Observability

Logs MUST include operation, request ID, duration, attempt count, terminal state,
and redacted upstream status. Metrics SHOULD cover success, error code, latency,
poll duration, result size, and tool-selection evaluation outcomes.

## Contract evolution

- Tool names and required inputs are versioned public contracts.
- Additive optional fields MAY ship within a schema version.
- Removing or changing field meaning requires a new schema version and migration
  path.
- Adapter and catalog changes MUST NOT require MCP contract changes when agent
  semantics are unchanged.
- The MCP app MUST support every non-retired `DatasetResult.schemaVersion`.

## Tool-surface change gate

Adding a tool beyond the declared five-tool base or nine-tool browser profile
requires recorded evidence of recurring selection, validation, permission,
state, or outcome ambiguity that cannot be resolved by a typed field or
discovery result. Removal or merging requires equivalent completion evidence.
