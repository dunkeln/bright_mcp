# MCP app contract

## Role

The app is the interactive projection of `run_dataset` output. It is not an
independent capability and MUST NOT be registered as a model-visible tool.

`run_dataset` MUST return useful text content and canonical
`structuredContent`. Hosts without MCP app support receive the text fallback;
supporting hosts resolve the app resource from tool metadata.

## Data contract

- The app consumes `DatasetResult` directly.
- Additional pages MUST be read through the result resource URIs supplied by
  the server and the host's resource bridge.
- The app MUST reject unsupported `schemaVersion` values visibly.
- The app MUST NOT reinterpret raw upstream field names or response envelopes.
- Agent-visible and human-visible rows MUST originate from the same result.
- The app MUST NOT fetch Bright Data APIs or receive service credentials.

## V1 interaction

- Render dataset title, columns, rows, truncation state, and warnings.
- Support keyboard-accessible sorting, text filtering, pagination, and ordered
  row selection.
- Send bounded selected-row context to the host when that capability exists.
- Preserve source row identity when sorting, filtering, or paging.
- Render arbitrary values as text; never execute result HTML or script.

Charts, editing, export, direct network fetching, and browser control are outside
this app contract. The separate browser profile has no required MCP app in v1.

## Host behavior

- Unsupported host capabilities MUST degrade without breaking result display.
- Hosts without MCP app support MUST retain the complete text, structured
  preview, and resource workflow; task support is negotiated independently.
- Host-context changes SHOULD update theme and available interactions.
- App errors MUST be visible in the app and MUST NOT mutate the tool result.
- Selection-context failures MAY be retried by the user and MUST NOT discard the
  current selection.

## Security and accessibility

- Default CSP MUST allow no external connections or resources.
- All user-facing controls MUST have accessible names and keyboard operation.
- Focus order, selection state, sort state, warnings, and pagination changes
  MUST be programmatically exposed.
- Light, dark, narrow, and embedded layouts MUST preserve readable data.

## Payload bounds

The server owns result limits. The app MUST avoid rendering all rows at once and
MUST bound model-context updates by both row count and serialized size.
