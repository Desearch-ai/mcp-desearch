import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import healthHandler from "../api/health.js";
import mcpHandler, { POST as vercelMcpPost } from "../api/mcp.js";
import { startHttpServer } from "../build/http.js";

const INIT_BODY = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "smoke", version: "0.0.1" },
    },
};

const MCP_HEADERS = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
};

const TOOL_NAMES = [
    "ai-search",
    "extract",
    "web-crawl",
    "web-links-search",
    "web-search",
    "x-links-search",
    "x-post-by-id",
    "x-post-replies",
    "x-post-retweeters",
    "x-posts-by-urls",
    "x-posts-by-user",
    "x-search",
    "x-trends",
    "x-user-posts",
    "x-user-replies",
];

const TOOL_TITLES = {
    "ai-search": "AI Search",
    "x-search": "X Search",
    "web-search": "Web Search",
    "web-links-search": "Web Links Search",
    "x-links-search": "X Links Search",
    "x-posts-by-urls": "Get X Posts by URLs",
    "x-post-by-id": "Get X Post by ID",
    "x-posts-by-user": "Search X Posts by User",
    "x-post-retweeters": "List X Post Retweeters",
    "x-user-posts": "Get X User Timeline",
    "x-user-replies": "Get X User Replies",
    "x-post-replies": "Get X Post Replies",
    extract: "Extract Page Content",
    "web-crawl": "Crawl Web Page (Legacy)",
    "x-trends": "Get X Trends",
};

const UNSOURCED_SPEED = /real-?time|nova is|orbit is|\b10s\b|\b30s\b/i;

function assertToolMetadata(tools) {
    assert.equal(tools.length, 15);
    for (const tool of tools) {
        assert.equal(tool.title, TOOL_TITLES[tool.name], tool.name);
        assert.equal(tool.annotations?.title, TOOL_TITLES[tool.name], tool.name);
        assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
        assert.equal(tool.annotations?.destructiveHint, false, tool.name);
        assert.equal(tool.annotations?.openWorldHint, true, tool.name);
        const blob = JSON.stringify(tool);
        const hit = blob.match(UNSOURCED_SPEED);
        assert.equal(hit, null, `${tool.name} still has an unsourced speed claim: ${hit?.[0]}`);
    }
}

function mcpPost(port, headers, path = "/mcp") {
    return fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { ...MCP_HEADERS, ...headers },
        body: JSON.stringify(INIT_BODY),
    });
}

async function withClient(transport, fn) {
    const client = new Client({ name: "smoke", version: "0.0.1" });
    try {
        await client.connect(transport);
        await fn(client);
    } finally {
        await client.close();
    }
}

test("stdio initializes and lists tools", async () => {
    const transport = new StdioClientTransport({
        command: "node",
        args: ["build/index.js"],
        env: {
            ...getDefaultEnvironment(),
            DESEARCH_API_KEY: "test-key",
        },
        stderr: "pipe",
    });
    transport.stderr?.on("data", () => {});

    await withClient(transport, async (client) => {
        assert.equal(client.getServerVersion()?.name, "Desearch");
        const listed = await client.listTools();
        assert.deepEqual(
            listed.tools.map((tool) => tool.name).sort(),
            TOOL_NAMES
        );
        assertToolMetadata(listed.tools);
        const aiSearch = listed.tools.find((tool) => tool.name === "ai-search");
        assert.deepEqual(aiSearch.inputSchema.properties.tools.items.enum, ["web", "twitter"]);
        assert.equal(
            JSON.stringify(aiSearch.inputSchema).toLowerCase().includes("youtube"),
            false
        );
        assert.deepEqual(aiSearch.inputSchema.properties.tools.default, ["web", "twitter"]);
        const webSearch = listed.tools.find((tool) => tool.name === "web-search");
        assert.deepEqual(webSearch.inputSchema.required, ["query"]);
        assert.equal(typeof webSearch.inputSchema.properties.start, "object");
        const webLinks = listed.tools.find((tool) => tool.name === "web-links-search");
        assert.deepEqual(webLinks.inputSchema.required, ["prompt"]);
        assert.deepEqual(webLinks.inputSchema.properties.tools.items.enum, ["web"]);
        assert.deepEqual(webLinks.inputSchema.properties.tools.default, ["web"]);

        const xSearch = listed.tools.find((tool) => tool.name === "x-search");
        assert.deepEqual(xSearch.inputSchema.required, ["query"]);
        assert.equal(xSearch.inputSchema.properties.count.default, 20);
        assert.equal(xSearch.inputSchema.properties.sort, undefined);
        for (const name of [
            "user",
            "start_date",
            "end_date",
            "lang",
            "verified",
            "blue_verified",
            "is_quote",
            "is_video",
            "is_image",
            "min_retweets",
            "min_replies",
            "min_likes",
        ]) {
            assert.equal(typeof xSearch.inputSchema.properties[name], "object", name);
        }

        const requiredByTool = {
            "x-links-search": ["prompt"],
            "x-posts-by-urls": ["urls"],
            "x-post-by-id": ["id"],
            "x-posts-by-user": ["user"],
            "x-post-retweeters": ["id"],
            "x-user-posts": ["username"],
            "x-user-replies": ["user"],
            "x-post-replies": ["post_id"],
            extract: ["url"],
            "web-crawl": ["url"],
            "x-trends": ["woeid"],
        };
        for (const [name, required] of Object.entries(requiredByTool)) {
            const tool = listed.tools.find((entry) => entry.name === name);
            assert.deepEqual(tool.inputSchema.required, required, name);
        }

        for (const name of ["extract", "web-crawl"]) {
            const tool = listed.tools.find((entry) => entry.name === name);
            assert.deepEqual(tool.inputSchema.properties.format.enum, ["html", "text"]);
            assert.equal(typeof tool.inputSchema.properties.js, "object");
            assert.equal(typeof tool.inputSchema.properties.wait, "object");
        }
        const webCrawl = listed.tools.find((entry) => entry.name === "web-crawl");
        assert.match(webCrawl.description, /deprecated/i);
        assert.match(webCrawl.description, /extract/);
        const trends = listed.tools.find((entry) => entry.name === "x-trends");
        assert.equal(typeof trends.inputSchema.properties.count, "object");
        assert.equal(trends.inputSchema.properties.count.minimum, 30);
        assert.equal(trends.inputSchema.properties.count.maximum, 100);
    });
});

test("stdio exits when DESEARCH_API_KEY is missing", async () => {
    const child = spawn("node", ["build/index.js"], {
        env: { ...getDefaultEnvironment() },
    });
    const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error("stdio process did not exit"));
        }, 5000);
        child.on("exit", (exitCode) => {
            clearTimeout(timer);
            resolve(exitCode);
        });
    });
    assert.notEqual(code, 0);
});

test("streamable HTTP initialize and tools/list with Bearer and x-api-key", async () => {
    const server = await startHttpServer({ host: "127.0.0.1", port: 0 });
    try {
        const health = await fetch(`http://127.0.0.1:${server.port}/`);
        assert.equal(health.status, 200);
        const healthBody = await health.json();
        assert.equal(healthBody.ok, true);
        assert.equal(healthBody.endpoint, "/mcp");

        const healthAlias = await fetch(`http://127.0.0.1:${server.port}/health`);
        assert.equal(healthAlias.status, 200);
        const healthSlash = await fetch(`http://127.0.0.1:${server.port}/health/`);
        assert.equal(healthSlash.status, 200);
        const apiHealth = await fetch(`http://127.0.0.1:${server.port}/api/health`);
        assert.equal(apiHealth.status, 200);

        const previousKey = process.env.DESEARCH_API_KEY;
        process.env.DESEARCH_API_KEY = "server-secret";
        try {
            const missing = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
                method: "POST",
                headers: MCP_HEADERS,
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 9,
                    method: "tools/call",
                    params: { name: "web-search", arguments: { query: "should-not-run" } },
                }),
            });
            assert.equal(missing.status, 401);
            assert.equal(missing.headers.get("www-authenticate"), null);
            const missingBody = await missing.text();
            assert.equal(missingBody.includes("server-secret"), false);
            assert.equal(missingBody.includes("super-secret"), false);
            assert.match(missingBody, /API key/);
        } finally {
            if (previousKey === undefined) {
                delete process.env.DESEARCH_API_KEY;
            } else {
                process.env.DESEARCH_API_KEY = previousKey;
            }
        }

        const queryKey = await fetch(`http://127.0.0.1:${server.port}/mcp?api_key=super-secret`, {
            method: "POST",
            headers: MCP_HEADERS,
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 10,
                method: "tools/call",
                params: { name: "web-search", arguments: { query: "should-not-run" } },
            }),
        });
        assert.equal(queryKey.status, 401);
        assert.equal((await queryKey.text()).includes("super-secret"), false);

        const options = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: "OPTIONS" });
        assert.equal(options.status, 204);
        assert.equal(options.headers.get("access-control-allow-origin"), "*");

        const sseProbe = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
            method: "GET",
            headers: { authorization: "Bearer test-key", accept: "text/event-stream" },
        });
        assert.equal(sseProbe.status, 405);

        for (const headers of [
            { authorization: "Bearer test-key" },
            { "x-api-key": "test-key" },
        ]) {
            const transport = new StreamableHTTPClientTransport(
                new URL(`http://127.0.0.1:${server.port}/mcp`),
                { requestInit: { headers } }
            );
            await withClient(transport, async (client) => {
                assert.equal(client.getServerVersion()?.name, "Desearch");
                const listed = await client.listTools();
                assert.deepEqual(
                    listed.tools.map((tool) => tool.name).sort(),
                    TOOL_NAMES
                );
                const aiSearch = listed.tools.find((tool) => tool.name === "ai-search");
                assert.equal(typeof aiSearch?.inputSchema?.properties?.prompt, "object");
            });
        }

        const rawKey = new StreamableHTTPClientTransport(
            new URL(`http://127.0.0.1:${server.port}/mcp`),
            { requestInit: { headers: { authorization: "test-key" } } }
        );
        await withClient(rawKey, async (client) => {
            assert.equal(client.getServerVersion()?.name, "Desearch");
        });

        const direct = await mcpPost(server.port, { authorization: "Bearer test-key" }, "/api/mcp");
        assert.equal(direct.status, 200);
        const initialized = await direct.json();
        assert.equal(initialized.result.serverInfo.name, "Desearch");
        assert.ok(initialized.result.protocolVersion);
    } finally {
        await server.close();
    }
});

test("keyless discovery lists tools and tools/call stays unauthorized", async () => {
    const server = await startHttpServer({ host: "127.0.0.1", port: 0 });
    try {
        const endpoint = `http://127.0.0.1:${server.port}/mcp`;
        const post = (body) =>
            fetch(endpoint, {
                method: "POST",
                headers: MCP_HEADERS,
                body: JSON.stringify(body),
            });

        const initialized = await post(INIT_BODY);
        assert.equal(initialized.status, 200);
        assert.equal(initialized.headers.get("www-authenticate"), null);
        const initBody = await initialized.json();
        assert.equal(initBody.result.serverInfo.name, "Desearch");

        const notified = await post({
            jsonrpc: "2.0",
            method: "notifications/initialized",
        });
        assert.notEqual(notified.status, 401);
        assert.ok(notified.status === 200 || notified.status === 202);

        const ping = await post({ jsonrpc: "2.0", id: 4, method: "ping" });
        assert.equal(ping.status, 200);

        const prompts = await post({ jsonrpc: "2.0", id: 5, method: "prompts/list" });
        assert.equal(prompts.status, 200);
        assert.deepEqual((await prompts.json()).result.prompts, []);

        const resources = await post({ jsonrpc: "2.0", id: 6, method: "resources/list" });
        assert.equal(resources.status, 200);
        assert.deepEqual((await resources.json()).result.resources, []);

        const templates = await post({ jsonrpc: "2.0", id: 7, method: "resources/templates/list" });
        assert.equal(templates.status, 200);
        assert.deepEqual((await templates.json()).result.resourceTemplates, []);

        const tools = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        assert.equal(tools.status, 200);
        const toolsBody = await tools.json();
        assert.deepEqual(
            toolsBody.result.tools.map((tool) => tool.name).sort(),
            TOOL_NAMES
        );
        assertToolMetadata(toolsBody.result.tools);

        const transport = new StreamableHTTPClientTransport(new URL(endpoint));
        await withClient(transport, async (client) => {
            assert.equal(client.getServerVersion()?.name, "Desearch");
            const listed = await client.listTools();
            assertToolMetadata(listed.tools);
        });

        const called = await post({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "web-search", arguments: { query: "should-not-run" } },
        });
        assert.equal(called.status, 401);
        assert.equal(called.headers.get("www-authenticate"), null);
        const calledBody = await called.json();
        assert.equal(calledBody.error.code, -32001);
        assert.match(calledBody.error.message, /Desearch API key/);

        const mixed = await post([
            { jsonrpc: "2.0", id: 1, method: "tools/list" },
            {
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: { name: "ai-search", arguments: { prompt: "should-not-run" } },
            },
        ]);
        assert.equal(mixed.status, 401);
        assert.equal((await mixed.json()).error.code, -32001);

        const rawGarbage = await fetch(endpoint, {
            method: "POST",
            headers: MCP_HEADERS,
            body: "{",
        });
        assert.equal(rawGarbage.status, 401);

        const unknown = await post({ jsonrpc: "2.0", id: 8, method: "resources/read" });
        assert.equal(unknown.status, 401);
    } finally {
        await server.close();
    }
});

test("CLI --http serves /mcp without a server-side API key", async () => {
    const child = spawn("node", ["build/index.js", "--http"], {
        env: {
            ...getDefaultEnvironment(),
            HOST: "127.0.0.1",
            PORT: "0",
        },
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
    });

    try {
        const port = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`HTTP CLI did not listen. stderr: ${stderr}`));
            }, 8000);
            child.on("exit", (code) => {
                clearTimeout(timer);
                reject(new Error(`HTTP CLI exited ${code}. stderr: ${stderr}`));
            });
            child.stderr.on("data", () => {
                const match = stderr.match(/listening on 127\.0\.0\.1:(\d+)/);
                if (match) {
                    clearTimeout(timer);
                    resolve(Number(match[1]));
                }
            });
        });

        const response = await mcpPost(port, { authorization: "Bearer test-key" });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.result.serverInfo.name, "Desearch");
    } finally {
        child.kill();
        if (child.exitCode === null) {
            await new Promise((resolve) => child.on("exit", resolve));
        }
    }
});

test("Vercel function entries initialize over the rewritten paths", async () => {
    const health = await healthHandler.fetch(new Request("https://example.vercel.app/api/health"));
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.endpoint, "/mcp");

    const discovered = await mcpHandler.fetch(
        new Request("https://example.vercel.app/api/mcp", {
            method: "POST",
            headers: MCP_HEADERS,
            body: JSON.stringify(INIT_BODY),
        })
    );
    assert.equal(discovered.status, 200);
    assert.equal((await discovered.json()).result.serverInfo.name, "Desearch");

    const denied = await mcpHandler.fetch(
        new Request("https://example.vercel.app/api/mcp", {
            method: "POST",
            headers: MCP_HEADERS,
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 3,
                method: "tools/call",
                params: { name: "web-search", arguments: { query: "should-not-run" } },
            }),
        })
    );
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get("www-authenticate"), null);

    const initialized = await mcpHandler.fetch(
        new Request("https://example.vercel.app/api/mcp", {
            method: "POST",
            headers: { ...MCP_HEADERS, authorization: "Bearer test-key" },
            body: JSON.stringify(INIT_BODY),
        })
    );
    assert.equal(initialized.status, 200);
    const body = await initialized.json();
    assert.equal(body.result.serverInfo.name, "Desearch");
    assert.ok(body.result.protocolVersion);

    const listed = await vercelMcpPost(
        new Request("https://mcp.desearch.ai/mcp", {
            method: "POST",
            headers: {
                ...MCP_HEADERS,
                "x-api-key": "test-key",
                "mcp-protocol-version": body.result.protocolVersion,
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
        })
    );
    assert.equal(listed.status, 200);
    const tools = await listed.json();
    assert.deepEqual(
        tools.result.tools.map((tool) => tool.name).sort(),
        TOOL_NAMES
    );
});
