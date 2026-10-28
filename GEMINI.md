# Desearch

The `desearch` MCP server connects to the hosted Desearch endpoint `https://mcp.desearch.ai/mcp` and sends your Desearch API key in the `x-api-key` header. Get a key at https://console.desearch.ai/api-keys.

Tools:

- `ai-search`: AI search across web and X sources (also arxiv, wikipedia, hackernews, reddit) with relevant links and a summary. `youtube` is not a tool id.
- `web-search`: SERP-style web search. `web-links-search`: web link search.
- `x-search`: tweet search on X. `x-links-search`: AI search for X post links.
- `extract`: read a public URL as text or HTML. Prefer it over `web-crawl` (legacy route, same arguments).
- X data tools: `x-posts-by-urls`, `x-post-by-id`, `x-posts-by-user`, `x-post-retweeters`, `x-user-posts`, `x-user-replies`, `x-post-replies`, `x-trends`.
- People Search: `people-search` starts a paid job billed to the user's Desearch balance (it reserves `count` people and bills only those it delivers). It is marked `readOnlyHint: false` and `destructiveHint: false`: it creates a new task and does not delete or overwrite anything. `openWorldHint` is true on every tool. Poll `people-search-status` with the `task_id` (searches usually take 1 to 5 minutes). Use `people-search-pause` and `people-search-resume` to pause and resume a search (`destructiveHint: false`, they undo each other) and `people-search-cancel` to stop it for good (`destructiveHint: true`, because cancel cannot be undone). `people-search-tasks` and `people-profiles` list past searches and the people they found. `people-search-status`, `people-search-tasks`, and `people-profiles` are read-only. All of these except `people-search` are free.

Use `web-search` or `ai-search` when the user asks for current information from the web, `x-search` for posts on X, and `extract` to read a specific page. Use `people-search` only when the user asks to find people, creators, or leads, because it is billed. Check `people-profiles` first when the user may already have searched for them.
