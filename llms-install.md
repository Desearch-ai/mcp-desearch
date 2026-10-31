# Installing the Desearch MCP server

These steps are for an AI agent (for example Cline) installing the Desearch MCP server for a user.

## 1. Get an API key

Ask the user for their Desearch API key. If they do not have one, they can create it at https://console.desearch.ai/api-keys. Never write the key into a file that is committed to a repository.

## 2. Option A: hosted server (recommended, no local install)

The hosted Streamable HTTP endpoint is `https://mcp.desearch.ai/mcp`. Send the key as `Authorization: Bearer <DESEARCH_API_KEY>`. The hosted server also accepts `x-api-key` as an alternative. A client that supports OAuth can sign in instead: the server asks for the same Desearch API key on its own page.

```json
{
  "mcpServers": {
    "desearch": {
      "url": "https://mcp.desearch.ai/mcp",
      "headers": {
        "Authorization": "Bearer <DESEARCH_API_KEY>"
      }
    }
  }
}
```

If the client asks for a transport type, choose Streamable HTTP.

## 3. Option B: local stdio server

Requires Node.js v20.18.1 or higher. The npm package is `desearch-mcp-server` and it reads the key from `DESEARCH_API_KEY`.

```json
{
  "mcpServers": {
    "desearch": {
      "command": "npx",
      "args": ["-y", "desearch-mcp-server@latest"],
      "env": {
        "DESEARCH_API_KEY": "YOUR_DESEARCH_API_KEY"
      }
    }
  }
}
```

## 4. Check the install

Version 0.7.0 exposes 36 tools: `search`, `fetch`, `ai-search`, `x-search`, `web-search`, `web-links-search`, `extract`, `web-crawl`, `x-links-search`, `x-posts-by-urls`, `x-post-by-id`, `x-posts-by-user`, `x-post-retweeters`, `x-user-posts`, `x-user-replies`, `x-post-replies`, `x-trends`, `people-search`, `people-search-status`, `people-search-pause`, `people-search-resume`, `people-search-cancel`, `people-search-tasks`, `people-profiles`, `company-search`, `company-enrich`, `company-search-status`, `company-search-pause`, `company-search-resume`, `company-search-cancel`, `company-search-tasks`, `search-api`, `tiktok`, `facebook`, `instagram`, `people-search-export`.

Run one `web-search` call (for example `{"query": "desearch"}`) and confirm it returns results. Listing tools works without a key, so a successful connection alone does not prove the key is set. If a tool call fails with HTTP 401, the key is missing. If the tool returns an error that mentions HTTP 403, the key is not valid.

Do not use `people-search`, `company-search`, or `company-enrich` to check the install: each starts a paid job billed to the user's Desearch balance.

## 5. People Search

`people-search` starts a paid job billed to the user's Desearch balance. It finds people on X, YouTube, LinkedIn, or TikTok who match a plain-language description. It is asynchronous: it reserves `count` people at the platform's per-person price, returns a `task_id` at once, and bills only the people it delivers (a search that finds no one is free). The search usually runs for 1 to 5 minutes. Poll `people-search-status` with the `task_id` and pass `next_cursor` back as `cursor` to get only new people. `people-search-pause`, `people-search-resume`, and `people-search-cancel` pause, resume, or cancel a search. `people-search-tasks` and `people-profiles` list past searches and everyone they found, and `people-search-export` returns them as CSV or JSON Lines text (cut to `max_rows` rows, default 100). All of those are free.

Example prompt: "find 10 TikTok skincare creators with a public email". The agent calls `people-search` with `{"platform": "tiktok", "query": "Skincare creators who review skincare products", "count": 10, "require_contact": true}`, then `people-search-status` with the returned `task_id` until `done` is `true`.

## 6. Company Search

`company-search` finds companies on the web that match a plain-language description, and `company-enrich` reads the 1 to 200 domains you send. Each starts a paid job billed to the user's Desearch balance: it reserves `count` companies (Company Enrich: one per domain sent) at the route's per-company price, returns a `task_id` at once, and bills only the companies it delivers (a task that delivers none is free). Each company comes with its public emails, phones, and social profiles, and its leaders (CEO, founders, CTO, and CFO by default) with their LinkedIn profiles and emails (found on its pages or inferred from its address pattern, and each checked); every contact keeps the page it came from. Poll `company-search-status` with the `task_id`. Companies arrive with `enrichment` status `partial` and later stages fill them in: pass `next_cursor` back as `cursor` to get only new companies, and read again without `cursor` to get the latest version of the ones you have. `company-search-pause`, `company-search-resume`, and `company-search-cancel` pause, resume, or cancel a task, and `company-search-tasks` lists past tasks. All of those are free.

Example prompt: "find 25 Series A fintech startups in Berlin with a leader's email". The agent calls `company-search` with `{"query": "Series A fintech startups in Berlin building payment infrastructure", "count": 25, "countries": ["DE"], "require": ["leader_email"]}`, then `company-search-status` with the returned `task_id` until `done` is `true`.

More details: [README.md](README.md).
