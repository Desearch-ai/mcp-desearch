# Desearch Search for AnythingLLM

A native AnythingLLM agent skill that forwards a public web query to the existing
Desearch `web-search` MCP tool at `https://mcp.desearch.ai/mcp`. Search logic stays
in the shared server. Results are returned as text with source links, titles and
snippets. This skill does not expose background people/company tasks.

Requires Node.js 20.18.1 or newer. The source host used for validation is AnythingLLM
1.19.0 at commit `4d09fa5f730698d39f1d783e47316744b260a700`, using its
`skill-1.0.0` manifest schema. The bundled MCP SDK is pinned to 1.30.1.

## Build and install locally

From this directory:

```sh
npm ci
npm run validate -- /path/to/anything-llm/server/utils/agents/imported-manifest.schema.json
npm test
npm run lint
npm run build
export ANYTHINGLLM_STORAGE=/path/to/anythingllm/storage
mkdir -p "$ANYTHINGLLM_STORAGE/plugins/agent-skills"
# Confirm there is no existing desearch-search skill there before extracting.
tar -xzf desearch-search.tgz -C "$ANYTHINGLLM_STORAGE/plugins/agent-skills"
```

The archive contains `desearch-search/plugin.json`, `handler.js`, CommonJS
`package.json`, lockfile, README, license and production `node_modules`. Install
this folder into storage; the parent folder must match `hubId` (`desearch-search`).
Bundled dependencies avoid changes to AnythingLLM's dependencies.

Reload Agent Skills settings. Configure `DESEARCH_API_KEY` using a key from
https://console.desearch.ai/api-keys, then enable **Desearch Search**.
The shipped manifest is disabled and contains no key. AnythingLLM persists skill
settings in its local storage: restrict access to that directory and never share
an installed/configured directory or include it in an archive. Search uses your
Desearch balance; see https://www.desearch.ai/pricing.

Start a fresh `@agent` session and ask: "Search the web for Desearch MCP
documentation." The skill accepts only `{"query":"a public web query"}` (non-empty,
maximum 2000 characters). It returns a string. Use public search data only.

## Failures and removal

The wrapper makes one protected search call per invocation with zero automatic
retries. Each invocation creates and closes its own MCP client. A 60-second total
transport deadline bounds network requests. Network, auth and service errors
return generic text without service diagnostics. Inspect the service state before
a manual retry after an uncertain result. The endpoint is fixed and HTTP
redirects are rejected. Missing keys and malformed input fail before networking.

Disable the skill in Agent Skills and `/exit` any active agent session. Start a
fresh session to confirm the skill is absent. Remove only the
`plugins/agent-skills/desearch-search` directory from your own storage, or use the
host's Delete skill action. Reload settings to confirm removal. This removes the
locally stored skill key too; revoke a key in Console if you no longer need it.
There is no background worker, remote configuration or persistent MCP connection.

## Reproduce native-host smoke

Use AnythingLLM's actual source loader and agent dispatcher at the commit above.
The validation environment uses Node 22.23.1. In the host's `server` directory:

```sh
npm install --legacy-peer-deps --ignore-scripts --no-audit --no-fund
npm install --legacy-peer-deps --ignore-scripts --no-audit --no-fund --no-save zod@3.25.76
npx prisma generate
npx prisma migrate deploy
```

These local dependency workarounds resolve an upstream Apache Arrow peer conflict
and a transitive `zod/v3` export mismatch; the host source is unchanged. Node 26
cannot load an upstream dependency that uses the removed `SlowBuffer` API.
From this skill's directory, use a new empty local test storage directory:

```sh
STORAGE_DIR=/absolute/path/to/empty-test-storage NODE_ENV=production DISABLE_TELEMETRY=true \
  node test/native-host.cjs /absolute/path/to/anything-llm/server
```

Supply `DESEARCH_API_KEY` through your secret manager's environment injection.
The smoke extracts the built archive into that storage, validates discovery with
AnythingLLM's `ImportedPlugin`, registers the skill with its real `AIbitat`, runs
two distinct searches separated by at least five minutes, checks missing/invalid
auth and malformed/network/service failures, then disables and removes the skill.
It never writes the key to the manifest. Logs contain sanitized results and
request counts. Deterministic tool selection exercises the real skill host without
an unrelated LLM completion. Model selection quality and desktop UI are not tested.

## Sources

- https://docs.anythingllm.com/agent/custom/developer-guide
- https://docs.anythingllm.com/agent/custom/plugin-json
- https://docs.anythingllm.com/agent/custom/handler-js
- https://docs.anythingllm.com/community-hub/upload
- https://www.desearch.ai/docs/guide/sdk/mcp

No Hub upload is part of installation. Publication requires a separate review.
