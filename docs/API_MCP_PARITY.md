# Desearch API ↔ MCP parity

The product rule is that every public Desearch API / SDK method is exposed as an MCP tool. This file is the inventory for that work. It tracks `desearch-js` **1.5.0** (current) against the MCP server. HTTP paths are the ones the SDK calls on `https://api.desearch.ai`.

Auth is unchanged: stdio reads `DESEARCH_API_KEY`; Streamable HTTP builds one client per request from `Authorization: Bearer <key>` or `x-api-key`.

## Phases

| Phase | Scope | Status |
| --- | --- | --- |
| Shipped | `ai-search`, `x-search` | Done before this plan. Tool names and the base `query` / `count` arguments stay stable. |
| Phase 2 | Web tools: `web-search`, `web-links-search` | Done. |
| Phase 3 | Remaining X tools (posts, user timelines, replies, retweeters, AI X links). Also the extra `xSearch` filters on `x-search`. | This PR. |
| Phase 4 | `extract`, legacy `webCrawl`, and `xTrends` | Later. Not implemented here. |

## Current SDK surface

| SDK method (1.5.0) | HTTP endpoint | MCP tool | Phase | Notes |
| --- | --- | --- | --- | --- |
| `aiSearch` | `POST /desearch/ai/search` | `ai-search` | done | MCP still sends the historical payload: long tool names (`"Web Search"`, `"Twitter Search"`, …), `model` (`NOVA` \| `ORBIT`), and `streaming: false`. `aiSearch` forwards that body and forces `streaming: false`. The 1.5 request type uses short tool ids (`web`, `twitter`, …) and does not type `model`; the MCP tool does not switch, so existing clients keep the same arguments and the same request. |
| `xSearch` | `GET /twitter` | `x-search` | done + Phase 3 filters | Base arguments stay `query` and `count` (default 20). The handler still sends `sort: "Top"` and does not expose `sort`. Phase 3 adds optional filters and omits any that the caller leaves unset: `user`, `start_date`, `end_date` (YYYY-MM-DD), `lang`, `verified`, `blue_verified`, `is_quote`, `is_video`, `is_image`, `min_retweets`, `min_replies`, `min_likes`. Engagement thresholds accept an integer or a string, matching `XSearchParams`. |
| `webSearch` | `GET /web` | `web-search` | done (Phase 2) | Args match `WebSearchParams`: `query` (required), `start` (optional page offset). See the `num` note below. |
| `aiWebLinksSearch` | `POST /desearch/ai/search/links/web` | `web-links-search` | done (Phase 2) | Args match `AiWebLinksSearchRequest`: `prompt`, `tools` (`web`, `hackernews`, `reddit`, `wikipedia`, `youtube`, `arxiv`), optional `count` (10–200). This route is POST in both 1.0.1 and 1.5.0, and in the public API reference. X is not a tool on this endpoint. |
| `aiXLinksSearch` | `POST /desearch/ai/search/links/twitter` | `x-links-search` | this PR (Phase 3) | Args match `AiXLinksSearchRequest`: `prompt`, optional `count` (10–200). |
| `xPostsByUrls` | `GET /twitter/urls` | `x-posts-by-urls` | this PR (Phase 3) | `urls: string[]` (at least one). |
| `xPostById` | `GET /twitter/post` | `x-post-by-id` | this PR (Phase 3) | `id`. 1.0.1 called `GET /twitter/{id}` instead. |
| `xPostsByUser` | `GET /twitter/post/user` | `x-posts-by-user` | this PR (Phase 3) | `user`, optional `query`, optional `count` (1–100). |
| `xPostRetweeters` | `GET /twitter/post/retweeters` | `x-post-retweeters` | this PR (Phase 3) | `id`, optional `cursor`. Different route from 1.0.1 `retweetsForPost`. |
| `xUserPosts` | `GET /twitter/user/posts` | `x-user-posts` | this PR (Phase 3) | `username`, optional `cursor`. |
| `xUserReplies` | `GET /twitter/replies` | `x-user-replies` | this PR (Phase 3) | `user`, optional `count` (1–100), optional `query`. |
| `xPostReplies` | `GET /twitter/replies/post` | `x-post-replies` | this PR (Phase 3) | `post_id`, optional `count` (1–100), optional `query`. |
| `xTrends` | `GET /twitter/trends` | `x-trends` | later (Phase 4) | `woeid`, optional `count` (30–100). Grouped with extract/crawl, not with the Phase 3 post helpers. |
| `extract` | `GET /web/extract` | `extract` | later (Phase 4) | `url`, optional `format` (`html` \| `text`), `js`, `wait`. Preferred over crawl for new integrations. |
| `webCrawl` | `GET /web/crawl` | `web-crawl` | later (Phase 4) | Same params as `extract`. SDK marks it deprecated and keeps it only for the legacy route. |

Tool handlers return the SDK payload as pretty-printed JSON text. They do not pass `includeMetadata: true`, same as `ai-search` and `x-search`.

## Renames: desearch-js 1.0.1 → 1.5.0

The MCP package previously depended on `desearch-js` ^1.0.1. It now depends on ^1.5.0. `ai-search` and `x-search` call the renamed methods; their MCP names and the JSON they send are the same.

| 1.0.1 method | 1.5.0 method | What changed |
| --- | --- | --- |
| `AISearch` | `aiSearch` | camelCase. 1.5 always sends `streaming: false` (the MCP tool already did). Tool ids in the *SDK type* shortened (`"Web Search"` → `web`); the MCP tool still sends the long names. `model` is no longer on `AiSearchRequest`; the MCP tool still sends it. |
| `twitterSearch` | `xSearch` | Rename. Still `GET /twitter`. |
| `webLinksSearch` | `aiWebLinksSearch` | Rename. Still `POST /desearch/ai/search/links/web`. 1.0.1 typed long tool names plus `model`. 1.5 uses short web tool ids and `count`, and does not type `model`. The new MCP tool follows 1.5. |
| `twitterLinksSearch` | `aiXLinksSearch` | Rename. Still `POST /desearch/ai/search/links/twitter`. 1.5 drops `model` and adds `count`. MCP tool `x-links-search` follows 1.5 (`prompt`, optional `count`). |
| `webSearch` | `webSearch` | Name unchanged. 1.0.1 `WebSearchPayload` required `query`, `num`, and `start`. 1.5 `WebSearchParams` is `query` plus optional `start`. |
| `twitterByUrls(urls: string[])` | `xPostsByUrls({ urls })` | Argument wrapped in an object. Still `GET /twitter/urls`. |
| `twitterById(id)` | `xPostById({ id })` | Path changed from `GET /twitter/{id}` to `GET /twitter/post?id=`. |
| `tweetsByUser` | `xPostsByUser` | Same `GET /twitter/post/user`. |
| `tweetsAndRepliesByUser` | `xUserReplies` | Same `GET /twitter/replies`. |
| `twitterRepliesPost` | `xPostReplies` | Same `GET /twitter/replies/post`. |
| `retweetsForPost` | `xPostRetweeters` | Not a straight rename. 1.0.1 called `GET /twitter/retweets/post`. 1.5 calls `GET /twitter/post/retweeters` and returns users plus a cursor. |
| `tweeterUser` | `xUserPosts` | Not a straight rename. 1.0.1 called `GET /twitter/user`. 1.5 calls `GET /twitter/user/posts`. |
| `latestTweets` | — | Removed. 1.0.1 called `GET /twitter/latest`. No 1.5 method, so no MCP tool is planned. |
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
