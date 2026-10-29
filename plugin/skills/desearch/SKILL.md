---
name: desearch
description: Choose which Desearch MCP tool to call. Use when the task needs AI search, web search, a page as text or HTML, X posts, X trends, or finding people and creators on X, YouTube, LinkedIn, or TikTok.
---

# Desearch

Pick one Desearch tool from this list. Do not call a tool that is not registered.

Set `DESEARCH_API_KEY` before the server starts. The plugin launches `npx -y desearch-mcp-server` and passes that variable through. The search and X tools send read requests. They do not post, follow, delete, or change an account. `people-search` starts a billed background search, and `people-search-pause`, `people-search-resume`, and `people-search-cancel` pause, resume, or cancel one.

## Which tool

- **AI Search** (`ai-search`): Calls Desearch AI search. Arguments: `prompt` (required). `tools` is optional and defaults to `web` and `twitter`. Allowed `tools` values are `web`, `twitter`, `arxiv`, `wikipedia`, `hackernews`, and `reddit`. Older labels such as `Web Search`, `ArXiv Search`, `Wikipedia Search`, `Hacker News Search`, and `Reddit Search` are accepted and rewritten to the short id. `youtube` is not accepted. Optional: `date_filter`, `start_date`, `end_date` (UTC), `result_type` (`ONLY_LINKS` or `LINKS_WITH_FINAL_SUMMARY`), `include_domains`, `exclude_domains`, `model` (`NOVA` or `ORBIT`, default `NOVA`).
- **Search** (`search`): Web search that returns `results` with `id`, `title`, and `url`. Argument: `query` (required). Use this when a client asks for a search tool.
- **Fetch Page** (`fetch`): Read one public page as text. Argument: `id` (required, an `http` or `https` URL, usually a `search` result URL).
- **Web Search** (`web-search`): Web search. Returns titles, links, and snippets. Arguments: `query` (required), `start` (optional offset: 0, 10, 20, ...).
- **Web Links Search** (`web-links-search`): Link search. Arguments: `prompt` (required), `tools` (optional, only `web`, default `["web"]`), `count` (optional, 10 to 200). `Web Search` is accepted and rewritten to `web`. Other sources are rejected. This tool does not accept X.
- **Extract** (`extract`): Read one public URL as text or HTML. Arguments: `url` (required), `format` (optional, `html` or `text`), `js` (optional), `wait` (optional milliseconds), `full_page` (optional: with `text`, every visible section of the page instead of its main content). Errors carry an `error_code`: `js_required` (retry with `js: true`), `blocked` (the site refused or showed a bot check), `page_not_found`.
- **Web Crawl** (`web-crawl`): Same arguments as Extract, on the legacy `/web/crawl` route. The SDK marks `webCrawl` deprecated in favor of `extract`. This tool stays so that route remains reachable.
- **X Search** (`x-search`): Search posts on X. Arguments: `query` (required), `count` (optional, default 20). Sort stays Top. Optional filters: `user`, `start_date`, `end_date` (YYYY-MM-DD), `lang`, `verified`, `blue_verified`, `is_quote`, `is_video`, `is_image`, `min_retweets`, `min_replies`, `min_likes`.
- **X Links Search** (`x-links-search`): Search for X post links. Arguments: `prompt` (required), `count` (optional, 10 to 200).
- **X Posts by URLs** (`x-posts-by-urls`): Posts for a list of post URLs. Argument: `urls` (required).
- **X Post by ID** (`x-post-by-id`): One post by ID. Argument: `id` (required).
- **X Posts by User** (`x-posts-by-user`): Posts by one user. Arguments: `user` (required), `query` (optional), `count` (optional, 1 to 100).
- **X User Posts** (`x-user-posts`): Posts from a username. Arguments: `username` (required), `cursor` (optional, from a previous response).
- **X User Replies** (`x-user-replies`): Posts and replies by one user. Arguments: `user` (required), `count` (optional, 1 to 100), `query` (optional).
- **X Post Replies** (`x-post-replies`): Replies to one post. Arguments: `post_id` (required), `count` (optional, 1 to 100), `query` (optional).
- **X Post Retweeters** (`x-post-retweeters`): Users who retweeted a post. Arguments: `id` (required), `cursor` (optional).
- **X Trends** (`x-trends`): Trends for a location WOEID. Arguments: `woeid` (required), `count` (optional, 30 to 100).
- **People Search** (`people-search`): Start a billed background search for people who match a plain-language description. It reserves `count` people at the platform's per-person price and bills only the people it delivers; a search that finds no one is free. Arguments: `platform` (required: `x`, `youtube`, `linkedin`, `tiktok`), `query` (required), `count` (optional, 5 to 200), `min_score` (optional, 0 to 100), `exclude` (optional handles), `metadata` (optional labels such as `{"campaign": "q4-outbound"}`: up to 10 keys of a-z, 0-9, `_`, `.`, `-`, string values up to 200 characters; returned on the task), `idempotency_key` (optional; reuse it on a retry so the search is not started twice). Filters by platform: x `min_followers`, `max_followers`, `verified_only`, `countries`, `keywords`, `exclude_keywords`; youtube `min_subscribers`, `max_subscribers`, `countries`, `require_contact`, `keywords`, `exclude_keywords`; linkedin `min_followers`, `max_followers`, `countries`, `keywords`, `exclude_keywords`; tiktok `min_followers`, `max_followers`, `require_contact`, `keywords`, `exclude_keywords`.
- **People Search Status** (`people-search-status`): Status, progress, cost, and a page of people for one task. Searches usually take 1 to 5 minutes. Arguments: `task_id` (required), `cursor` (optional, the previous `next_cursor`, to get only new people), `limit` (optional, 1 to 100, default 25), `include_people` (optional).
- **Pause People Search** (`people-search-pause`): Pause a task. Argument: `task_id` (required).
- **Resume People Search** (`people-search-resume`): Resume a paused task with no new charge. Argument: `task_id` (required).
- **Cancel People Search** (`people-search-cancel`): Stop a task for good; only people already delivered are billed. Argument: `task_id` (required). Cancel cannot be undone.
- **List People Search Tasks** (`people-search-tasks`): Your searches, newest first. Arguments: `platform`, `status` (list), `limit`, `cursor`, `metadata` (up to 3 labels a task must have, exact match), all optional.
- **List People Found** (`people-profiles`): Everyone your searches found on one platform. Arguments: `platform` (required), `q`, `sort` (`score`, `recent`, `audience`), `limit`, `cursor`, `has` (list of `email`, `website`, `x`, `linkedin`, `instagram`, `youtube`, `tiktok`), `min_audience`, `max_audience`, `min_score`, `location`, `verified`.

Before `people-search`, check `people-profiles` when the user may already have searched for these people. Start a new search only when the user asks to find people.

## When not to use these tools

Skip Desearch when the task is only about files in the current project, or when the text you need is already in the conversation. These tools do not browse a logged-in site, post to X, contact the people they find, or change Desearch account settings.
