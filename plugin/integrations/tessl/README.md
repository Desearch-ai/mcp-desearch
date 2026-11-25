# Desearch for Tessl

A Tessl package containing the existing Desearch tool-selection skill and a launcher for the released Desearch MCP server. The skill is copied unchanged from `plugin/skills/desearch/SKILL.md`. No server implementation is bundled.

## Local installation

Install the Tessl CLI from <https://docs.tessl.io/introduction-to-tessl/installation> and use Node.js 20.18.1 or later. Get a Desearch API key at <https://console.desearch.ai/api-keys> and set `DESEARCH_API_KEY` in the environment used to start your coding agent. Keep the key out of project files and version control.

From a separate test project, run these commands, replacing the example absolute path with this checkout's path:

```sh
tessl init --agent claude-code
tessl install file:/absolute/path/to/mcp-desearch/plugin/integrations/tessl --agent claude-code
tessl list --json
```

Restart Claude Code after installation. Tessl installs the skill and materializes the bundled MCP configuration in the test project's `.mcp.json`. Claude Code expands `${DESEARCH_API_KEY:-}` from its environment, using an empty value when the variable is unset so the server's missing-key check rejects startup. Other agent hosts may need their own environment-forwarding configuration; do not assume they expand this syntax. The launcher runs `npx -y desearch-mcp-server@0.10.0` and forwards `DESEARCH_API_KEY` from the agent's environment. The manifest contains a variable reference, never a key value.

Ask the agent to use Desearch `web-search` for a current web query. Check that the result contains titles and URLs. Repeat with another query. Without a key the server should refuse to start; an invalid key should return an authentication error without exposing credentials. Use a valid key before retrying.

Search calls use your Desearch balance. People Search and Company Search create billed background tasks; use them only when explicitly requested. The skill documents their authorization and lifecycle behavior.

## Validate and pack

From the repository root:

```sh
cmp plugin/skills/desearch/SKILL.md plugin/integrations/tessl/skills/desearch/SKILL.md
tessl plugin lint plugin/integrations/tessl
tessl plugin pack plugin/integrations/tessl --output /tmp/desearch-tessl-0.1.0.tgz
shasum -a 256 /tmp/desearch-tessl-0.1.0.tgz
```

The package contains only the skill, metadata, launcher configuration, README, and MIT license. It has no hooks, server source, or release workflow. Tessl's registry filters some file types on publication; all content in this package uses supported text formats or the documented manifest/configuration paths.

## Registry publication

This is a private local candidate, version `0.1.0`. `desearch/desearch` is a proposed workspace/package name, not proof of workspace ownership, availability, or an existing registry listing. Do not treat the local install as a registry submission.

The free account entry is <https://tessl.io/login>, then **Create account**, using your team account. Before publication, confirm the actual authorized workspace and package-name availability. If the candidate name changes, update the manifest and repeat lint, pack, local install, smoke, and QA on that exact revision. Run the documented publish dry run only after authenticating to the intended workspace. Public visibility is a separate registry approval step; this candidate keeps `private: true`. This package is prepared for local validation; it has not been published.

Format and command references, checked 2026-11-17:

- <https://docs.tessl.io/reference/configuration>
- <https://docs.tessl.io/guides/use/tile-to-plugin-migration>
- <https://docs.tessl.io/creating-skills-and-plugins/develop-and-test-locally>
- <https://docs.tessl.io/creating-skills-and-plugins/publish-and-update>
- <https://docs.tessl.io/introduction-to-tessl/set-up-tessl>
- <https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json>
