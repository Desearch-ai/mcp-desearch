# Installing the Desearch MCP server

These steps are for an AI agent (for example Cline) installing the Desearch MCP server for a user.

## 1. Get an API key

Ask the user for their Desearch API key. If they do not have one, they can create it at https://console.desearch.ai/api-keys. Never write the key into a file that is committed to a repository.

## 2. Option A: hosted server (recommended, no local install)

The hosted Streamable HTTP endpoint is `https://mcp.desearch.ai/mcp`. Send the key in the `x-api-key` header (`Authorization: Bearer <key>` is also accepted).

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

The server exposes 15 tools: `ai-search`, `x-search`, `web-search`, `web-links-search`, `extract`, `web-crawl`, `x-links-search`, `x-posts-by-urls`, `x-post-by-id`, `x-posts-by-user`, `x-post-retweeters`, `x-user-posts`, `x-user-replies`, `x-post-replies`, `x-trends`.

Run one `web-search` call (for example `{"query": "desearch"}`) and confirm it returns results. Listing tools works without a key, so a successful connection alone does not prove the key is set. If a tool call fails with HTTP 401, the key is missing. If the tool returns an error that mentions HTTP 403, the key is not valid.

More details: [README.md](README.md).
