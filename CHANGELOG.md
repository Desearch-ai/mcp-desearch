# Changelog

Package version is unchanged in the annotations change (`0.1.2` in `package.json`). Do not treat this file as a publish.

## Unreleased

### Tool annotations

`tools/list` sets MCP tool annotations on every tool:

- `readOnlyHint: true` — the tool reads Desearch, the web, or X and does not write caller state
- `destructiveHint: false` — it does not perform a destructive update
- `openWorldHint: true` — results come from live external sources

These are hints. A call still bills the Desearch API key. Repeating a call is not free.
