# Desearch plugin

Plugin bundle for the Desearch MCP server. It is meant to move to a public `Desearch-ai/desearch-plugin` repository after founder approval. This folder is the bundle. It does not publish itself.

The server is the npm package `desearch-mcp-server`. The tools call Desearch for AI search, X search, web search, page extraction, and X trends.

## Requirements

- Node.js 18 or newer, so `npx` can start the server
- A Desearch API key from [console.desearch.ai/api-keys](https://console.desearch.ai/api-keys)

Export the key before you start the client:

```bash
export DESEARCH_API_KEY="your-api-key"
```

The MCP config launches `npx -y desearch-mcp-server` and passes `DESEARCH_API_KEY` through from that environment. The bundle does not contain a key.

## Claude Code

Manifest: `.claude-plugin/plugin.json` ([plugin manifest](https://code.claude.com/docs/en/plugins-reference)).
MCP config: `.mcp.json` at the plugin root ([MCP servers in plugins](https://code.claude.com/docs/en/plugins)).

`.mcp.json` expands `${DESEARCH_API_KEY}` from the environment into the server process.

Load this directory while you develop:

```bash
claude --plugin-dir ./plugin
```

Check the manifest:

```bash
claude plugin validate ./plugin
```

## Cursor

Manifest: `.cursor-plugin/plugin.json` ([Cursor plugins](https://cursor.com/docs/plugins)).
MCP config: `mcp.json` at the plugin root ([plugins reference](https://cursor.com/docs/reference/plugins)).

`mcp.json` sets `DESEARCH_API_KEY` from `${env:DESEARCH_API_KEY}`.

To try it locally, copy this directory to `~/.cursor/plugins/local/desearch`, then run Developer: Reload Window. Open Customize and confirm the Desearch skill and MCP server. Local plugin imports must be allowed.

## Skill

`skills/desearch/SKILL.md` tells the agent which Desearch tool to call. It lists only the tools the server registers.

## Grok Build marketplace draft

`grok-marketplace-entry.json` is a draft catalog entry for [xai-org/plugin-marketplace](https://github.com/xai-org/plugin-marketplace). Grok Build reads `.claude-plugin/plugin.json` and `.mcp.json` from the plugin repository.

Do not open that pull request yet. The entry points at `https://github.com/Desearch-ai/desearch-plugin.git`, which does not exist until the bundle is moved. Replace `sha` with the full 40-character commit from `git ls-remote` before anyone submits it. The placeholder is all zeros so it cannot match a real commit.

After the public repository exists, the marketplace change is a pull request that adds this object to `.grok-plugin/marketplace.json`, then:

```bash
python3 scripts/generate-plugin-index.py
python3 scripts/validate-catalog.py
```
