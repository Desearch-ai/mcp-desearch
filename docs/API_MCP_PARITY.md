# Desearch API ↔ MCP parity

Version 0.10.0 exposes 51 tools.

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
| Company Search | `company-search`, `company-enrich`, `company-search-status`, `company-search-pause`, `company-search-resume`, `company-search-cancel`, `company-search-tasks` | Done in 0.6.0. Company Search is live on `api.desearch.ai` since 2026-10-29. |
| Full API coverage | `search-api` (`POST /search`), `tiktok`, `facebook`, `instagram` (the 19 social routes), `people-search-export` (both People Search `/export` routes) | Done in 0.7.0. These routes are not in `desearch-js` 1.5, so the tools call them directly (`desearch-api.ts`). |
| YouTube, Reddit, Threads | `youtube`, `reddit`, `threads` (the 16 routes tagged YouTube Search, Reddit Search, and Threads Search) | Done in 0.8.0. Not in `desearch-js` 1.5; same direct calls and `action` pattern as `tiktok`. The routes are live on `api.desearch.ai`. |
| Monitors | `monitor-create`, `monitor-estimate`, `monitor-list`, `monitor-get`, `monitor-update`, `monitor-delete`, `monitor-trigger`, `monitor-runs`, `monitor-run`, `monitor-items`, `monitor-webhook-test`, `monitor-webhook-rotate-secret` (the 12 `/desearch/monitors` routes) | Done in 0.10.0. Not in `desearch-js` 1.5; direct calls (`monitors.ts`). On `api-dev.desearch.ai` since 2026-11-03; the `tiktok` source and watched accounts come with desearch-public-api #635, and the `instagram`, `facebook`, and `meta_ads` sources, Threads accounts, and `webhook.last_delivery` with #644 (on `api-dev` since 2026-11-04), each with its console migration. Merge after Monitors is live on `api.desearch.ai`. |

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
| `extract` | `GET /web/extract` | `extract` | done (Phase 4) | Args match `ExtractParams`: `url`, optional `format` (`html` \| `text` \| `markdown`), `js`, `wait` (milliseconds), `full_page` (text only). Preferred over crawl for new integrations. |
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
| `POST /desearch/facebook/search` | `facebook` `search` | **`query`**, `count`, `sort` (`impressions`, the API default, or `recent`; desearch-public-api #644), `cursor` (body). Meta Ad Library ads. | Yes |
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

## YouTube, Reddit, and Threads routes

Not in `desearch-js` 1.5. Same `social.ts` table, `action` pattern, argument checks, and `{ results, next_cursor, next }` list shape as TikTok. The contract is the OpenAPI spec on `https://api-dev.desearch.ai/openapi.json` (tags YouTube Search, Reddit Search, and Threads Search: `YouTubeSearchRequest`, `RedditSearchRequest`, `ThreadsSearchRequest`, `ThreadsUserSearchRequest`, and the route parameters). None of these routes takes `count`. Every request is billed as one unit, including an empty page; a 404, a 422, and a 5xx are not charged. A leading `@` on a Threads username and `r/` on a subreddit name are removed; a YouTube handle is sent as given (the API takes it with or without `@`).

| HTTP endpoint | MCP tool and action | Arguments | Pages |
| --- | --- | --- | --- |
| `POST /desearch/youtube/search` | `youtube` `search` | **`query`** (1–500), `type` (`videos`, `shorts`, `channels`, `playlists`), `upload_date` (`today`, `this_week`, `this_month`, `this_year`), `sort_by` (`relevance`, `popular`), `duration` (`under_3_min`, `between_3_and_20_min`, `over_20_min`), `cursor` (all in the body) | Yes |
| `GET /desearch/youtube/video/{id}` | `youtube` `video` | **`id`** (video or Short ID, or URL) | — |
| `GET /desearch/youtube/transcript/{video_id}` | `youtube` `transcript` | **`video_id`**, `language` (`en`, `es`, `pt-BR`, ...). 404 when the video has no captions. | — |
| `GET /desearch/youtube/comments/{video_id}` | `youtube` `comments` | **`video_id`**, `order` (`top`, `newest`), `cursor` | Yes |
| `GET /desearch/youtube/channel/{handle}` | `youtube` `channel` | **`handle`** (with or without `@`, or a `UC...` channel ID) | — |
| `GET /desearch/youtube/channel/{handle}/videos` | `youtube` `channel_videos` | **`handle`**, `sort` (`latest`, `popular`), `cursor` | Yes |
| `POST /desearch/reddit/search` | `reddit` `search` | **`query`** (1–500), `sort` (`relevance`, `new`, `top`, `comment_count`), `timeframe` (`all`, `day`, `week`, `month`, `year`), `cursor` (body) | Yes |
| `GET /desearch/reddit/subreddit/{name}` | `reddit` `subreddit` | **`name`** (case-sensitive) | — |
| `GET /desearch/reddit/subreddit/{name}/posts` | `reddit` `subreddit_posts` | **`name`**, `sort` (`best`, `hot`, `new`, `top`, `rising`), `timeframe` (for `top`), `cursor` | Yes |
| `GET /desearch/reddit/post/{id}` | `reddit` `post` | **`id`** (post ID with or without `t3_`, or URL) | — |
| `GET /desearch/reddit/comments/{post_id}` | `reddit` `comments` | **`post_id`**, `cursor` | Yes |
| `POST /desearch/threads/search` | `threads` `search` | **`query`** (1–500), `start_date`, `end_date` (YYYY-MM-DD). One page. | No cursor |
| `POST /desearch/threads/search/users` | `threads` `search_users` | **`query`** (1–100) | No cursor |
| `GET /desearch/threads/profile/{username}` | `threads` `profile` | **`username`** | — |
| `GET /desearch/threads/profile/{username}/posts` | `threads` `profile_posts` | **`username`**. Only the latest posts (Threads shows no older ones). | No cursor |
| `GET /desearch/threads/post/{id}` | `threads` `post` | **`id`** (post URL or shortcode). Returns `comments` and `threadItems` with the post. | — |

The two `sort` lists on `reddit` differ by action; a value from the other list is refused before the request (`reddit action "search" takes sort relevance, new, top, comment_count, not "hot".`). The `threads` tool has no `cursor` argument at all.

## Search API

| HTTP endpoint | MCP tool | Notes |
| --- | --- | --- |
| `POST /search` | `search-api` | Body `SearchRequest`: `query` (1–2000 characters), `mode` (`fast` \| `balanced`), `count` (10, 15, or 20: integer, multiple of 5), `start_date` and `end_date` (YYYY-MM-DD), `highlights`, `page_text`. Fields the caller leaves out are not sent, so the API defaults apply. Returns the `SearchResponse` body (`results` with `url`, `title`, `published_date`, `highlights`, `page_text`, plus `cost_usd`, `usage_count`, `service`, `currency`) as pretty-printed JSON. Not the same as `search`, which wraps `GET /web` for page lookup clients. |

People tools reject unknown arguments. Without that, an argument the schema does not list (for example the API's nested `filters` object) would be dropped and the billed search would run without it.

## Company Search routes

Company Search and Company Enrich are not in `desearch-js` 1.5. `companies.ts` calls the `/desearch/companies/*` routes directly with the same base URL, `Authorization: <key>` header, and `HTTP <status>: <detail>` error text as People Search (the shared request helper in `desearch-api.ts`). The contract is `desearch-public-api` `docs/company-search.md`, `src/model/companies.py`, and `src/routers/companies.py`. Both products run on the People Search engine (statuses, reserve-then-settle billing, pause / resume / cancel, idempotency, and metadata work the same way), but a People Search `task_id` is a 404 on these routes and a company `task_id` is a 404 on People Search's.

| HTTP endpoint | MCP tool | Billed | Notes |
| --- | --- | --- | --- |
| `POST /desearch/companies/search` | `company-search` | Yes | Body is `query` (3–1000), optional `count` (5–200), `min_score` (0–100), `exclude` (domains or URLs, up to 1000), `max_cost_usd` (a number, more than 0 and up to 100: the search budget, reserved whole; search effort is billed where the companies delivered do not cover it), `continue_from` (an ended Company Search's `task_id`: its delivered, review, and excluded domains are left out; 409 while it runs, 404 when it is not the caller's Company Search), `roles`, `infer_emails`, `verify_emails`, `filters`, and `metadata` (same rules and pre-call checks as `people-search`; an empty object is left out). The MCP tool takes `countries` (up to 20) and `require` (`email`, `phone`, `linkedin`, `leader`, `leader_email`) as top-level arguments and sends them as `filters.countries` and `filters.require`; the API's nested `filters` object is rejected by the tool, because a dropped filter would still run, and bill, the search. `roles` is any of `ceo`, `founder`, `cto`, `cfo`, `coo`, `cmo`, `president`, `owner`, `managing_director` (at least one). Only the arguments the caller set are sent, so API defaults apply. `idempotency_key` (up to 200 characters) is sent as the `Idempotency-Key` header. A 200 (same key as an earlier task) is returned with `existing_task: true`. |
| `POST /desearch/companies/enrich` | `company-enrich` | Yes | Body is `domains` (1–200 domains or URLs; the API normalizes and deduplicates them, and `count` is the number left), optional `roles`, `infer_emails`, `verify_emails`, and `metadata`. `idempotency_key` and the 200 replay work as on `company-search`. |
| `GET /desearch/companies/tasks/{task_id}` | `company-search-status` | No | Status, stage (including `enriching`), progress (passed through without its copy of `warnings`), errors, and cost. `search_type` (`company_search` or `company_enrich`) is kept and `platform` is dropped. Once it has ended: `completion_reason` (People Search's values plus `all_domains_processed`), `coverage_limited` (only when `true`), and `warnings` (each `code` and `message`; company warnings are short). `request.max_cost_usd` and `request.continue_from` are shown as `max_cost_usd` and `continue_from`, and `interpreted.interpretation.only_domains` (a search restricted to the domains its query names) as `only_domains`; the rest of `request` and `interpreted` is dropped. `progress.effort_units` passes through. The `next` hint of a search a limit stopped before `count` says how to continue it with `continue_from`, and that a budget needs the user's agreement. |
| `GET /desearch/companies/tasks/{task_id}/results` | `company-search-status` | No | Called in the same tool when `result_count > 0` and the task has not expired. `cursor` and `limit` (MCP default 10, max 100; API default 100, max 500) pass through. Each company is reduced to `domain`, `name`, `url`, `industry`, `location`, `description` (up to 300 characters), `score` (always present: the fit score, or `null` for Company Enrich), `why` (`score.summary`), up to three `reasons`, `fully_verified`, `unverified_criteria` (the People Search rule, from `score.criteria_checks`), `primary_email`, `primary_contact`, `contact_coverage`, `emails` (`value`, `type`, `source`, `source_url`, `person`, `confidence`, `pattern`, and `verification` as the check's status), `phones` and `socials` (each with `source_url`), `leaders` (from `people`: `name`, `title`, `roles`, `verified`, `linkedin_url`, `x_url`, `github_url`, `emails`, `phones`, `evidence_url`), and `enrichment` (`status`, `stages`, `errors`). The `next` hint knows that results are filled in place: while a task runs, or is `enriching`, it says when to read again without `cursor` to get the latest version of companies already returned, and after the task ends it says how many companies on the page stayed `partial`. |
| `GET /desearch/companies/tasks/{task_id}/export` | — | No | Not a tool (People Search's export routes are, as `people-search-export`). It streams a whole CSV or JSON Lines file (`format=csv` or `format=jsonl`). Read pages with `company-search-status`, or call the API for a file. |
| `POST /desearch/companies/tasks/{task_id}/pause` | `company-search-pause` | No | Takes only `task_id`. A 409 is returned as a tool error with the API detail and the task's current status. |
| `POST /desearch/companies/tasks/{task_id}/resume` | `company-search-resume` | No | Takes only `task_id`. A 409 is returned as a tool error with the API detail and the task's current status. |
| `POST /desearch/companies/tasks/{task_id}/cancel` | `company-search-cancel` | No | Takes only `task_id`. Cannot be undone. A 409 is returned as a tool error with the API detail and the task's current status. |
| `GET /desearch/companies/tasks` | `company-search-tasks` | No | `type` (`search` or `enrich`), `status` (list, sent comma-separated), `limit`, `cursor`, and `metadata` (up to 3 pairs, each sent as `metadata.<key>=<value>`). Each task carries the same `completion_reason`, `coverage_limited`, and `warnings` as `company-search-status`. People Search tasks are not listed. |

Company tools reject unknown arguments, like the People tools.

## Monitors routes

Monitors are not in `desearch-js` 1.5. `monitors.ts` calls the `/desearch/monitors/*` routes directly with the same base URL, `Authorization: <key>` header, and `HTTP <status>: <detail>` error text as Company Search (the shared request helper in `desearch-api.ts`, which now also sends `PATCH` and `DELETE`). The contract is `desearch-public-api` `docs/monitors.md`, `src/model/monitors.py`, and `src/routers/monitors.py`. Every route is free; each run a monitor makes is billed when it ends (its searches at list price, AI screening at the `/desearch/monitors` price per item screened, and the summary's LLM usage plus 50%), with its `max_run_cost_usd` held while it runs. `monitor_id` and `run_id` must be UUIDs and are URL-encoded into the path.

| HTTP endpoint | MCP tool | Starts a billed run | Notes |
| --- | --- | --- | --- |
| `POST /desearch/monitors` | `monitor-create` | With `run_now` (API default `true`) | Body is `query` (3–500), optional `name` (≤ 120), `criteria` (≤ 5, each ≤ 300), `sources` (`web`, `x`, `reddit`, `youtube`, `threads`, `tiktok`, `instagram`, `facebook`, `meta_ads`), `interval`, `options`, `min_score` (0–100), `summary`, `webhook`, `metadata` (≤ 20 keys of 1–64 characters, values ≤ 500), and `run_now`. The tool takes the per-source options flat (`web_count`; `x_count`, `x_lang`, `x_min_likes`, `x_accounts`; `reddit_subreddits`; `youtube_channels`; `tiktok_count` 10/20/30, `tiktok_accounts`, `tiktok_hashtags`; `threads_accounts`; `instagram_accounts`, `instagram_hashtags`; `facebook_pages`; `meta_ads_count` 10/20/30) and sends them as `options.web.count`, `options.x.{count,lang,min_likes,accounts}`, `options.reddit.subreddits`, `options.youtube.channels`, `options.tiktok.{count,accounts,hashtags}`, `options.threads.accounts`, `options.instagram.{accounts,hashtags}`, `options.facebook.pages`, and `options.meta_ads.count`. Watched-account and watched-hashtag lists hold at most 10 entries; they are sent as given (an empty list too, which watches none) and the API returns them cleaned (hashtags without `#`, in any script), or a 422 for a name or hashtag it cannot read (an X username has 1–15 characters). A hashtag feed lists posts from any account. `instagram` and `facebook` read only watched feeds: the API answers 422 when `instagram` is in `sources` without `instagram_accounts` or `instagram_hashtags`, or `facebook` without `facebook_pages`. The tool sends such a request rather than refusing it, because on an update the rule depends on the monitor's current sources and options. `meta_ads` searches the Meta Ad Library with the query as keywords (a sentence finds nothing). TikTok search has no working date filter and ranks by relevance, so a TikTok keyword monitor finds a new video only when it reaches TikTok's top results; `tiktok_accounts` follows creators. The descriptions give the per-run prices: TikTok, Instagram, Facebook, and Meta ads are billed per read ($3.00 per 1,000 reads, whatever the number of posts): one per watched account, hashtag, Facebook page, TikTok keyword search, or Ad Library search, two for an empty or private TikTok account; a Threads account is $0.00207. The tool also takes `webhook_url` and `webhook_events` and sends them as `webhook` (events without a URL are refused before the request). Only the arguments the caller set are sent, so API defaults apply. The reply is the monitor as the API sent it (with `webhook_secret` when a webhook is set) plus a `next` hint. |
| `POST /desearch/monitors/estimate` | `monitor-estimate` | No | Body is `sources`, `options` (from `web_count`, `x_count`, `tiktok_count`, `meta_ads_count`, and the watched-account lists: the options that change the cost), `summary`, and `interval`. Returned as the API sent it, with `breakdown` per source plus screening and summary. Unlike create, it does not refuse `instagram` or `facebook` without accounts or hashtags. |
| `GET /desearch/monitors` | `monitor-list` | No | `status` (list of `active`, `paused`, sent comma-separated), `limit` (1–100), `cursor`. Returns `{ monitors, next_cursor }`, `next_cursor` `null` on the last page. |
| `GET /desearch/monitors/{monitor_id}` | `monitor-get` | No | Returned as the API sent it, including `webhook.last_delivery` (`null` before the first delivery, else `event`, `status` `pending`/`delivered`/`failed`, `attempts`, `status_code`, `error`, `created_at`, `next_attempt_at`, `delivered_at`), which the description explains; `monitor-list` returns the same view. |
| `PATCH /desearch/monitors/{monitor_id}` | `monitor-update` | No | The `monitor-create` settings except `run_now`, plus `status` (`active` or `paused`). `remove_webhook: true` sends `webhook: null` (null arguments are treated as omitted, so the removal needs its own flag); it cannot be combined with `webhook_url`. A call with nothing to change is refused before the request. `options` replace the monitor's options as a whole. The API checks the monitor as patched (sources from the patch or the monitor, options from the patch or the monitor) and answers 422 when `instagram` is left without accounts or hashtags, or `facebook` without pages. A changed webhook URL returns a new `webhook_secret`. |
| `DELETE /desearch/monitors/{monitor_id}` | `monitor-delete` | No | Returns `{ monitor_id, deleted: true }`; a second delete is a 404. |
| `POST /desearch/monitors/{monitor_id}/trigger` | `monitor-trigger` | Yes | Returns the queued run (202) plus a `next` hint. 409 while a run is queued or running; 402 when the balance cannot hold the run. |
| `GET /desearch/monitors/{monitor_id}/runs` | `monitor-runs` | No | `limit` (1–100), `cursor`. Returns `{ runs, next_cursor }`. Runs pass through, including `stats.sources.<source>.accounts_failed` and `hashtags_failed` and `stats.screen` (`ai` or `keyword`). |
| `GET /desearch/monitors/{monitor_id}/runs/{run_id}` | `monitor-run` | No | The run with its kept items, most relevant first, plus a `next` hint by status. Each item keeps `item_id`, `run_id`, `source`, `url`, `title`, `text` (cut to 1000 characters), `author` (`name`, `handle`, `url`), `published_at`, `score`, `signals`, `found_at`, and `data` (passed through; the `monitor-run` and `monitor-items` descriptions list it per source: X, Reddit, YouTube, TikTok (with `saves`), Threads `likes`, Instagram `likes`/`comments`/`views`/`media_type`, Facebook `reactions`/`comments`/`shares`/`views`, the TikTok, Instagram, and Facebook post fields `post_id`/`type`/`hashtags`/`mentions`/`media`/`thumbnail`, Meta ads `page`/`active`/`cta`/`link`/`platforms`/`thumbnail` with the ad headline as `title` and the Ad Library record as `url`, web, `account` on items from a watched account, and `hashtag` on items from a watched hashtag); `signals` passes through too (`criteria` with criteria; no `new_info` on Meta ads). Empty fields are left out. |
| `GET /desearch/monitors/{monitor_id}/items` | `monitor-items` | No | `source` (including `tiktok`, `instagram`, `facebook`, and `meta_ads`), `limit` (1–200), `cursor` (an item id, digits only). Returns `{ items, next_cursor }`, newest first, items as on `monitor-run`. |
| `POST /desearch/monitors/{monitor_id}/webhook/test` | `monitor-webhook-test` | No | Returns `{ delivered, status_code, error, duration_ms }` as the API sent it. The `monitor.test` event leaves `webhook.last_delivery` unchanged. 400 when the monitor has no webhook. |
| `POST /desearch/monitors/{monitor_id}/webhook/rotate-secret` | `monitor-webhook-rotate-secret` | No | Returns `{ webhook_secret }` plus a `next` hint. 400 when the monitor has no webhook. |

Monitor tools reject unknown arguments (including the API's nested `options` and `webhook`), like the People and Company tools.

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
