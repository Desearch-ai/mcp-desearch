# Desearch MCP Server

[![npm version](https://badge.fury.io/js/desearch-mcp-server.svg)](https://www.npmjs.com/package/desearch-mcp-server)
[![GitHub stars](https://img.shields.io/github/stars/Desearch-ai/mcp-desearch?style=social)](https://github.com/Desearch-ai/mcp-desearch/stargazers)

If Desearch is useful, a [star](https://github.com/Desearch-ai/mcp-desearch/stargazers) helps others find it.

Remote: `https://mcp.desearch.ai/mcp` with header `Authorization: Bearer <DESEARCH_API_KEY>`.

Local: `npx -y desearch-mcp-server@latest` with env `DESEARCH_API_KEY`.

[Get a key](https://console.desearch.ai/api-keys).

## Find Desearch on

- [Official MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.Desearch-ai/mcp-desearch)
- [Smithery](https://smithery.ai/servers/desearch/desearch)
- [Glama](https://glama.ai/mcp/servers/Desearch-ai/mcp-desearch)
- [VoltAgent official MCP servers](https://github.com/VoltAgent/official-mcp-servers#search-and-research)
- [Gemini CLI extensions](https://geminicli.com/extensions/)
- [Raycast MCP Registry](https://www.raycast.com/raycast/model-context-protocol-registry)

## Demo

Prompt: Search the web for latest news on AI.

`web-search` takes `query` (required) and `start` (optional pagination offset: 0, 10, 20, ...).

```json
{
    "name": "web-search",
    "arguments": {
        "query": "latest news on AI"
    }
}
```

Example output:

```json
{
    "data": [
        {
            "title": "Example result",
            "link": "https://example.com/page",
            "snippet": "Short preview text."
        }
    ]
}
```

The tool returns that JSON as pretty-printed text: `{ "content": [{ "type": "text", "text": "<json above>" }] }`.

AI search, X search and web search for AI agents, plus page extraction, X data tools, and People Search (find people and creators on X, YouTube, LinkedIn, and TikTok). Bring your own Desearch API key.

## Tools

The Desearch MCP server includes the following tools.

Lookup tools, including `search` and `fetch`, set `readOnlyHint: true`, `destructiveHint: false`, and `openWorldHint: true`. `people-search` starts a paid job billed to the user's Desearch balance, so `readOnlyHint` is false and `destructiveHint` is true. `people-search-control` can cancel a search, so `readOnlyHint` is false and `destructiveHint` is true. `openWorldHint` is true on every tool because the call reaches a live external source.

-   **AI Search** (`ai-search`): Performs AI Twitter and web searches with relevant links and summary. `tools` uses short source ids (`web`, `twitter`, `arxiv`, `wikipedia`, `hackernews`, `reddit`). Older labels such as `Web Search`, `ArXiv Search`, `Wikipedia Search`, `Hacker News Search`, and `Reddit Search` are still accepted and sent as the short id. `youtube` is not accepted. Default is `["web", "twitter"]`.
-   **X Search** (`x-search`): Tweet search on X. Arguments: `query` (required), `count` (optional, default 20). Sort stays Top. Optional filters: `user`, `start_date`, `end_date` (YYYY-MM-DD), `lang`, `verified`, `blue_verified`, `is_quote`, `is_video`, `is_image`, `min_retweets`, `min_replies`, `min_likes`.
-   **Search** (`search`): Web search that returns `{ results: [{ id, title, url }] }`. Argument: `query` (required). `id` is the result URL.
-   **Fetch Page** (`fetch`): Read a public page as text. Argument: `id` (required, an `http` or `https` URL from `search`).
-   **Web Search** (`web-search`): SERP-style web search. Arguments: `query` (required), `start` (optional pagination offset).
-   **Web Links Search** (`web-links-search`): Web link search. Arguments: `prompt` (required), `tools` (optional, only `web`, default `["web"]`; `Web Search` is accepted and rewritten to `web`), `count` (optional, 10–200). The links/web API rejects other sources, so they are not in the enum.
-   **Extract** (`extract`): Read a public URL as text or HTML. Preferred over crawl. Arguments: `url` (required), `format` (optional, `html` or `text`), `js` (optional), `wait` (optional milliseconds).
-   **Web Crawl** (`web-crawl`): Same arguments as `extract`, on the legacy `/web/crawl` route. The SDK marks `webCrawl` deprecated in favor of `extract`; this tool stays so that route remains reachable. Prefer `extract` for new integrations.
-   **X Links Search** (`x-links-search`): AI search for X post links. Arguments: `prompt` (required), `count` (optional, 10–200).
-   **X Posts By URLs** (`x-posts-by-urls`): Full posts for a list of URLs. Argument: `urls` (required).
-   **X Post By ID** (`x-post-by-id`): One post by ID. Argument: `id` (required).
-   **X Posts By User** (`x-posts-by-user`): Posts by a user. Arguments: `user` (required), `query` (optional), `count` (optional, 1–100).
-   **X Post Retweeters** (`x-post-retweeters`): Users who retweeted a post. Arguments: `id` (required), `cursor` (optional).
-   **X User Posts** (`x-user-posts`): A user's timeline. Arguments: `username` (required), `cursor` (optional).
-   **X User Replies** (`x-user-replies`): Posts and replies by a user. Arguments: `user` (required), `count` (optional, 1–100), `query` (optional).
-   **X Post Replies** (`x-post-replies`): Replies to a post. Arguments: `post_id` (required), `count` (optional, 1–100), `query` (optional).
-   **X Trends** (`x-trends`): Trending topics for a location. Arguments: `woeid` (required), `count` (optional, 30–100).
-   **People Search** (`people-search`): Start a paid job billed to the user's Desearch balance: a search for people who match a plain-language description. Arguments: `platform` (required: `x`, `youtube`, `linkedin`, or `tiktok`), `query` (required, 3–1000 characters), `count` (optional, 5–200, API default 25), `min_score` (optional, 0–100), `exclude` (optional handles), `metadata` (optional labels, below), `idempotency_key` (optional), and that platform's filters (below). Returns the `task_id`, status, and `reserved_cost_usd`.
-   **People Search Status** (`people-search-status`): A task's status, progress, and cost, plus a page of the people found so far. Arguments: `task_id` (required), `cursor` (optional, `next_cursor` from the previous call), `limit` (optional, 1–100, default 25), `include_people` (optional, default `true`). Free.
-   **Control People Search** (`people-search-control`): Pause, resume, or cancel a task. Arguments: `task_id` (required), `action` (required: `pause`, `resume`, or `cancel`). Free.
-   **List People Search Tasks** (`people-search-tasks`): Your searches, newest first. Arguments: `platform` (optional), `status` (optional list, for example `["running", "paused"]`), `limit` (optional, 1–100), `cursor` (optional), `metadata` (optional, up to 3 labels a task must have, for example `{"campaign": "q4-outbound"}`). Free.
-   **List People Found** (`people-profiles`): Everyone your searches found on one platform, one entry per person, with the search that found them. Arguments: `platform` (required), `q` (optional text in name, handle, bio, or location), `sort` (optional: `score`, `recent`, or `audience`), `limit` (optional, 1–200, default 25), `cursor` (optional), and the filters `has` (channels every person must have: `email`, `website`, `x`, `linkedin`, `instagram`, `youtube`, `tiktok`), `min_audience`, `max_audience`, `min_score`, `location`, `verified`. Free.

The full SDK method → endpoint → MCP tool map is in [docs/API_MCP_PARITY.md](docs/API_MCP_PARITY.md). Every public `desearch-js` 1.5 method is a tool. `latestTweets` was removed from the SDK (`GET /twitter/latest` in 1.0.1) and is not exposed. People Search is not in `desearch-js` 1.5; its tools call the `/desearch/people/*` routes directly, and the parity doc lists them too.

### People Search

People Search finds X profiles, YouTube creators, LinkedIn members, or TikTok creators who match a plain-language description. Each person comes back with a fit score, one line on why they matched, their audience (followers, or subscribers on YouTube), location, and the public contacts and links the search found.

A search is a background task:

1. `people-search` starts a paid job billed to the user's Desearch balance and returns a `task_id` at once. It is the only billed People Search call. It reserves `count` people at the platform's per-person price (`reserved_cost_usd`). When the search ends you pay only for the people it delivered (a per-search minimum applies when it finds anyone; a search that finds no one is free), and the rest of the reservation is returned. Send the same `idempotency_key` to retry a call without starting, or paying for, a second search.
2. The search usually runs for 1 to 5 minutes. `people-search-status` returns its status, progress, cost, and the people found so far. People arrive while it runs: pass `next_cursor` back as `cursor` to get only the new ones. When `done` is `true` and `has_more` is `false`, you have everyone it found.
3. `people-search-control` pauses, resumes, or cancels it. A cancelled search bills only the people it already delivered.

People found stay readable for 30 days after a search ends. `people-profiles` lists them per platform across all your searches, with filters such as `has: ["email"]`.

Search filters depend on the platform. A filter that does not apply is rejected before the billed call.

| Platform | Filters |
| --- | --- |
| `x` | `min_followers`, `max_followers`, `verified_only`, `countries`, `keywords`, `exclude_keywords` |
| `youtube` | `min_subscribers`, `max_subscribers`, `countries`, `require_contact`, `keywords`, `exclude_keywords` |
| `linkedin` | `min_followers`, `max_followers`, `countries`, `keywords`, `exclude_keywords` |
| `tiktok` | `min_followers`, `max_followers`, `require_contact`, `keywords`, `exclude_keywords` |

`require_contact` keeps only creators with a public email (on TikTok, in the bio). `keywords` and `exclude_keywords` take up to 20 words each.

`metadata` labels a search with your own keys, for example `{"campaign": "q4-outbound", "workspace_id": "ws_42"}`. A search takes up to 10 keys; keys are 1–40 characters of `a-z`, `0-9`, `_`, `.` or `-`, and values are strings of up to 200 characters. A bad label is rejected before the billed call. The labels come back as `metadata` on the task, and `people-search-tasks` with `metadata: {"campaign": "q4-outbound"}` lists only the searches that carry them (up to 3 pairs, exact match). The search itself does not use them.

Prompt: find 10 TikTok skincare creators with a public email.

```json
{
    "name": "people-search",
    "arguments": {
        "platform": "tiktok",
        "query": "Skincare creators who review skincare products",
        "count": 10,
        "require_contact": true
    }
}
```

Example output:

```json
{
    "task_id": "3f1c2b9e-8d4a-4c1e-9b7a-2e5f6a7b8c9d",
    "platform": "tiktok",
    "status": "queued",
    "done": false,
    "query": "Skincare creators who review skincare products",
    "count": 10,
    "result_count": 0,
    "reserved_cost_usd": 0.5,
    "created_at": "2026-10-17T10:00:00Z",
    "cost_usd": 0.5,
    "currency": "USD",
    "next": "Searches usually take 1 to 5 minutes. Poll people-search-status with this task_id every 15 to 30 seconds; people appear while it runs."
}
```

Then poll with `{"task_id": "3f1c2b9e-8d4a-4c1e-9b7a-2e5f6a7b8c9d"}` on `people-search-status`:

```json
{
    "task_id": "3f1c2b9e-8d4a-4c1e-9b7a-2e5f6a7b8c9d",
    "platform": "tiktok",
    "status": "running",
    "stage": "processing",
    "done": false,
    "query": "Skincare creators who review skincare products",
    "count": 10,
    "result_count": 4,
    "progress": { "round": 1, "candidates_processed": 40, "qualified": 4 },
    "reserved_cost_usd": 0.5,
    "created_at": "2026-10-17T10:00:00Z",
    "people": [
        {
            "id": "tiktok:example_creator",
            "platform": "tiktok",
            "handle": "example_creator",
            "name": "Example Creator",
            "url": "https://www.tiktok.com/@example_creator",
            "audience": 48200,
            "location": "United States",
            "score": 88,
            "why": "Reviews sunscreens and moisturizers every week.",
            "contacts": [{ "type": "email", "value": "creator@example.com" }],
            "links": [{ "type": "instagram", "url": "https://instagram.com/example_creator" }],
            "evidence_url": "https://www.tiktok.com/@example_creator/video/1"
        }
    ],
    "next_cursor": "4",
    "has_more": false,
    "next": "Still searching. Wait 15 to 30 seconds, then call people-search-status again with cursor \"4\" to get only the people found since this call."
}
```

The output above is shortened to one person. CSV and JSON Lines downloads (`/export` routes) are not MCP tools; call the API directly for a file.

When the search has ended, the task also says why and how complete it is, and each person says what their own profile confirms (0.3.2 and later):

```json
{
    "status": "completed",
    "done": true,
    "completion_reason": "cost_limit",
    "coverage_limited": true,
    "warnings": [
        { "code": "partial_enrichment", "platform": "linkedin", "attempted": 20, "failed": 7, "by_reason": { "not_found": 7 } }
    ],
    "people": [
        {
            "handle": "example_engineer",
            "score": 74,
            "fully_verified": false,
            "unverified_criteria": ["Profile fit: Software Engineer based in Georgia (unknown)"],
            "enrichment": "failed",
            "enrichment_error": "not_found"
        }
    ],
    "next": "Finished early: a budget stopped it (cost_limit) before it found 10 people, so more people may match. You have every person it found."
}
```

-   `completion_reason` is one of `count_reached`, `rounds_exhausted`, `no_candidates`, `zero_qualified`, `candidate_budget`, `cost_limit`, `time_limit`, `cancelled`, or `failed`. It is left out while the search runs.
-   `coverage_limited` appears (as `true`) only when a budget stopped the search before it found `count` people. The status is still `completed`.
-   `warnings` lists what made part of the search less reliable. `partial_enrichment`: `failed` of `attempted` profiles could not be read after search, so those people were scored on the search hit and show `enrichment: "failed"` with `enrichment_error`.
-   `fully_verified` is `true` when every criterion is confirmed by the person's own profile or posts. `unverified_criteria` lists up to five that are not: `(unknown)`, `(not met)`, or a disqualifier that `(applies)`. Both are information only: the person still qualified. Results scored before 2026-10-20 have neither.

## Prerequisites 📋

-   An [Desearch API Key](https://console.desearch.ai/api-keys)
-   [Node.js](https://nodejs.org/) (v20.18.1 or higher; Node 22 is supported. Node 18 is not.)
-   [Claude Desktop](https://claude.ai/download) installed
-   [Cursor IDE](https://www.cursor.com/)

## Installation 🛠️

### NPM Installation

The package name is `desearch-mcp-server`. The current version is on [npm](https://www.npmjs.com/package/desearch-mcp-server). See [CHANGELOG.md](CHANGELOG.md) for release notes. The stdio entry is the `desearch-mcp-server` bin (`build/index.js`), which requires `DESEARCH_API_KEY`.

```bash
npm install -g desearch-mcp-server
```

Or run it without a global install:

```bash
npx -y desearch-mcp-server@latest
```

Cursor or Claude can start that bin directly:

```json
{
    "mcpServers": {
        "desearch": {
            "command": "npx",
            "args": ["-y", "desearch-mcp-server"],
            "env": {
                "DESEARCH_API_KEY": "your-api-key"
            }
        }
    }
}
```

`command: "desearch-mcp-server"` (no `args`) is the same entry after the global install above.

### Gemini CLI

Install the extension from this repository. Gemini CLI asks for your Desearch API key (stored as a sensitive setting) and connects to the hosted server `https://mcp.desearch.ai/mcp`:

```bash
gemini extensions install https://github.com/Desearch-ai/mcp-desearch
```

To change the key later, run `gemini extensions config desearch`. AI agents such as Cline can follow [llms-install.md](llms-install.md) to set up the server.

### Using Smithery

To install the Desearch MCP server for Claude Desktop automatically via [Smithery](https://smithery.ai/servers/desearch/desearch):

```bash
npx -y @smithery/cli install desearch/desearch --client claude
```

Or for Cursor IDE:

```bash
npx -y @smithery/cli install desearch/desearch --client cursor
```

### Windsurf

Windsurf's Cascade agent reads MCP servers from `mcp_config.json` under the `mcpServers` key. Open it from the Cascade panel: click the `...` (Actions) menu, then `Open MCP config file`. Windsurf builds use `~/.codeium/windsurf/mcp_config.json` (on Windows, `%USERPROFILE%\.codeium\windsurf\mcp_config.json`). Newer builds may open `~/.config/devin/mcp_config.json` instead (Windows: `%APPDATA%\devin\mcp_config.json`); edit whichever file that action opens.

Hosted server (no local install). Remote servers use `serverUrl` with `headers`:

```json
{
    "mcpServers": {
        "desearch": {
            "serverUrl": "https://mcp.desearch.ai/mcp",
            "headers": {
                "Authorization": "Bearer your-api-key"
            }
        }
    }
}
```

To keep the key out of the file, Windsurf can interpolate an environment variable: `"Authorization": "Bearer ${env:DESEARCH_API_KEY}"`.

Local stdio alternative:

```json
{
    "mcpServers": {
        "desearch": {
            "command": "npx",
            "args": ["-y", "desearch-mcp-server"],
            "env": {
                "DESEARCH_API_KEY": "your-api-key"
            }
        }
    }
}
```

Save the file, then refresh the MCP servers list in Cascade.

### Zed

Zed calls MCP servers context servers. Open your settings file with the `zed: open settings file` action (or use Settings → AI → MCP Servers → `Add Server`) and add a `context_servers` entry.

Hosted server:

```json
{
    "context_servers": {
        "desearch": {
            "url": "https://mcp.desearch.ai/mcp",
            "headers": {
                "Authorization": "Bearer your-api-key"
            }
        }
    }
}
```

Local stdio alternative:

```json
{
    "context_servers": {
        "desearch": {
            "command": "npx",
            "args": ["-y", "desearch-mcp-server"],
            "env": {
                "DESEARCH_API_KEY": "your-api-key"
            }
        }
    }
}
```

The server is ready when the dot next to `desearch` in Settings → AI → MCP Servers turns green ("Server is active").

## Configuration ⚙️

### 1. Configure Cursor IDE to run the Desearch MCP server

Open Cursor IDE, access command palette `Cmd+Shift+P` or `Ctrl+Shift+P`, and search for `Open MCP Settings`. Click on `Add new global MCP server` to open the `mcp.json` file.

### 2. Add the Desearch server configuration:

```json
{
    "mcpServers": {
        "desearch": {
            "command": "desearch-mcp-server",
            "env": {
                "DESEARCH_API_KEY": "your-api-key"
            }
        }
    }
}
```

Replace `your-api-key` with your actual Desearch API key from [console.desearch.ai/api-keys](https://console.desearch.ai/api-keys).

### 3. Restart Cursor IDE

For the changes to take effect:

1. Completely quit Cursor IDE
2. Start Cursor IDE again

### 1. Configure Claude Desktop to run the Desearch MCP server

Open the Claude Desktop app and enable Developer Mode from the top-left menu bar.

Once enabled, open Settings (also from the top-left menu bar) and navigate to the Developer Option, where you'll find the Edit Config button. Clicking it will open the `claude_desktop_config.json` file, allowing you to make the necessary edits.

OR (if you want to open `claude_desktop_config.json` from terminal)

#### For macOS:

1. Open your Claude Desktop config:

```bash
code ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

#### For Windows:

1. Open your Claude Desktop configuration:

```powershell
code %APPDATA%\Claude\claude_desktop_config.json
```

### 2. Add the Desearch server configuration:

```json
{
    "mcpServers": {
        "desearch": {
            "command": "desearch-mcp-server",
            "env": {
                "DESEARCH_API_KEY": "your-api-key"
            }
        }
    }
}
```

Replace `your-api-key` with your actual Desearch API key from [console.desearch.ai/api-keys](https://console.desearch.ai/api-keys).

### 3. Restart Claude Desktop

For the changes to take effect:

1. Completely quit Claude Desktop
2. Start Claude Desktop again
3. You can verify the server by checking status in Settings > Developer > desearch

## Remote Streamable HTTP

The same server can run over MCP Streamable HTTP for a remote client. Local stdio (`desearch-mcp-server`, Smithery) is unchanged and still reads `DESEARCH_API_KEY` from the environment.

Remote requests do not use that environment variable. Discovery does not need a key: `initialize`, `notifications/initialized`, `ping`, `tools/list`, `prompts/list`, `resources/list`, and `resources/templates/list` return 200 so a marketplace scanner can read the tool list. `tools/call` and every other method still require the caller's own Desearch API key, the same key from [console.desearch.ai/api-keys](https://console.desearch.ai/api-keys):

- `Authorization: Bearer <DESEARCH_API_KEY>` (preferred)
- `x-api-key: <DESEARCH_API_KEY>` (also accepted)
- `Authorization: Bearer <oauth access token>` after the OAuth sign-in below

A bare `Authorization: <DESEARCH_API_KEY>` value is also accepted. The key is not read from the query string. There is no shared server secret. A protected call without a valid key or access token returns 401 with a `WWW-Authenticate` header pointing at `/.well-known/oauth-protected-resource/mcp`. The hosted process forwards the per-request Desearch API key to the Desearch API only when a call needs it. An OAuth access token is opaque: the server looks up the key stored for that token and does not put the raw key in the token.

The MCP endpoint is `POST /mcp`. Responses are JSON (stateless Streamable HTTP). `GET` and `DELETE` on `/mcp` return `405` because the server does not keep a session or push server-to-client messages. `GET /`, `GET /health`, and `GET /api/health` are unauthenticated health checks.

## Hosted endpoint

The public Streamable HTTP endpoint is `https://mcp.desearch.ai/mcp`. Listing the tools does not need a key. Send your Desearch API key on each `tools/call` using `Authorization: Bearer <DESEARCH_API_KEY>` (preferred). The `x-api-key` header is also accepted. Use the key from [console.desearch.ai/api-keys](https://console.desearch.ai/api-keys). The server does not read a key from the query string. Remote requests do not use a process-level `DESEARCH_API_KEY`.

Cursor, or any remote MCP client:

```json
{
    "mcpServers": {
        "desearch": {
            "url": "https://mcp.desearch.ai/mcp",
            "headers": {
                "Authorization": "Bearer your-api-key"
            }
        }
    }
}
```

### OAuth sign-in

Clients that follow the MCP authorization spec (2025-06-18) can sign in instead of sending a key on every request. Discovery documents:

- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-protected-resource/mcp`
- `GET /.well-known/oauth-authorization-server`
- `GET /.well-known/openid-configuration` (same authorization server document)

`POST /register` is dynamic client registration. `GET /authorize` is the Desearch page where the user pastes an API key. `POST /token` exchanges the authorization code and rotates refresh tokens. PKCE S256 is required. Public clients use `token_endpoint_auth_method` `none`.

Allowed callback URLs:

- `https://claude.ai/api/mcp/auth_callback`
- `https://claude.com/api/mcp/auth_callback`
- `https://chatgpt.com/connector_platform_oauth_redirect`
- `https://chatgpt.com/connector/oauth/{callback_id}`
- Loopback `http://localhost`, `http://127.0.0.1`, and `http://[::1]` on any port (host and path must match the registered callback)

The connector URL is `https://mcp.desearch.ai/mcp`. On the sign-in page, paste a key from [console.desearch.ai/api-keys](https://console.desearch.ai/api-keys). Leave a client id blank when the client can register itself.

Environment variables for the host:

| Variable | Required | Purpose |
| --- | --- | --- |
| `OAUTH_ISSUER` | Production | Canonical origin with no trailing slash, for example `https://mcp.desearch.ai`. Required when `NODE_ENV=production` or `VERCEL` is set. The process refuses OAuth and bearer challenges if it is unset. The issuer is never taken from `X-Forwarded-Host`. Locally, the request URL is used. |
| `OAUTH_RESOURCE` | No | Canonical MCP URL. Default is `{OAUTH_ISSUER}/mcp`. Access tokens are rejected when their stored audience does not match this resource. |
| `OAUTH_STORE` | Production | `memory` (local default) or `redis`. Production (`NODE_ENV=production` or `VERCEL`) refuses to start unless this is `redis`. |
| `REDIS_URL` | When `OAUTH_STORE=redis` | Redis connection string (`redis://` or `rediss://`). |
| `OAUTH_ENCRYPTION_KEY` | When `OAUTH_STORE=redis` | 32-byte key, base64 or hex. Generate with `openssl rand -base64 32`. Encrypts stored API keys. |
| `OAUTH_ACCESS_TTL_SEC` | No | Access token lifetime. Default 3600. Range 60 to 86400. |
| `OAUTH_REFRESH_TTL_SEC` | No | Refresh token lifetime. Default 30 days. Range 300 to 90 days. |
| `OAUTH_CODE_TTL_SEC` | No | Authorization code lifetime. Default 300. Range 30 to 600. |
| `OAUTH_CLIENT_TTL_SEC` | No | Dynamic client lifetime. Default 90 days. Range 3600 to 5 years. |
| `OAUTH_REGISTER_RATE_LIMIT` | No | Registration attempts per IP per window. Default 10. Range 1 to 10000. |
| `OAUTH_REGISTER_RATE_WINDOW_SEC` | No | Registration rate-limit window in seconds. Default 3600 (1 hour). Range 1 to 86400. |
| `OAUTH_AUTHORIZE_RATE_LIMIT` | No | Sign-in key checks per IP per window. Default 20. Range 1 to 10000. |
| `OAUTH_AUTHORIZE_RATE_WINDOW_SEC` | No | Sign-in key-check window in seconds. Default 600 (10 minutes). Range 1 to 86400. |
| `DESEARCH_API_BASE` | No | Key check host. Default `https://api.desearch.ai`. |
| `OAUTH_REQUIRE_AUTH_ON_INITIALIZE` | No | Set to `true` to require a key or access token on `initialize`. Default is off, so keyless `initialize` stays public. `tools/list` stays public either way. |

The key check calls `GET /twitter/trends?woeid=1&count=1`. A real key is authenticated and then rejected as invalid input (HTTP 422), so the check does not run a full trends query. Only 422 counts as a valid key. `401` and `403` reject the key. Any other status, including a 2xx, is a verification error and is not treated as valid.

`POST /register` allows 10 requests an hour per IP. The sign-in key check allows 20 requests every 10 minutes per IP. A request past the limit returns 429 with `Retry-After`. On Vercel the address is the first `X-Forwarded-For` hop. The sign-in page uses `Referrer-Policy: same-origin` and posts `response_type=code` with the other authorize fields. The form accepts a same-origin `Origin` or `Referer`, and accepts `Sec-Fetch-Site: same-origin` when `Origin` is missing or `null`. It rejects `Sec-Fetch-Site` `cross-site` and `same-site`, a foreign `Origin`, and a POST that has no origin signal.

### Use with Claude (custom connector)

Desearch is not in the Claude Connectors Directory yet. You can add the hosted server as a custom connector with your Desearch API key, or with OAuth sign-in.

Sources: [Custom remote MCP connectors](https://claude.com/docs/connectors/custom/remote-mcp) and [connector authentication](https://claude.com/docs/connectors/building/authentication). Request-header authentication is a beta feature in Claude.

**Claude.ai / Claude Desktop (organization admin)**

1. Open **Organization settings > Connectors**.
2. Select **Add**, then **Custom**. If asked for the connector type, choose **Web**.
3. Server URL: `https://mcp.desearch.ai/mcp`
4. Sign-in option: **No sign-in**.
5. Under **Request headers**, add `Authorization` with `Bearer <DESEARCH_API_KEY>` as the value, replacing `<DESEARCH_API_KEY>` with your Desearch API key.
6. Select **Add**.

The header value is stored once and shared by everyone in the organization who uses the connector.

OAuth alternative: choose sign-in instead of a request header, leave the OAuth client id empty so the client can register itself, and paste a Desearch API key on the Desearch page. The callback URL for hosted Claude apps is `https://claude.ai/api/mcp/auth_callback`. Claude Code uses a loopback callback, which this server accepts on any port.

**Claude Code**

```bash
claude mcp add --transport http desearch https://mcp.desearch.ai/mcp \
  --header "Authorization: Bearer your-api-key"
```

### Run locally

```bash
npm install
npm run build
npm run start:http
```

This listens on `0.0.0.0:3000` (`PORT` and `HOST` override that). `MCP_TRANSPORT=http` is the same as `--http`.

```bash
curl -sS http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer your-api-key' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.1"}}}'
```

Cursor (or any remote MCP client):

```json
{
    "mcpServers": {
        "desearch": {
            "url": "http://127.0.0.1:3000/mcp",
            "headers": {
                "Authorization": "Bearer your-api-key"
            }
        }
    }
}
```

The image default is stdio MCP (`node build/index.js`). Registries such as Glama start the container and speak MCP on stdin/stdout, so the image does not pass `--http` unless you override it. Stdio requires `DESEARCH_API_KEY`. Smithery does not use this image command; `smithery.yaml` starts `node build/index.js` and injects `DESEARCH_API_KEY` itself.

Streamable HTTP is an override. Replace the command with `--http`, or set `MCP_TRANSPORT=http` and keep the default command. The image still exposes port 3000 for that mode.

```bash
docker build -t desearch-mcp .
# stdio (image default)
docker run --rm -e DESEARCH_API_KEY=your-api-key -i desearch-mcp
# Streamable HTTP
docker run --rm -p 3000:3000 desearch-mcp node build/index.js --http
# same HTTP mode via env, without replacing the command
docker run --rm -e MCP_TRANSPORT=http -p 3000:3000 desearch-mcp
```

### Deploy on Vercel

Vercel fits the MCP handler because each JSON-RPC call is one response. `vercel.json` builds the project, serves `POST /mcp`, and sets the function duration to 60 seconds. The same file rewrites the public OAuth paths to `/api/*`. The server accepts those rewritten paths and the public paths, and the metadata documents still advertise the public paths. Hobby plans cap function duration lower than that, so AI Search tool calls need a plan that allows at least 60 seconds. `initialize` and `tools/list` are short either way.

OAuth codes and tokens need shared storage. On Vercel set `OAUTH_STORE=redis`, `REDIS_URL`, `OAUTH_ENCRYPTION_KEY`, and `OAUTH_ISSUER=https://mcp.desearch.ai`. The server refuses OAuth when `OAUTH_ISSUER` is unset or `OAUTH_STORE` is not `redis`, because Vercel sets `VERCEL` on every function. `OAUTH_REQUIRE_AUTH_ON_INITIALIZE=true` is optional. Leave it unset unless a client treats public `initialize` as a reason to skip sign-in.

No server-side Desearch API key is required in the Vercel project. After deploy, the endpoint is:

`https://<project>.vercel.app/mcp`

`https://mcp.desearch.ai/mcp` is the public hostname. This repo does not create DNS records. Clients send `Authorization: Bearer <DESEARCH_API_KEY>` (preferred). The `x-api-key` header is also accepted.

The same `node build/index.js --http` process is the fallback if you would rather run a long-lived Node host instead of Vercel. The Docker image defaults to stdio; pass `--http` or set `MCP_TRANSPORT=http` to serve Streamable HTTP from it.

## Troubleshooting 🔧

### Common Issues

1. **Server Not Found**

    - Check Claude or Cursor Desktop configuration syntax
    - Ensure Node.js is installed

2. **API Key Issues**

    - Confirm your `DESEARCH_API_KEY` is valid
    - Check the `DESEARCH_API_KEY` is correctly set in the Cursor or Claude Desktop config
    - Verify that there are no spaces around the API key
    - For the remote HTTP server, send `Authorization: Bearer <DESEARCH_API_KEY>` (preferred); `x-api-key` is also accepted. A hosted `DESEARCH_API_KEY` environment variable is not used for those requests.

3. **Connection Issues**

    - Restart Claude Desktop or Cursor IDE completely
    - Check Claude Desktop logs:

    ```bash
    # macOS
    tail -n 50 -f ~/Library/Logs/Claude/mcp*.log

    # Windows
    type "%APPDATA%\Claude\logs\mcp*.log"
    ```
