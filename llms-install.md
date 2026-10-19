# Installing the Desearch MCP server

These steps are for an AI agent (for example Cline) installing the Desearch MCP server for a user.

## 1. Get an API key

Ask the user for their Desearch API key. If they do not have one, they can create it at https://console.desearch.ai/api-keys. Never write the key into a file that is committed to a repository.

## 2. Option A: hosted server (recommended, no local install)

The hosted Streamable HTTP endpoint is `https://mcp.desearch.ai/mcp`. Send the key in the `x-api-key` header (`Authorization: Bearer <key>` is also accepted). A client that supports OAuth can sign in instead: the server asks for the same Desearch API key on its own page.

```json
{
  "mcpServers": {
    "desearch": {
      "url": "https://mcp.desearch.ai/mcp",
      "headers": {
        "x-api-key": "YOUR_DESEARCH_API_KEY"
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
      "args": ["-y", "desearch-mcp-server"],
      "env": {
        "DESEARCH_API_KEY": "YOUR_DESEARCH_API_KEY"
      }
    }
  }
}
```

## 4. Check the install

The server exposes 20 tools: `ai-search`, `x-search`, `web-search`, `web-links-search`, `extract`, `web-crawl`, `x-links-search`, `x-posts-by-urls`, `x-post-by-id`, `x-posts-by-user`, `x-post-retweeters`, `x-user-posts`, `x-user-replies`, `x-post-replies`, `x-trends`, `people-search`, `people-search-status`, `people-search-control`, `people-search-tasks`, `people-profiles`.

Run one `web-search` call (for example `{"query": "desearch"}`) and confirm it returns results. Listing tools works without a key, so a successful connection alone does not prove the key is set. If a tool call fails with HTTP 401, the key is missing. If the tool returns an error that mentions HTTP 403, the key is not valid.

Do not use `people-search` to check the install: it starts a billed search.

## 5. People Search

`people-search` finds people on X, YouTube, LinkedIn, or TikTok who match a plain-language description. It is billed and asynchronous: it reserves `count` people at the platform's per-person price, returns a `task_id` at once, and bills only the people it delivers (a search that finds no one is free). The search usually runs for 1 to 5 minutes. Poll `people-search-status` with the `task_id` and pass `next_cursor` back as `cursor` to get only new people. `people-search-control` pauses, resumes, or cancels a search. `people-search-tasks` and `people-profiles` list past searches and everyone they found. All of those are free.

Example prompt: "find 10 TikTok skincare creators with a public email". The agent calls `people-search` with `{"platform": "tiktok", "query": "Skincare creators who review skincare products", "count": 10, "require_contact": true}`, then `people-search-status` with the returned `task_id` until `done` is `true`.

More details: [README.md](README.md).
