# Desearch for Jan Agent

A git-installable Jan skill and hosted MCP declaration. Search logic runs in the
shared Desearch service. No local server, hook, or runtime dependency is installed.
You need Jan Agent with plugin support, network access, and a Desearch API key
from [Console](https://console.desearch.ai/api-keys).

## Install and connect

From your project, install this repository's plugin subdirectory:

```sh
jan plugin install https://github.com/Desearch-ai/mcp-desearch/tree/main/plugin/integrations/jan
jan plugin list
jan
```

For this draft branch, use Jan's explicit `#ref` override:

```sh
jan plugin install 'https://github.com/Desearch-ai/mcp-desearch/tree/main/plugin/integrations/jan#oto/T-596-jan'
```

This Jan version clones a branch/tag, so a raw commit SHA in the tree URL fails.
For an immutable reviewed commit, check it out and use the local export below.
Do not put a slash-containing branch in the tree URL's ref segment.
In Jan's interactive console run `/plugin setup desearch`, or `/plugin setup`
and select the `desearch` entry. Enter `DESEARCH_API_KEY` in the masked setup field, then choose
**Enable and connect**. Installation alone does not activate a connection.
The imported MCP name is `<installation-name>:desearch`; the tested Agent
version installs this payload as `desearch`, giving `desearch:desearch`. Use
`/mcp` to confirm the actual name and inspect discovered tools.

Invoke `/skill:desearch:desearch`. Ask for a public web
search, for example "Search for Jan Agent plugin documentation and cite links."
Check a real protected call; keyless discovery alone does not verify auth.

### Export for local git installation

Run from the root of a checkout at the commit you intend to test:

```sh
mkdir -p /tmp/desearch-jan-export
# Export this subtree as the git root, including the hidden MCP declaration.
git archive HEAD:plugin/integrations/jan | tar -x -C /tmp/desearch-jan-export
git -C /tmp/desearch-jan-export init
git -C /tmp/desearch-jan-export add .
git -C /tmp/desearch-jan-export commit -m 'Local Jan fixture'
jan plugin install file:///tmp/desearch-jan-export --project /path/to/test-project
```

Choose a new empty export directory for each commit. Do not install the parent
`plugin/` tree: that contains a different transport configuration. The exported
root is `plugin.toml`, `.mcp.json`, and `skills/desearch/SKILL.md` plus docs/tests.
Jan accepts skills without a commands directory; this wrapper needs no command.

### Headless explicit MCP configuration

The native smoke uses Jan's CLI configuration path, after installing/discovering
the plugin. It reads the endpoint/type from the exported payload's declaration;
it does not automate the interactive masked-key setup. In a dedicated test data
folder, the equivalent explicit configuration is:

```sh
export JAN_DATA_FOLDER=/path/to/private/jan-test-data
# Set DESEARCH_API_KEY with your secret manager. Do not echo or commit it.
jan cli mcp add desearch:desearch --type http \
  --url https://mcp.desearch.ai/mcp \
  --header "x-api-key=${DESEARCH_API_KEY}" --active
jan cli mcp list
```

The header argument is visible to local process inspection while this command
runs. Prefer masked interactive setup on a shared machine. Jan writes the
resulting MCP config with owner-only permissions; keep it out of source control.

## Disconnect and remove

Removing a plugin does **not** remove an imported MCP entry. First use `/mcp` to
disable/remove the server, then `/plugin remove <installation-directory>`.
For the exported fixture and headless configuration above:

```sh
jan cli mcp disable desearch:desearch
jan cli mcp remove desearch:desearch
jan plugin remove desearch --project /path/to/test-project
jan cli mcp list
jan plugin list --project /path/to/test-project
```

If your host version assigns a different installation name, substitute it.
A session can cache discovered tools, so start a fresh session to verify they
are absent. Restore service by
reinstalling the same reviewed commit and explicitly enabling its connection.

## Validation

From the repository root:

```sh
node --test plugin/integrations/jan/test/manifest.test.mjs
node --check plugin/integrations/jan/test/native-smoke.mjs
npm ci
npm run build
npm test
# Secret manager must supply DESEARCH_API_KEY. JAN_BIN must be absolute.
JAN_BIN=/absolute/path/to/jan node plugin/integrations/jan/test/native-smoke.mjs
```

The smoke requires a committed subtree. It exports the exact `HEAD`, creates a
local git fixture, installs it in a new Jan project, reads its skill through Jan,
and uses Jan's real MCP client for public Desearch searches. A loopback
OpenAI-compatible deterministic model fixture selects one tool call per cycle;
no real LLM provider is needed. This verifies host installation and MCP behavior,
not a model's autonomous choice of tools. It does not use a generic MCP client.

The test observes at least five minutes with two distinct successful searches
and an end-of-window search. It also checks missing/invalid keys at a protected
call, malformed input, a refused loopback connection, explicit disconnect and
removal, and config permissions. Automatic retries: zero. It redacts the supplied
key from emitted diagnostics and removes its private test data in `finally`.
Jan's project sessions live in its ordinary per-project store; no provider or
existing project configuration is changed.

## Sources and compatibility

Reference host: official Jan Agent `agent-nightly` **0.8.8-73**, published
2026-11-12. Docs retrieved 2026-11-14 Asia/Tbilisi. Jan Agent is a preview;
these plugin instructions are for Agent, not Jan Desktop's extension format.

- [Jan plugins](https://docs.jan.ai/agent/plugins): git/tree installs, conventional payload, explicit setup, namespaced skills and separate MCP removal.
- [Jan skills](https://docs.jan.ai/agent/skills): `name`/`description` frontmatter.
- [Jan MCP](https://docs.jan.ai/agent/mcp): HTTP headers and CLI management.
- [Jan source](https://github.com/janhq/jan/blob/20a20960dece5d84c95d833f41f786c2d5c2f3f6/src-tauri/src/core/agent/plugins.rs): optional `plugin.toml`, `[setup.env]`, and `.mcp.json` conventions. There is no separate manifest schema URI in these docs; the native parser is authoritative.
- [Desearch MCP](https://www.desearch.ai/docs/guide/sdk/mcp): hosted endpoint, `x-api-key`, public discovery and protected calls.

The skill adapts the search guidance in `plugin/skills/desearch/SKILL.md`, omitting
its stdio launch instructions and fixed tool count. No server implementation or
authentication behavior is changed. All server problems belong to the shared
service maintainer; this payload supplies configuration and instructions only.
