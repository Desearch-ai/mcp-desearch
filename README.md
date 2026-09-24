# Desearch MCP Server

[![npm version](https://badge.fury.io/js/desearch-mcp-server.svg)](https://www.npmjs.com/package/desearch-mcp-server)

A Model Context Protocol (MCP) server lets clients like Claude or Cursor use the Desearch AI for real-time AI X search and web search.

## Tools

The Desearch MCP server includes the following tools:

-   **AI Search**: Performs real-time AI Twitter and web searches with relevant links and summary.
-   **X Search**: Real-time tweet search on X.

## Prerequisites 📋

-   An [Desearch API Key](https://console.desearch.ai/api-keys)
-   [Node.js](https://nodejs.org/) (v18 or higher)
-   [Claude Desktop](https://claude.ai/download) installed
-   [Cursor IDE](https://www.cursor.com/)

## Installation 🛠️

### NPM Installation

```bash
npm install -g desearch-mcp-server
```

### Using Smithery

To install the Desearch MCP server for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@Desearch-ai/desearch):

```bash
npx -y @smithery/cli install @Desearch-ai/desearch --client claude
```

Or for Cursor IDE:

```bash
npx -y @smithery/cli install @Desearch-ai/desearch --client cursor
```

## Configuration ⚙️

### 1. Configure Cursor IDE to run the Desearch MCP server

Open Cursor IDE, access command palette `Cmd+Shift+P` or `Ctrl+Shift+P`, and search for `Open MCP Settings`. Click on `Add new global MCP server` to open the `mcp.json` file.

### 2. Add the Desearch server configuration:

```json
{
    "mcpServers": {
        "desearch": {
            "command": "desearch-mcp-server",
            "env": {
                "DESEARCH_API_KEY": "your-api-key"
            }
        }
    }
}
```

Replace `your-api-key` with your actual Desearch API key from [console.desearch.ai/api-keys](https://console.desearch.ai/api-keys).

### 3. Restart Cursor IDE

For the changes to take effect:

1. Completely quit Cursor IDE
2. Start Cursor IDE again

### 1. Configure Claude Desktop to run the Desearch MCP server

Open the Claude Desktop app and enable Developer Mode from the top-left menu bar.

Once enabled, open Settings (also from the top-left menu bar) and navigate to the Developer Option, where you'll find the Edit Config button. Clicking it will open the `claude_desktop_config.json` file, allowing you to make the necessary edits.

OR (if you want to open `claude_desktop_config.json` from terminal)

#### For macOS:

1. Open your Claude Desktop config:

```bash
code ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

#### For Windows:

1. Open your Claude Desktop configuration:

```powershell
code %APPDATA%\Claude\claude_desktop_config.json
```

### 2. Add the Desearch server configuration:

```json
{
    "mcpServers": {
        "desearch": {
            "command": "desearch-mcp-server",
            "env": {
                "DESEARCH_API_KEY": "your-api-key"
            }
        }
    }
}
```

Replace `your-api-key` with your actual Desearch API key from [console.desearch.ai/api-keys](https://console.desearch.ai/api-keys).

### 3. Restart Claude Desktop

For the changes to take effect:

1. Completely quit Claude Desktop
2. Start Claude Desktop again
3. You can verify the server by checking status in Settings > Developer > desearch

## Remote Streamable HTTP

The same server can run over MCP Streamable HTTP for a remote client. Local stdio (`desearch-mcp-server`, Smithery) is unchanged and still reads `DESEARCH_API_KEY` from the environment.

Remote requests do not use that environment variable. Each request must carry the caller's own Desearch API key, the same key from [console.desearch.ai/api-keys](https://console.desearch.ai/api-keys):

- `Authorization: Bearer <DESEARCH_API_KEY>` (preferred)
- `x-api-key: <DESEARCH_API_KEY>`

A bare `Authorization: <DESEARCH_API_KEY>` value is also accepted. The key is not read from the query string. There is no shared server secret: the hosted process forwards the per-request key to the Desearch API.

The MCP endpoint is `POST /mcp`. Responses are JSON (stateless Streamable HTTP). `GET` and `DELETE` on `/mcp` return `405` because the server does not keep a session or push server-to-client messages. `GET /` and `GET /health` are unauthenticated health checks.

### Run locally

```bash
npm install
npm run build
npm run start:http
```

This listens on `0.0.0.0:3000` (`PORT` and `HOST` override that). `MCP_TRANSPORT=http` is the same as `--http`.

```bash
curl -sS http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer your-api-key' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.1"}}}'
```

Cursor (or any remote MCP client):

```json
{
    "mcpServers": {
        "desearch": {
            "url": "http://127.0.0.1:3000/mcp",
            "headers": {
                "Authorization": "Bearer your-api-key"
            }
        }
    }
}
```

Docker serves the same HTTP entrypoint (`EXPOSE 3000`). Smithery still starts stdio and injects `DESEARCH_API_KEY` itself.

```bash
docker build -t desearch-mcp .
docker run --rm -p 3000:3000 desearch-mcp
```

### Deploy on Vercel

Vercel fits this server because the handler is stateless and answers each JSON-RPC call in one response. `vercel.json` builds the project, serves `POST /mcp`, and allows tool calls up to 60 seconds (Orbit searches run about 30 seconds). Hobby plans cap function duration lower than that, so AI Search tool calls need a plan that allows at least 60 seconds. `initialize` and `tools/list` are short either way.

No server-side Desearch API key is required in the Vercel project. After deploy, the endpoint is:

`https://<project>.vercel.app/mcp`

Pointing DNS for `mcp.desearch.ai` at that deployment is a later step. This repo does not create DNS records. Once that name exists, clients use `https://mcp.desearch.ai/mcp` with the same `Authorization` header.

The same `node build/index.js --http` process is the fallback if you would rather run a long-lived Node host or the Docker image instead of Vercel.

## Troubleshooting 🔧

### Common Issues

1. **Server Not Found**

    - Check Claude or Cursor Desktop configuration syntax
    - Ensure Node.js is installed

2. **API Key Issues**

    - Confirm your `DESEARCH_API_KEY` is valid
    - Check the `DESEARCH_API_KEY` is correctly set in the Cursor or Claude Desktop config
    - Verify that there are no spaces around the API key
    - For the remote HTTP server, send `Authorization: Bearer <key>` or `x-api-key`. A hosted `DESEARCH_API_KEY` environment variable is not used for those requests.

3. **Connection Issues**

    - Restart Claude Desktop or Cursor IDE completely
    - Check Claude Desktop logs:

    ```bash
    # macOS
    tail -n 50 -f ~/Library/Logs/Claude/mcp*.log

    # Windows
    type "%APPDATA%\Claude\logs\mcp*.log"
    ```
