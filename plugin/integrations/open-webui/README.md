# Desearch for Open WebUI

Search the web from an Open WebUI Tool using your own Desearch API key.
This single-file wrapper forwards `query` to the existing hosted MCP `search`
tool at `https://mcp.desearch.ai/mcp`, using `x-api-key`. It returns the server's
titles and links without duplicating search logic. Other MCP tools are not exposed.

## Install in a test host

Validated with Open WebUI **0.13.3**, Python **3.12.16**, MCP **2.3.0**,
httpx2 **2.16.0**, and Pydantic **2.13.4**. The runtime dependencies are bundled
with that host version; no extra package installation or npm transport is needed.
Earlier host/SDK versions have not been validated.

1. Review `desearch.py` before installing it. Workspace Tools execute Python in
   the host, so installation needs a trusted Workspace Tools administrator.
2. Export a native import file from this directory:

   ```sh
   mkdir -p dist
   python3 export.py > dist/desearch.json
   ```

3. In **Workspace > Tools**, open the menu beside **Create**, choose **Import
   Tools**, select `dist/desearch.json`, review the prompt and import. This is a
   local import. Alternatively create a Tool and paste all of `desearch.py`.
4. Enable Desearch in the chat's tool selector. In **Model controls > Controls >
   Valves**, choose Desearch and set **DESEARCH_API_KEY** to your own key from
   <https://console.desearch.ai/api-keys>. This is a per-user `UserValves` field.
   There is no shared admin key or environment fallback.
5. Use a model with native tool calling enabled and ask it to search for a public
   topic. The callable is `search(query: str)`; credentials and internal arguments
   are excluded from its model-visible schema.

The generated JSON contains source and import metadata only, with a blank key
default and private access grants. It has no directory/root layout dependency.
For a portable source bundle run, from the repository root:

```sh
git archive HEAD:plugin/integrations/open-webui | gzip > /tmp/desearch-open-webui.tar.gz
```

Do not put a key in source, chat prompts, import files or exported artifacts.
The password field masks the key on screen. Open WebUI stores UserValves in its
database; an administrator should enable `ENABLE_VALVE_ENCRYPTION=true` with a
stable `WEBUI_SECRET_KEY` to encrypt values at rest. Masking alone is not
encryption. Protect host administrator and database access.

## Behavior and removal

The wrapper accepts nonblank queries of at most 2000 characters. It creates a
short-lived MCP session per invocation and makes one `search` call, with a
30-second transport/session timeout and a 45-second overall deadline. It does
not automatically retry a tool call. On an uncertain failure, inspect the
outcome before choosing whether to make a new request. A new user/model
invocation is a separate search. Search use follows the key's Desearch plan.

Missing keys and malformed queries fail locally. Authentication, service,
network and timeout failures return a fixed error without exception details,
request headers or remote error bodies. Successful text is forwarded with the
configured key redacted if reflected. Web results are external, untrusted data.

The upstream `search` schema declares `title: Search` and `readOnlyHint: true`.
Open WebUI's native Python Tool schema has no MCP annotations slot; the local
tool uses the Desearch frontmatter title and the `search` method description.
The wrapper never exposes task-creation or account-changing tools.

To disconnect, clear your **DESEARCH_API_KEY** in User Valves and disable the
Tool. To remove it, use **Workspace > Tools > Desearch > menu > Delete**.
Removing this local Tool does not revoke the Desearch key. Revoke an unwanted
key separately in Console. To roll back a source update, import the reviewed
previous version after removing the current Tool; do not create duplicate IDs.

## Checks

From the repository root:

```sh
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r plugin/integrations/open-webui/requirements-dev.txt
.venv/bin/python -m pytest -q -o asyncio_default_fixture_loop_scope=function plugin/integrations/open-webui/tests/test_desearch.py
.venv/bin/ruff check plugin/integrations/open-webui
.venv/bin/ruff format --check plugin/integrations/open-webui
.venv/bin/python -m compileall -q plugin/integrations/open-webui
python3 plugin/integrations/open-webui/export.py > /tmp/desearch.json
npm ci
npm test
```

For independent QA use a fresh, loopback-bound disposable Open WebUI host,
import `/tmp/desearch.json`, and save your own key through its UserValves UI or
authenticated `/api/v1/tools/id/desearch/valves/user/update` endpoint. Do not
log that endpoint's response, since it contains the submitted key. Verify tool
discovery at `/api/v1/tools/`, and inspect the per-user schema at
`/api/v1/tools/id/desearch/valves/user/spec`.

`tests/native_host_smoke.py` runs in the actual host container, using its
database, loader, schema and guarded callable with real UserValves injection.
It needs the container's working directory `/app/backend`, its local test
administrator, and `PYTHONPATH=/app/backend`:

```sh
docker cp plugin/integrations/open-webui/tests/native_host_smoke.py HOST:/tmp/native_host_smoke.py
printf '%s' '{"query":"Python asyncio documentation"}' | docker exec -i -e PYTHONPATH=/app/backend HOST python /tmp/native_host_smoke.py
```

Repeat with a distinct public query at least five minutes later. Check missing
and invalid keys at search, malformed input, and a controlled network failure
(`{"query":"Python docs","network_failure":true}`). Verify clearing the key,
disabling and deleting remove access/discovery. The native smoke invokes the
same host callable used by chat without a language model; model selection and
model-generated tool calls need a configured native-tool-capable model.

## Sources and maintenance

Official sources retrieved 2026-11-14 Asia/Tbilisi:

- [Tool format and reserved arguments](https://docs.openwebui.com/features/extensibility/plugin/tools/development/)
- [UserValves, password masking and encryption](https://docs.openwebui.com/features/extensibility/plugin/development/valves/)
- [Community import and sharing](https://docs.openwebui.com/ecosystem/community/)
- [Open WebUI v0.13.3 source](https://github.com/open-webui/open-webui/tree/v0.13.3)
- [Hosted Desearch MCP authentication](https://www.desearch.ai/docs/guide/sdk/mcp)
- [Shared Desearch tool selection guide](../../skills/desearch/SKILL.md)

Maintainer: Desearch Integrations. This artifact is a draft integration for
local/test use. Community publication is a separate step; local testing does
not share or upload its source to Community.
