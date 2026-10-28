# Changelog

## Unreleased

- Breaking tool-name change: `people-search-control` is replaced by three tools, `people-search-pause`, `people-search-resume`, and `people-search-cancel`. Each takes only `task_id` and calls the same `POST /desearch/people/tasks/{task_id}/pause`, `/resume`, or `/cancel` route as before, with the same 409 handling. Errors are titled `People Search Pause error`, `People Search Resume error`, and `People Search Cancel error`. `people-search-control` is removed with no alias. The `people-search` description, the server instructions, and the `next` hints for pausing and paused tasks name the new tools.
- Annotation fixes: `people-search` sets `destructiveHint: false` (it was `true`); it creates a task and does not delete or overwrite anything. `people-search-pause` and `people-search-resume` set `destructiveHint: false` and `idempotentHint: true`. `people-search-cancel` sets `destructiveHint: true` and `idempotentHint: true`. `people-search-status`, `people-search-tasks`, and `people-profiles` set `readOnlyHint: true` and `destructiveHint: false` explicitly. `openWorldHint` stays `true` on every tool.

- Accept OAuth state values up to 4096 characters so OpenAI Apps relay state survives sign-in. Report missing and oversized state values separately.

- Add the public OpenAI Apps domain verification route at `/.well-known/openai-apps-challenge` with the public token set in source. The `OPENAI_APPS_CHALLENGE_TOKEN` environment variable can override it; unset, empty, whitespace-only or placeholder values fall back to the source token.

## 0.3.3

- `unverified_criteria` reads each check's `is_disqualifier`, which the API returns since 2026-10-20, and falls back to the keyword rule for checks scored before it, like the API's CSV `unverified_criteria` column.

## 0.3.2

People Search summaries show the result fields the API returns since 2026-10-20.

- Task summaries (`people-search`, `people-search-status`, `people-search-control`, `people-search-tasks`) carry `completion_reason` once the search has ended, `coverage_limited: true` when a budget stopped it before `count`, and `warnings`. A `partial_enrichment` warning keeps `code`, `platform`, `attempted`, `failed`, and `by_reason`, without the long message; a warning code this server does not know keeps its `message`.
- The `next` hint of a completed search says when a budget stopped it early, when its searches found nobody (`no_candidates`), and when nobody fit (`zero_qualified`).
- Each person carries `fully_verified` and `unverified_criteria`: up to five criteria their own profile or posts do not confirm, labelled `(unknown)`, `(not met)`, or `(applies)` for a disqualifier that applies. It follows the rule of the API's CSV `unverified_criteria` column. A person whose profile could not be read after search carries `enrichment: "failed"` and `enrichment_error`.
- The `people-search-status` and `people-search-tasks` descriptions mention these fields.

## 0.3.1

- `x-search` filters `min_retweets`, `min_replies`, and `min_likes` are integers in the tool input schema. Each property has its own JSON Schema `type`.
- `extract` and `web-crawl` descriptions link to the Desearch API docs. Prefer `extract` for new integrations. `web-crawl` stays on the legacy `/web/crawl` route.

## 0.3.0

People Search `metadata` labels. Release this version only after the Desearch API release that brings `metadata` to `api.desearch.ai`. Until then the production API rejects a search that sends `metadata` (HTTP 422, extra fields are forbidden) and ignores `metadata.<key>` list filters, so a filtered `people-search-tasks` call would return every task.

- `people-search` takes an optional `metadata` object: your own string labels for the search, for example `{"campaign": "q4-outbound"}`. Up to 10 keys; keys are 1-40 characters of `a-z`, `0-9`, `_`, `.`, `-`; values are strings of up to 200 characters. A bad label is rejected before the billed call. An empty object is not sent.
- `people-search-tasks` takes an optional `metadata` filter of up to 3 pairs. Each pair is sent as `metadata.<key>=<value>`, and a task must match all of them exactly.
- `people-search`, `people-search-status`, `people-search-control` and `people-search-tasks` return the task's `metadata` when it has any.
- The key rule and key counts are checked by the tool, not advertised as `propertyNames`/`maxProperties` in the input schema, so clients that do not accept those keywords still load the tools. The argument descriptions state the limits.

## 0.2.4

`people-search` is marked destructive because it spends the user's Desearch balance.

`readOnlyHint` stays false and `openWorldHint` stays true. `destructiveHint` is now true. The tool description states that it starts a paid job billed to the user's Desearch balance. `people-search-control` stays `destructiveHint: true`. Lookup tools, including `search` and `fetch`, stay read-only.

## 0.2.3

The sign-in form works in a browser.

The page used `no-referrer`, so a browser posted `Origin: null` and no `Referer`. The server treated that as a cross-site submit even when `Sec-Fetch-Site` was `same-origin`. The form also omitted `response_type`, so the post redirected with `unsupported_response_type`. `Content-Security-Policy: form-action 'self'` can block the redirect to the client callback.

The form now includes hidden `response_type=code` plus `client_id`, `redirect_uri`, `state`, `code_challenge`, `code_challenge_method`, `scope`, and `resource`. The referrer policy is `same-origin`. A post with `Sec-Fetch-Site: same-origin` is accepted when `Origin` is missing or `null`. `cross-site` and `same-site` posts, and foreign origins, are still rejected. A post with no origin signal is still rejected. The page `form-action` allows the validated callback origin.

## 0.2.2

OAuth discovery and sign-in answer on the rewritten `/api/*` paths as well as the public paths.

Vercel rewrites `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration`, `/register`, `/authorize`, and `/token` to `/api/oauth-protected-resource`, `/api/oauth-protected-resource-mcp`, `/api/oauth-authorization-server`, `/api/openid-configuration`, `/api/oauth-register`, `/api/oauth-authorize`, and `/api/oauth-token`. A Node framework project serves `index.ts` and does not run the `api/*.js` wrappers, so those rewritten paths were 404. The handler now treats each rewritten path as the matching public route. Issuer, resource, and metadata URLs stay on the public paths.

## 0.2.1

Remote MCP OAuth 2.1 and per-IP rate limits, on top of the 0.2.0 People Search tools. `search` and `fetch` are included for clients that look up a page by query and then read it.

- Protected resource metadata, authorization server metadata, dynamic client registration, authorization code with PKCE S256, and rotating refresh tokens. Refresh rotation is atomic. Replaying an authorization code revokes tokens already issued from that code.
- The sign-in page asks for a Desearch API key and checks it before issuing a code. Only HTTP 422 counts as a valid key. Access tokens are opaque. The key is encrypted at rest and is not placed in the token.
- A raw Desearch API key in `Authorization` or `x-api-key` still works. `tools/list` without a key still returns tools. `tools/call` without a key returns HTTP 401 with `WWW-Authenticate`, and the body is a tool error with `_meta["mcp/www_authenticate"]`.
- Production (`NODE_ENV=production` or `VERCEL`) requires `OAUTH_ISSUER` and `OAUTH_STORE=redis`. The issuer is not taken from forwarded host headers. Access tokens must match this server's resource. A bad or expired token challenge includes `error="invalid_token"`. `OAUTH_REQUIRE_AUTH_ON_INITIALIZE=true` makes keyless `initialize` return 401. The sign-in form rejects a cross-site `Origin` or `Referer`, and rejects a POST that sends none of those or `Sec-Fetch-Site`.
- `POST /register` allows 10 requests an hour per IP. The sign-in key check allows 20 requests every 10 minutes per IP. A request past the limit returns 429 with `Retry-After`.
- `search` takes `query` and returns titles and links. `fetch` takes a URL and returns the page text.
- Tool annotations are not all read-only. Lookup tools, including `search` and `fetch`, keep `readOnlyHint: true`, `destructiveHint: false`, and `openWorldHint: true`. `people-search` starts a billed job, so `readOnlyHint` is false and `destructiveHint` is false. `people-search-control` can cancel a search, so `readOnlyHint` is false and `destructiveHint` is true. `openWorldHint` is true on every tool.

## 0.2.0

People Search tools. Release this version only after People Search is live on `api.desearch.ai`; until then the new tools return the API's HTTP error.

People Search finds X profiles, YouTube creators, LinkedIn members, or TikTok creators who match a plain-language description. desearch-js 1.5 has no People Search methods, so `people.ts` calls the `/desearch/people/*` routes directly with the same key header.

| Tool | Route | Billed |
| --- | --- | --- |
| `people-search` | `POST /desearch/people/search/{x,youtube,linkedin,tiktok}` | Yes. Reserves `count` people at the platform's per-person price and settles to the people delivered (minimum per search; nothing when it finds no one). |
| `people-search-status` | `GET /desearch/people/tasks/{id}` and `GET /desearch/people/tasks/{id}/results` | No |
| `people-search-control` | `POST /desearch/people/tasks/{id}/pause`, `/resume`, `/cancel` | No |
| `people-search-tasks` | `GET /desearch/people/tasks` | No |
| `people-profiles` | `GET /desearch/people/profiles` | No |

- `people-search` takes each platform's filters as top-level arguments and rejects a filter that does not apply to the chosen platform before the billed call. `idempotency_key` is sent as `Idempotency-Key`, so a retry returns the first task instead of starting a second search.
- `people-search-status` returns compact people (name, handle, url, platform, audience, location, score, why they matched, contacts, links) and a `next_cursor` that returns only people found since the previous call.
- Every people tool returns a `next` line that says what to call next.
- People tools reject unknown arguments, so a misspelled or nested filter is not dropped from a billed search.
- The `/export` CSV and JSON Lines routes are not tools.

### Tool annotations

The 15 existing tools keep `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: true`. So do `people-search-status`, `people-search-tasks`, and `people-profiles`.

- `people-search`: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`. It creates a billed task.
- `people-search-control`: `readOnlyHint: false`, `destructiveHint: true` (cancel cannot be undone), `idempotentHint: true`.

## 0.1.4

`ai-search` tools enum drops `youtube`. Allowed ids are `web`, `twitter`, `arxiv`, `wikipedia`, `hackernews`, and `reddit`.

## 0.1.3

Tool copy no longer states unsourced speed or latency.

- `ai-search` description is `AI search and analysis on web using Desearch AI`.
- `x-search` description is `Search X (Twitter) using Desearch AI. Optional filters narrow by user, date, language, verification, media, and engagement. Sort stays Top.`
- `ai-search` `model` is `Model to use for the search: NOVA (default) or ORBIT.`

Removed from those strings: `Real-time`, `real-time`, and `Nova is 10s model, Orbit is 30s model`. The Vercel section of the README no longer says Orbit searches run about 30 seconds. The 60-second figure there is the `vercel.json` function duration.

## 0.1.2

Migration from the published npm package `desearch-mcp-server@0.0.1`.

### npm 0.0.1 versus this release

`0.0.1` exposed two tools and called desearch-js methods that 1.5.0 does not have (`AISearch`, `twitterSearch`). Those calls throw. `0.1.2` depends on desearch-js 1.5.0 and calls `aiSearch` and `xSearch`.

`0.0.1` did not include `web-links-search` or the other tools below. npm users are not losing a source list they already had.

### Tools

| Tool | In 0.0.1 |
| --- | --- |
| `ai-search` | Present, under the broken `AISearch` call. Arguments now include date range, `result_type`, and domain filters. `tools` uses short ids (`web`, `twitter`, and the other sources this tool already exposed). Older labels such as `"Web Search"` are accepted and rewritten to the short id before the API call. Default is `["web", "twitter"]`. |
| `x-search` | Present, under the broken `twitterSearch` call. Optional filters were added later (`user`, dates, language, verification, media, engagement). Sort stays Top. |
| `web-search` | New. |
| `web-links-search` | New. `tools` accepts only `web` and defaults to `["web"]`. |
| `x-links-search` | New. |
| `x-posts-by-urls`, `x-post-by-id`, `x-posts-by-user`, `x-post-retweeters`, `x-user-posts`, `x-user-replies`, `x-post-replies` | New. |
| `extract`, `web-crawl` | New. Prefer `extract`. |
| `x-trends` | New. |

The same process can serve MCP Streamable HTTP (`--http` or `MCP_TRANSPORT=http`). Stdio is unchanged: it reads `DESEARCH_API_KEY`.

### `web-links-search` sources

Hosted `https://mcp.desearch.ai/mcp` already lists `web-links-search`. After this release, that tool's schema accepts only `web`. `"Web Search"` is rewritten to `web`. Callers that send `hackernews`, `reddit`, `wikipedia`, `youtube`, or `arxiv` fail input validation. The live `POST /desearch/ai/search/links/web` route rejects those ids with HTTP 422 (`supported tools are Web Search`). npm `0.0.1` never shipped this tool, so this is a break for hosted MCP clients, not for existing npm installs.

### Link payloads

When `web-links-search` or `ai-search` gets a body with no links (billing fields only, or an empty link list), the tool text includes `message: "no links in response"` and the billing fields. A non-empty link list is returned as the API sent it. The API still sometimes omits links; that fix is in desearch-public-api.

### Docker

The image command is `node build/index.js` (stdio). Streamable HTTP is `node build/index.js --http` or `MCP_TRANSPORT=http`.

### Runtime

Node.js `>=20.18.1`. Node 22 is supported. Node 18 is not. `desearch-js` loads `undici` at runtime with a range of `>=5`, which a lockfile-free install resolves to undici 8 (Node `>=22.19`, and it crashes on Node 20). This package depends on `undici@^7.29.1` so a clean install stays on undici 7.

### Tool annotations

In 0.1.2, `tools/list` set MCP tool annotations on every tool in that release:

- `readOnlyHint: true` — the tool reads Desearch, the web, or X and does not write caller state
- `destructiveHint: false` — it does not perform a destructive update
- `openWorldHint: true` — results come from live external sources

These are hints. A call still bills the Desearch API key. Repeating a call is not free.
