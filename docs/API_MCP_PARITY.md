# Desearch API ↔ MCP parity

The product rule is that every public Desearch API / SDK method is exposed as an MCP tool. This file is the inventory for that work. It tracks `desearch-js` **1.5.0** (current) against the MCP server. HTTP paths are the ones the SDK calls on `https://api.desearch.ai`.

Auth is unchanged: stdio reads `DESEARCH_API_KEY`; Streamable HTTP builds one client per request from `Authorization: Bearer <key>` or `x-api-key`.

## Phases

| Phase | Scope | Status |
| --- | --- | --- |
| Shipped | `ai-search`, `x-search` | Done before this plan. Tool names and the base `query` / `count` arguments stay stable. |
| Phase 2 | Web tools: `web-search`, `web-links-search` | Done. |
| Phase 3 | Remaining X tools (posts, user timelines, replies, retweeters, AI X links). Also the extra `xSearch` filters on `x-search`. | Done. |
| Phase 4 | `extract`, legacy `webCrawl` (`web-crawl`), and `xTrends` | Wiring done. `extract` and `web-crawl` are accepted. Full parity is blocked on upstream `GET /twitter/trends` HTTP 500. `x-trends` stays wired and is excluded from full-parity acceptance until that API is fixed and E2E passes. |

Phase 4 wires the remaining public `desearch-js` 1.5 methods. Every method in the table below has an MCP tool, including `x-trends`. Keep `x-trends` on the SDK surface; do not remove the tool.

**Acceptance** (Mirian, CTO, and Giga): the other 14 tools are accepted, including Phase 4 `extract` and `web-crawl`. Full parity acceptance excludes `x-trends` until Desearch API `GET /twitter/trends` is fixed and an end-to-end call passes. Full parity is only after that API fix and an E2E PASS.

The intentional SDK gap is `latestTweets`: desearch-js 1.0.1 called `GET /twitter/latest`, and 1.5 removed that method, so there is no MCP tool for it. That is separate from the `x-trends` upstream blocker. `web-crawl` stays even though the SDK deprecates `webCrawl` in favor of `extract`.

## Current SDK surface

| SDK method (1.5.0) | HTTP endpoint | MCP tool | Phase | Notes |
| --- | --- | --- | --- | --- |
| `aiSearch` | `POST /desearch/ai/search` | `ai-search` | done | MCP still sends the historical payload: long tool names (`"Web Search"`, `"Twitter Search"`, …), `model` (`NOVA` \| `ORBIT`), and `streaming: false`. `aiSearch` forwards that body and forces `streaming: false`. The 1.5 request type uses short tool ids (`web`, `twitter`, …) and does not type `model`; the MCP tool does not switch, so existing clients keep the same arguments and the same request. |
| `xSearch` | `GET /twitter` | `x-search` | done + Phase 3 filters | Base arguments stay `query` and `count` (default 20). The handler still sends `sort: "Top"` and does not expose `sort`. Phase 3 adds optional filters and omits any that the caller leaves unset: `user`, `start_date`, `end_date` (YYYY-MM-DD), `lang`, `verified`, `blue_verified`, `is_quote`, `is_video`, `is_image`, `min_retweets`, `min_replies`, `min_likes`. Engagement thresholds accept an integer or a string, matching `XSearchParams`. |
| `webSearch` | `GET /web` | `web-search` | done (Phase 2) | Args match `WebSearchParams`: `query` (required), `start` (optional page offset). See the `num` note below. |
| `aiWebLinksSearch` | `POST /desearch/ai/search/links/web` | `web-links-search` | done (Phase 2) | Args match `AiWebLinksSearchRequest`: `prompt`, `tools` (`web`, `hackernews`, `reddit`, `wikipedia`, `youtube`, `arxiv`), optional `count` (10–200). This route is POST in both 1.0.1 and 1.5.0, and in the public API reference. X is not a tool on this endpoint. |
| `aiXLinksSearch` | `POST /desearch/ai/search/links/twitter` | `x-links-search` | done (Phase 3) | Args match `AiXLinksSearchRequest`: `prompt`, optional `count` (10–200). |
| `xPostsByUrls` | `GET /twitter/urls` | `x-posts-by-urls` | done (Phase 3) | `urls: string[]` (at least one). |
| `xPostById` | `GET /twitter/post` | `x-post-by-id` | done (Phase 3) | `id`. 1.0.1 called `GET /twitter/{id}` instead. |
| `xPostsByUser` | `GET /twitter/post/user` | `x-posts-by-user` | done (Phase 3) | `user`, optional `query`, optional `count` (1–100). |
| `xPostRetweeters` | `GET /twitter/post/retweeters` | `x-post-retweeters` | done (Phase 3) | `id`, optional `cursor`. Different route from 1.0.1 `retweetsForPost`. |
| `xUserPosts` | `GET /twitter/user/posts` | `x-user-posts` | done (Phase 3) | `username`, optional `cursor`. |
| `xUserReplies` | `GET /twitter/replies` | `x-user-replies` | done (Phase 3) | `user`, optional `count` (1–100), optional `query`. |
| `xPostReplies` | `GET /twitter/replies/post` | `x-post-replies` | done (Phase 3) | `post_id`, optional `count` (1–100), optional `query`. |
| `xTrends` | `GET /twitter/trends` | `x-trends` | wired (Phase 4); excluded from full-parity acceptance | Wired ✅. Args match `XTrendsParams`: `woeid` (required integer), optional `count` (30–100). E2E blocked by upstream HTTP 500 for woeid `1` and `23424977` (body like `Something went wrong. Please try again later.`). Same failure on the direct API and via MCP. Stays on the SDK surface. Excluded from full parity acceptance until the trends API is fixed and E2E passes. See [Known blockers](#known-blockers). |
| `extract` | `GET /web/extract` | `extract` | done (Phase 4) | Args match `ExtractParams`: `url`, optional `format` (`html` \| `text`), `js`, `wait` (milliseconds). Preferred over crawl for new integrations. |
| `webCrawl` | `GET /web/crawl` | `web-crawl` | done (Phase 4) | Same params as `extract` (`WebCrawlParams` extends `ExtractParams`). SDK marks `webCrawl` deprecated and keeps it only for the legacy route. The MCP tool description says to prefer `extract`. |

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
| `latestTweets` | — | Removed. 1.0.1 called `GET /twitter/latest`. No 1.5 method, so no MCP tool. Intentional SDK gap, separate from the `x-trends` upstream blocker. |
| — | `xTrends` | New. `GET /twitter/trends`. Wired on MCP as `x-trends`. E2E blocked by upstream HTTP 500; excluded from full-parity acceptance until the API is fixed. See [Known blockers](#known-blockers). |
| — | `extract` | New. `GET /web/extract`. |
| — | `webCrawl` | New, then deprecated in favor of `extract`. `GET /web/crawl`. |

## `web-search` and `num`

`web-search` matches the published 1.5 `WebSearchParams` (`query`, `start`) and does not send `num`.

- desearch-js 1.0.1 required `num` on `webSearch`.
- desearch-js 1.5.0 `WebSearchParams` does not declare `num`.
- The public `GET /web` reference documents `query` and `start`.
- Some SDK guides (JavaScript and Python examples) still show `num`.

Expose `num` only after the current JS SDK type includes it, so the MCP schema and the SDK stay the same contract.

## Known blockers

### `x-trends` — upstream HTTP 500

Decision (Mirian, CTO, and Giga): the MCP tool `x-trends` stays wired. It is part of the public `desearch-js` 1.5 surface (`xTrends` → `GET /twitter/trends`). Do not remove it from the server. Full parity acceptance excludes it until the Desearch API is fixed.

End-to-end calls are blocked by the API, not by the MCP handler:

- WOEIDs exercised: `1` and `23424977`.
- Response: HTTP 500, body like `Something went wrong. Please try again later.`
- The same failure happens on a direct call to `GET /twitter/trends` and through the MCP tool.

Do not treat `x-trends` as working. The other 14 tools, including Phase 4 `extract` and `web-crawl`, are accepted. Full parity is only after the trends API is fixed and `x-trends` E2E passes.
