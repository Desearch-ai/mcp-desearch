# Changelog

## 0.1.3

Migration from the published npm package `desearch-mcp-server@0.0.1`.

### npm 0.0.1 versus this release

`0.0.1` exposed two tools and called desearch-js methods that 1.5.0 does not have (`AISearch`, `twitterSearch`). Those calls throw. `0.1.3` depends on desearch-js 1.5.0 and calls `aiSearch` and `xSearch`.

`0.0.1` did not include `web-links-search` or the other tools below. npm users are not losing a source list they already had.

### Tools

| Tool | In 0.0.1 |
| --- | --- |
| `ai-search` | Present, under the broken `AISearch` call. Arguments now include date range, `result_type`, and domain filters. Tool names stay the long labels (`"Web Search"`, `"Twitter Search"`, and the rest of that enum). |
| `x-search` | Present, under the broken `twitterSearch` call. Optional filters were added later (`user`, dates, language, verification, media, engagement). Sort stays Top. |
| `web-search` | New. |
| `web-links-search` | New. `tools` accepts only `web` and defaults to `["web"]`. |
| `x-links-search` | New. |
| `x-posts-by-urls`, `x-post-by-id`, `x-posts-by-user`, `x-post-retweeters`, `x-user-posts`, `x-user-replies`, `x-post-replies` | New. |
| `extract`, `web-crawl` | New. Prefer `extract`. |
| `x-trends` | New. |

The same process can serve MCP Streamable HTTP (`--http` or `MCP_TRANSPORT=http`). Stdio is unchanged: it reads `DESEARCH_API_KEY`.

### `web-links-search` sources

Hosted `https://mcp.desearch.ai/mcp` already lists `web-links-search`. After this release, that tool's schema accepts only `web`. Callers that send `hackernews`, `reddit`, `wikipedia`, `youtube`, or `arxiv` fail input validation. The live `POST /desearch/ai/search/links/web` route rejects those ids with HTTP 422 (`supported tools are Web Search`). npm `0.0.1` never shipped this tool, so this is a break for hosted MCP clients, not for existing npm installs.

### Link payloads

When `web-links-search` or `ai-search` gets a body with no links (billing fields only, or an empty link list), the tool text includes `message: "no links in response"` and the billing fields. A non-empty link list is returned as the API sent it. The API still sometimes omits links; that fix is in desearch-public-api.

### Runtime

Node.js `>=20.18.1`. Node 22 is supported. Node 18 is not. `desearch-js` loads `undici` at runtime with a range of `>=5`, which a lockfile-free install resolves to undici 8 (Node `>=22.19`, and it crashes on Node 20). This package depends on `undici@^7.29.1` so a clean install stays on undici 7.
