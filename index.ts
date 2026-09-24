#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startHttpServer } from "./http.js";
import { createDesearchMcpServer } from "./server.js";

function wantsHttp(): boolean {
    return process.argv.includes("--http") || process.env.MCP_TRANSPORT === "http";
}

async function main(): Promise<void> {
    if (wantsHttp()) {
        const port = Number(process.env.PORT ?? "3000");
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
            throw new Error("PORT must be an integer between 0 and 65535");
        }
        const host = process.env.HOST ?? "0.0.0.0";
        await startHttpServer({ port, host });
        return;
    }

    const apiKey = process.env.DESEARCH_API_KEY;
    if (!apiKey) {
        throw new Error("DESEARCH_API_KEY environment variable is required");
    }

    const server = createDesearchMcpServer(apiKey);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Desearch server is running...");
}

main().catch((error: unknown) => {
    console.error(`Server error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});
