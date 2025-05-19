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

## Configuration ⚙️

### 1. Configure Cursor IDE to run the Desearch MCP server

Open Cursor IDE, access command palette `Cmd+Shift+P` or `Ctrl+Shift+P`, and search for `Open MCP Settings`. Click on `Add new global MCP server` to open the `mcp.json` file.

### 2. Add the Desearch server configuration:

```json
{
    "mcpServers": {
        "desearch": {
            "command": "npx",
            "args": ["/path/to/desearch-mcp-server/build/index.js"],
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
            "command": "npx",
            "args": ["/path/to/desearch-mcp-server/build/index.js"],
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

## Using via NPX

If you prefer to run the server directly, you can use npx:

```bash
# Run with all tools enabled by default
npx desearch-mcp-server
```

## Troubleshooting 🔧

### Common Issues

1. **Server Not Found**

    - Check Claude or Cursor Desktop configuration syntax
    - Ensure Node.js is installed

2. **API Key Issues**

    - Confirm your `DESEARCH_API_KEY` is valid
    - Check the `DESEARCH_API_KEY` is correctly set in the Cursor or Claude Desktop config
    - Verify that there are no spaces around the API key

3. **Connection Issues**

    - Restart Claude Desktop or Cursor IDE completely
    - Check Claude Desktop logs:

    ```bash
    # macOS
    tail -n 50 -f ~/Library/Logs/Claude/mcp*.log

    # Windows
    type "%APPDATA%\Claude\logs\mcp*.log"
    ```
