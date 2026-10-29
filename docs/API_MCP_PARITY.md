# Desearch API ↔ MCP parity

The product rule is that every public Desearch API / SDK method is exposed as an MCP tool. This file is the inventory for that work. It tracks `desearch-js` **1.5.0** (current) against the MCP server. HTTP paths are the ones the SDK calls on `https://api.desearch.ai`.

Auth is unchanged: stdio reads `DESEARCH_API_KEY`; Streamable HTTP builds one client per request from `Authorization: Bearer <key>` or `x-api-key`.

## Phases

| Phase | Scope | Status |
| --- | --- | --- |
| Shipped | `ai-search`, `x-search` | Done before this plan. Tool names and the base `query` / `count` arguments stay stable. |
| Phase 2 | Web tools: `web-search`, `web-links-search` | Done. |
| Phase 3 | Remaining X tools (posts, user timelines, replies, retweeters, AI X links). Also the extra `xSearch` filters on `x-search`. | Done. |
| Phase 4 | `extract`, legacy `webCrawl` (`web-crawl`), and `xTrends` | Done. |
| People Search | `people-search`, `people-search-status`, `people-search-pause`, `people-search-resume`, `people-search-cancel`, `people-search-tasks`, `people-profiles` | Done in 0.2.0. Merge after People Search is live on `api.desearch.ai`. |
| Full API coverage | `search-api` (`POST /search`), `tiktok`, `facebook`, `instagram` (the 19 social routes), `people-search-export` (both People Search `/export` routes) | Done in 0.4.0. These routes are not in `desearch-js` 1.5, so the tools call them directly (`desearch-api.ts`). |

Phase 4 covers the remaining public `desearch-js` 1.5 methods. Every method in the table below has an MCP tool. The intentional gap is `latestTweets`: desearch-js 1.0.1 called `GET /twitter/latest`, and 1.5 removed that method, so there is no MCP tool for it. `web-crawl` stays even though the SDK deprecates `webCrawl` in favor of `extract`.

The network stats routes (`GET /network/stats`, `/network/stats/history`, `/network/stats/stream`) are the other intentional gap: they describe the Desearch network rather than search data, and they are covered by the SDKs only.

## Tool source ids

`ai-search` and `web-links-search` use short ids in `tool-sources.ts`. The JSON Schema `enum` lists those ids (`web`, not `Web Search`). `canonicalToolId` rewrites the old display labels that still match the API before the handler calls desearch-js, so a client that still sends `"Web Search"` does not get `-32602`, and the API body uses the short id.

`ai-search` `tools` is `web`, `twitter`, `arxiv`, `wikipedia`, `hackernews`, and `reddit` (`AI_SEARCH_TOOLS` in `tool-sources.ts`, main order with `youtube` removed). The default when `tools` is omitted is `["web", "twitter"]`. Legacy labels `"Web Search"`, `"Twitter Search"`, `"ArXiv Search"`, `"Wikipedia Search"`, `"Hacker News Search"`, and `"Reddit Search"` are rewritten to those ids. `youtube` and `"Youtube Search"` are not accepted.

`web-links-search` accepts only `web` (default `["web"]`). Live `WebToolEnum` is `web` only; any other id 422s on `POST /desearch/ai/search/links/web` (`supported tools are Web Search`), so those ids are not in the MCP enum. `twitter` is valid only on `ai-search`. `"Web Search"` is still rewritten to `web` on this tool.

## Current SDK surface

| SDK method (1.5.0) | HTTP endpoint | MCP tool | Phase | Notes |
| --- | --- | --- | --- | --- |
| `aiSearch` | `POST /desearch/ai/search` | `ai-search` | done | `tools` is `web`, `twitter`, `arxiv`, `wikipedia`, `hackernews`, and `reddit` (`AI_SEARCH_TOOLS` in `tool-sources.ts`). The JSON Schema enum advertises those ids. `youtube` is not in the enum. Legacy labels `"Web Search"`, `"Twitter Search"`, `"ArXiv Search"`, `"Wikipedia Search"`, `"Hacker News Search"`, and `"Reddit Search"` are rewritten to the short id before `aiSearch`. `"Youtube Search"` is not rewritten. Default when `tools` is omitted: `["web", "twitter"]`. The handler still sends `model` (`NOVA` \| `ORBIT`) and `streaming: false`. `aiSearch` forwards that body and forces `streaming: false`. |
| `xSearch` | `GET /twitter` | `x-search` | done + Phase 3 filters | Base arguments stay `query` and `count` (default 20). The handler still sends `sort: "Top"` and does not expose `sort`. Phase 3 adds optional filters and omits any that the caller leaves unset: `user`, `start_date`, `end_date` (YYYY-MM-DD), `lang`, `verified`, `blue_verified`, `is_quote`, `is_video`, `is_image`, `min_retweets`, `min_replies`, `min_likes`. Engagement thresholds are integers (minimum 0). |
| `webSearch` | `GET /web` | `web-search` | done (Phase 2) | Args match `WebSearchParams`: `query` (required), `start` (optional page offset). See the `num` note below. |
| `aiWebLinksSearch` | `POST /desearch/ai/search/links/web` | `web-links-search` | done (Phase 2) | `prompt`, optional `count` (10–200), and `tools` defaulting to `["web"]`. The JSON Schema enum is `web` only. `"Web Search"` is rewritten to `web` before the call. The live route 422s any other id (`supported tools are Web Search`), so the MCP enum does not offer them. X is not a tool on this endpoint. |
| `aiXLinksSearch` | `POST /desearch/ai/search/links/twitter` | `x-links-search` | done (Phase 3) | Args match `AiXLinksSearchRequest`: `prompt`, optional `count` (10–200). |
| `xPostsByUrls` | `GET /twitter/urls` | `x-posts-by-urls` | done (Phase 3) | `urls: string[]` (at least one). |
| `xPostById` | `GET /twitter/post` | `x-post-by-id` | done (Phase 3) | `id`. 1.0.1 called `GET /twitter/{id}` instead. |
| `xPostsByUser` | `GET /twitter/post/user` | `x-posts-by-user` | done (Phase 3) | `user`, optional `query`, optional `count` (1–100). |
| `xPostRetweeters` | `GET /twitter/post/retweeters` | `x-post-retweeters` | done (Phase 3) | `id`, optional `cursor`. Different route from 1.0.1 `retweetsForPost`. |
| `xUserPosts` | `GET /twitter/user/posts` | `x-user-posts` | done (Phase 3) | `username`, optional `cursor`. |
| `xUserReplies` | `GET /twitter/replies` | `x-user-replies` | done (Phase 3) | `user`, optional `count` (1–100), optional `query`. |
| `xPostReplies` | `GET /twitter/replies/post` | `x-post-replies` | done (Phase 3) | `post_id`, optional `count` (1–100), optional `query`. |
| `xTrends` | `GET /twitter/trends` | `x-trends` | done (Phase 4) | Args match `XTrendsParams`: `woeid` (required integer), optional `count` (30–100). |
| `extract` | `GET /web/extract` | `extract` | done (Phase 4) | Args match `ExtractParams`: `url`, optional `format` (`html` \| `text`), `js`, `wait` (milliseconds). Preferred over crawl for new integrations. |
| `webCrawl` | `GET /web/crawl` | `web-crawl` | done (Phase 4) | Same params as `extract` (`WebCrawlParams` extends `ExtractParams`). SDK marks `webCrawl` deprecated and keeps it only for the legacy route. The MCP tool description says to prefer `extract`. |

Tool handlers return the SDK payload as pretty-printed JSON text. They do not pass `includeMetadata: true`, same as `ai-search` and `x-search`.

## People Search routes

People Search is not in `desearch-js` 1.5. `people.ts` calls the routes directly (through the shared request helper in `desearch-api.ts`) with the same base URL (`https://api.desearch.ai`), the same `Authorization: <key>` header, and the same `HTTP <status>: <detail>` error text as desearch-js. The contract is `desearch-public-api` `src/model/people.py`, `src/routers/people.py`, and `src/utils/people_filters.py`.

| HTTP endpoint | MCP tool | Billed | Notes |
| --- | --- | --- | --- |
| `POST /desearch/people/search/{x,youtube,linkedin,tiktok}` | `people-search` | Yes | `platform` picks the route. Body is `query`, optional `count` (5–200), `min_score`, `exclude`, `filters`, and `metadata` (string labels; the tool checks the API's key, value and 10-key limits before the call and leaves out an empty object). The MCP tool takes the filters as top-level arguments and builds `filters` from the ones set; a filter that is not in that platform's model (`XProfileSearchFilters`, `YouTubeCreatorSearchFilters`, `LinkedInProfileSearchFilters`, `TikTokCreatorSearchFilters`) is rejected before the call, because the API forbids extra keys. `idempotency_key` is sent as the `Idempotency-Key` header. A 200 (same key as an earlier search) is returned with `existing_task: true`. |
| `GET /desearch/people/tasks/{task_id}` | `people-search-status` | No | Status, stage, progress, errors, and cost. Once it has ended: `completion_reason`, `coverage_limited` (only when `true`), and `warnings` (each `code`, `platform`, `attempted`, `failed`, `by_reason`; the `message` only for a code the server does not know). The next-step hint names a budget stop, `no_candidates`, and `zero_qualified`. |
| `GET /desearch/people/tasks/{task_id}/results` | `people-search-status` | No | Called in the same tool when `result_count > 0` and the task has not expired. `cursor` and `limit` (MCP default 25, max 100; API allows 500) pass through. Each person is reduced to `id`, `platform`, `handle`, `name`, `url`, `audience`, `location`, `verified`, `headline`, `company`, `score`, `why` (`score.summary`), up to three `reasons`, `fully_verified`, `unverified_criteria` (up to five criteria from `score.criteria_checks` that are `unknown` or `not_met`, or a disqualifier that is `met`, read from each check's `is_disqualifier` with the keyword rule as fallback; the same rule as the CSV column of that name), `enrichment` and `enrichment_error` (only when `attributes.enrichment` is `failed`), `contacts`, `links`, and `evidence_url`. |
| `POST /desearch/people/tasks/{task_id}/pause` | `people-search-pause` | No | Takes only `task_id`. A 409 is returned as a tool error with the API detail and the task's current status. |
| `POST /desearch/people/tasks/{task_id}/resume` | `people-search-resume` | No | Takes only `task_id`. A 409 is returned as a tool error with the API detail and the task's current status. |
| `POST /desearch/people/tasks/{task_id}/cancel` | `people-search-cancel` | No | Takes only `task_id`. Cannot be undone. A 409 is returned as a tool error with the API detail and the task's current status. |
| `GET /desearch/people/tasks` | `people-search-tasks` | No | `platform`, `status` (list, sent comma-separated), `limit`, `cursor`, and `metadata` (up to 3 pairs, each sent as `metadata.<key>=<value>`). Each task carries the same `completion_reason`, `coverage_limited`, and `warnings` as `people-search-status`. |
| `GET /desearch/people/profiles` | `people-profiles` | No | `platform`, `q`, `sort`, `limit` (MCP default 25), `cursor`, and the result filters `has` (list, sent comma-separated), `min_audience`, `max_audience`, `min_score`, `location`, `verified`. Each profile keeps `found_by`. |
| `GET /desearch/people/tasks/{task_id}/export` | `people-search-export` (with `task_id`) | No | `format` (`csv` default, or `jsonl`) and the result filters `has` (list, sent comma-separated), `min_audience`, `max_audience`, `min_score`, `location`, `verified`. `platform`, `q`, and `sort` are refused with a `task_id`. The tool returns two text blocks: a note (rows in the file, rows shown, rows cut and why, and the API URL for the whole file), then the file text cut at a record boundary to `max_rows` rows (1–1000, default 100) and 50,000 characters. CSV keeps its header row; a CSV field with a line break stays one row. 404 and 410 are tool errors with the API detail. |
| `GET /desearch/people/profiles/export` | `people-search-export` (with `platform`, no `task_id`) | No | `platform` (required here), `format`, `q`, `sort`, and the same result filters. Same note, cut, and errors as the task export. The API caps this file at 10,000 people. |

## TikTok, Facebook, and Instagram routes

Not in `desearch-js` 1.5. `social.ts` calls them with the same base URL, `Authorization: <key>` header, and `HTTP <status>: <detail>` error text as the other direct calls. The contract is the production OpenAPI spec (`TikTokSearchRequest`, `FacebookSearchRequest`, `InstagramSearchRequest`, and the route parameters) and desearch-public-api `docs/social-pagination.md`.

One tool per platform; `action` picks the route. Each action needs the arguments in bold and accepts the others listed; anything else is refused before a request is sent (`tiktok action "trending" does not take cursor. trending takes: region, count. No request was sent.`). The tools also reject argument names they do not list. Path arguments are URL-encoded (`{id:path}` routes still receive an id that contains `/` as one value). A leading `@` on a username and `#` on a tag are removed; a cursor is never changed.

| HTTP endpoint | MCP tool and action | Arguments | Pages |
| --- | --- | --- | --- |
| `POST /desearch/tiktok/search` | `tiktok` `search` | **`query`**, `count` (1–100, API default 10), `sort`, `cursor` (all in the body) | Yes |
| `GET /desearch/tiktok/post/{id}` | `tiktok` `post` | **`id`** | — |
| `GET /desearch/tiktok/profile/{username}` | `tiktok` `profile` | **`username`** | — |
| `GET /desearch/tiktok/profile/{username}/posts` | `tiktok` `profile_posts` | **`username`**, `count` (API default 20), `cursor` | Yes |
| `GET /desearch/tiktok/comments/{video_id}` | `tiktok` `comments` | **`video_id`**, `count`, `cursor` | Yes |
| `GET /desearch/tiktok/hashtag/{tag}` | `tiktok` `hashtag` | **`tag`**, `count`, `cursor` | Yes |
| `GET /desearch/tiktok/trending` | `tiktok` `trending` | `region` (two letters, API default `US`), `count` | No cursor |
| `POST /desearch/facebook/search` | `facebook` `search` | **`query`**, `count`, `cursor` (body). Meta Ad Library ads. | Yes |
| `GET /desearch/facebook/post/{id}` | `facebook` `post` | **`id`** | — |
| `GET /desearch/facebook/profile/{profile_id}` | `facebook` `profile` | **`profile_id`** | — |
| `GET /desearch/facebook/profile/{profile_id}/posts` | `facebook` `profile_posts` | **`profile_id`**, `count`, `cursor` | Yes |
| `GET /desearch/facebook/comments/{post_id}` | `facebook` `comments` | **`post_id`**, `count`, `cursor` | Yes |
| `GET /desearch/facebook/hashtag/{tag}` | `facebook` `hashtag` | **`tag`**, `count`, `cursor`. Meta Ad Library ads. | Yes |
| `POST /desearch/instagram/search` | `instagram` `search` | **`query`**, `count`. The API answers 422 to any cursor, so the tool does not take one. | No cursor |
| `GET /desearch/instagram/media/{id}` | `instagram` `media` | **`id`** (shortcode, numeric ID, or URL) | — |
| `GET /desearch/instagram/profile/{username}` | `instagram` `profile` | **`username`** | — |
| `GET /desearch/instagram/profile/{username}/posts` | `instagram` `profile_posts` | **`username`**, `count`, `cursor` | Yes |
| `GET /desearch/instagram/comments/{shortcode}` | `instagram` `comments` | **`shortcode`**, `count`, `cursor` | Yes |
| `GET /desearch/instagram/hashtag/{tag}` | `instagram` `hashtag` | **`tag`**, `count`, `cursor` | Yes |

Single-item actions (`post`, `profile`, `media`) return the API body unchanged. List actions return `{ results, next_cursor, next }`: `results` is the API's JSON array, `next_cursor` is the `x-desearch-next-cursor` response header (`null` when the API leaves it out, which it does on the last page and on routes that do not page), and `next` is one sentence on how to ask for the next page. The caller sends `next_cursor` back as `cursor` on the same action with the same target; the API answers 422 (not charged) to a cursor from another route or target, or one older than 24 hours.

## Search API

| HTTP endpoint | MCP tool | Notes |
| --- | --- | --- |
| `POST /search` | `search-api` | Body `SearchRequest`: `query` (1–2000 characters), `mode` (`fast` \| `balanced`), `count` (10, 15, or 20: integer, multiple of 5), `start_date` and `end_date` (YYYY-MM-DD), `highlights`, `page_text`. Fields the caller leaves out are not sent, so the API defaults apply. Returns the `SearchResponse` body (`results` with `url`, `title`, `published_date`, `highlights`, `page_text`, plus `cost_usd`, `usage_count`, `service`, `currency`) as pretty-printed JSON. Not the same as `search`, which wraps `GET /web` for page lookup clients. |

People tools reject unknown arguments. Without that, an argument the schema does not list (for example the API's nested `filters` object) would be dropped and the billed search would run without it.

## Link fields vs billing fields

`web-links-search` calls `desearch.aiWebLinksSearch` (`server.ts`). That SDK method `POST`s `{ prompt, tools, count? }` to `/desearch/ai/search/links/web` and returns the parsed JSON body. It does not call `/desearch/ai/search` and does not send `result_type`. Undefined `count` is omitted so the body matches a direct call such as `{"prompt":"bittensor subnet news","tools":["web"],"count":10}`.

When the API includes links, the handler returns that JSON unchanged. `/links/web` uses `search_results` (and may include per-source `*_search_results`). AI search may use `search`, `results`, or `data`. Billing fields (`cost_usd`, `usage_count`, `service`, `currency`) stay on the same object. The handler does not pick one key and drop the rest, and it does not invent links the API left out.

`/links/web` can return only those billing fields for some prompts. `ai-search` with `result_type: ONLY_LINKS` does the same today on `POST /desearch/ai/search`. Both are API bugs being fixed in desearch-public-api. `presentSearchBody` leaves a body unchanged when a link list is non-empty. A cost-only body and an empty link list both get `message: "no links in response"` plus the original fields, including billing. That note does not say the query returned results and does not name web search versus AI search.

`ai-search` sends the short ids from `tool-sources.ts` (`web`, `twitter`, `arxiv`, `wikipedia`, `hackernews`, `reddit`). A legacy display label for those ids is rewritten before `aiSearch`. `youtube` is not sent. No other MCP tool takes that multi-source `tools` list. `x-links-search` has no `tools` argument.

## Renames: desearch-js 1.0.1 → 1.5.0

The MCP package previously depended on `desearch-js` ^1.0.1. It now depends on ^1.5.0. `ai-search` and `x-search` call the renamed methods; their MCP names and the JSON they send are the same.

| 1.0.1 method | 1.5.0 method | What changed |
| --- | --- | --- |
| `AISearch` | `aiSearch` | camelCase. 1.5 always sends `streaming: false` (the MCP tool already did). Tool ids in the SDK type shortened (`"Web Search"` → `web`). The MCP tool now sends those short ids. A client that still passes a display label is rewritten before the request. `model` is no longer on `AiSearchRequest`; the MCP tool still sends it. |
| `twitterSearch` | `xSearch` | Rename. Still `GET /twitter`. |
| `webLinksSearch` | `aiWebLinksSearch` | Rename. Still `POST /desearch/ai/search/links/web`. 1.0.1 typed long tool names plus `model`. 1.5 uses short web tool ids and `count`, and does not type `model`. The MCP tool sends only `web` (default `["web"]`). `"Web Search"` is rewritten to `web`. The other 1.5 ids are not offered because the live route rejects them. |
| `twitterLinksSearch` | `aiXLinksSearch` | Rename. Still `POST /desearch/ai/search/links/twitter`. 1.5 drops `model` and adds `count`. MCP tool `x-links-search` follows 1.5 (`prompt`, optional `count`). |
| `webSearch` | `webSearch` | Name unchanged. 1.0.1 `WebSearchPayload` required `query`, `num`, and `start`. 1.5 `WebSearchParams` is `query` plus optional `start`. |
| `twitterByUrls(urls: string[])` | `xPostsByUrls({ urls })` | Argument wrapped in an object. Still `GET /twitter/urls`. |
| `twitterById(id)` | `xPostById({ id })` | Path changed from `GET /twitter/{id}` to `GET /twitter/post?id=`. |
| `tweetsByUser` | `xPostsByUser` | Same `GET /twitter/post/user`. |
| `tweetsAndRepliesByUser` | `xUserReplies` | Same `GET /twitter/replies`. |
| `twitterRepliesPost` | `xPostReplies` | Same `GET /twitter/replies/post`. |
| `retweetsForPost` | `xPostRetweeters` | Not a straight rename. 1.0.1 called `GET /twitter/retweets/post`. 1.5 calls `GET /twitter/post/retweeters` and returns users plus a cursor. |
| `tweeterUser` | `xUserPosts` | Not a straight rename. 1.0.1 called `GET /twitter/user`. 1.5 calls `GET /twitter/user/posts`. |
| `latestTweets` | — | Removed. 1.0.1 called `GET /twitter/latest`. No 1.5 method, so no MCP tool. This is the intentional gap on an otherwise complete public surface. |
| — | `xTrends` | New. `GET /twitter/trends`. |
| — | `extract` | New. `GET /web/extract`. |
| — | `webCrawl` | New, then deprecated in favor of `extract`. `GET /web/crawl`. |

## `web-search` and `num`

`web-search` matches the published 1.5 `WebSearchParams` (`query`, `start`) and does not send `num`.

- desearch-js 1.0.1 required `num` on `webSearch`.
- desearch-js 1.5.0 `WebSearchParams` does not declare `num`.
- The public `GET /web` reference documents `query` and `start`.
- Some SDK guides (JavaScript and Python examples) still show `num`.

Expose `num` only after the current JS SDK type includes it, so the MCP schema and the SDK stay the same contract.

## `search` and `fetch`

`search` and `fetch` are not separate Desearch API routes. `search` calls `webSearch` (`GET /web`) and returns `{ results: [{ id, title, url }] }`, using the result link as `id`. `fetch` calls `extract` (`GET /web/extract`) with that URL and returns `{ id, title, text, url, metadata }`. Clients that look up a page by query and then read it use this pair. The other tools stay available.
