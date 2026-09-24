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
            ["ai-search", "x-search"]
        );
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

        const previousKey = process.env.DESEARCH_API_KEY;
        process.env.DESEARCH_API_KEY = "server-secret";
        try {
            const missing = await mcpPost(server.port, {});
            assert.equal(missing.status, 401);
            const missingBody = await missing.text();
            assert.equal(missingBody.includes("server-secret"), false);
            assert.equal(missingBody.includes("super-secret"), false);
        } finally {
            if (previousKey === undefined) {
                delete process.env.DESEARCH_API_KEY;
            } else {
                process.env.DESEARCH_API_KEY = previousKey;
            }
        }

        const queryKey = await mcpPost(server.port, {}, "/mcp?api_key=super-secret");
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
                    ["ai-search", "x-search"]
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

    const denied = await mcpHandler.fetch(
        new Request("https://example.vercel.app/api/mcp", {
            method: "POST",
            headers: MCP_HEADERS,
            body: JSON.stringify(INIT_BODY),
        })
    );
    assert.equal(denied.status, 401);

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
        ["ai-search", "x-search"]
    );
});
