# Desearch for Herdr

Two native Herdr actions connect to `https://mcp.desearch.ai/mcp` using
`x-api-key`: `ai.desearch.discover` lists the shared server's tool metadata;
`ai.desearch.search` calls its read-only `web-search` tool once. Search logic
and tool schemas remain in the shared MCP service. No model-provider key is needed.

Requirements: Herdr 0.9.5 or newer, Node 20.18.1 or newer, npm and Git.
The manifest declares macOS, Linux and Windows; the native smoke was run on macOS.
There are no startup hooks, automatic searches, background jobs or automatic retries.
The MCP SDK is pinned in package-lock.json. A request times out after 30 seconds.

## Install a reviewed revision

Use the full reviewed commit SHA from the draft PR. Installation runs `npm ci`
in this subtree, so this is a complete, separately installable package:

```sh
herdr plugin install Desearch-ai/mcp-desearch/plugin/integrations/herdr --ref <FULL_COMMIT_SHA> --yes
herdr plugin list
herdr plugin action list --plugin ai.desearch
```

For local review, export the subtree from that commit and build before linking:

```sh
mkdir desearch-herdr
 git archive <FULL_COMMIT_SHA>:plugin/integrations/herdr | tar -x -C desearch-herdr
cd desearch-herdr
npm ci --omit=dev --ignore-scripts
npm test
npm run lint
npm run build
herdr plugin link "$PWD"
```

Herdr plugins run as your user. Review the manifest, wrapper and dependencies
before installation. The GitHub topic that enables automatic marketplace indexing
is a separate publication decision.

## Configure and search

Get a Desearch key from https://console.desearch.ai/api-keys. Supply it as
`DESEARCH_API_KEY` in the environment of the **Herdr server**, before starting
that server. An already running server keeps its original environment; exporting
the variable only in an invocation terminal does not update it. Use a separate
test profile to avoid restarting an existing workspace. Never put a key in the
manifest, query file, shell command arguments or plugin root.

```sh
# Set DESEARCH_API_KEY securely in this shell before launching Herdr.
herdr server
# In another terminal with the same Herdr profile:
herdr plugin config-dir ai.desearch
```

Create `query.json` in the printed config directory:

```json
{"query":"Desearch official MCP documentation"}
```

Only a nonempty `query` string of at most 2000 characters is accepted. Use public
queries. Search is a billed read request under your Desearch account plan.

```sh
herdr plugin action invoke ai.desearch.discover
herdr plugin action invoke ai.desearch.search
herdr plugin log list --plugin ai.desearch --limit 10
```

Invocation returns a running log ID. Wait for its `succeeded` or `failed` status
in `plugin log list` before changing the query or running the next action.
Search results appear in that log's stdout as MCP JSON. Discovery without a key
is allowed by the service. Missing and invalid keys are tested at the protected
search call and fail. Malformed query files fail locally before network access.
Service/auth/network failures produce a generic error and nonzero exit status;
raw server errors and keys are never printed. Each action closes its transport.
There are zero automatic retries. Inspect the completed log before any manual
retry. A failed or uncertain response is not proof that the search was unbilled.

Herdr retains logs, including queries and result text. It also retains plugin config
and state across uninstall. Follow your local retention policy. This wrapper writes
no durable state and does not save credentials.

## Disable and remove

Wait for running actions to finish, then:

```sh
herdr plugin disable ai.desearch
herdr plugin uninstall ai.desearch
# For local development links instead:
herdr plugin unlink ai.desearch
herdr plugin list
```

Removal unregisters the actions; invoking them must fail. Herdr may retain source
installations for active processes and preserves config/state. Remove your own
`query.json` manually if needed. Rollback is to uninstall this plugin and reinstall
a previously reviewed SHA. No server configuration or shared MCP service changes
are needed. Report problems at
https://github.com/Desearch-ai/mcp-desearch/issues.

## Source contract

Validated against Herdr 0.9.5 plugin v1, upstream tag `v0.9.5`
(`7573e821895d32c8d1f78b3f6c9a2f85a46df4ac`), and Desearch MCP 0.10.0.
Official references, retrieved 2026-11-14 Asia/Tbilisi:

- https://herdr.dev/tui/docs/plugins/
- https://herdr.dev/tui/docs/marketplace/
- https://herdr.dev/tui/docs/cli-reference/
- https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/schema/plugins.rs
- https://www.desearch.ai/docs/guide/sdk/mcp

The shared `plugin/skills/desearch/SKILL.md` explains broader tool selection.
This wrapper deliberately exposes only discovery and public web search; it does
not expose background people/company task creation as a native action.
