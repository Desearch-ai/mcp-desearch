# Desearch

The `desearch` MCP server connects to the hosted Desearch endpoint `https://mcp.desearch.ai/mcp` and sends your Desearch API key in the `x-api-key` header. Get a key at https://console.desearch.ai/api-keys.

Tools:

- `ai-search`: AI search across web and X sources (also arxiv, wikipedia, hackernews, reddit) with relevant links and a summary. `youtube` is not a tool id.
- `web-search`: SERP-style web search. `web-links-search`: web link search.
- `x-search`: tweet search on X. `x-links-search`: AI search for X post links.
- `extract`: read a public URL as text or HTML. Prefer it over `web-crawl` (legacy route, same arguments).
- X data tools: `x-posts-by-urls`, `x-post-by-id`, `x-posts-by-user`, `x-post-retweeters`, `x-user-posts`, `x-user-replies`, `x-post-replies`, `x-trends`.

Use `web-search` or `ai-search` when the user asks for current information from the web, `x-search` for posts on X, and `extract` to read a specific page.
