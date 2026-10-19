import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDesearchMcpServer } from "../build/server.js";

function recordingFake(calls) {
    const handler = (method) => async (payload) => {
        calls.push([method, payload]);
        if (method === "aiWebLinksSearch") {
            return { search_results: [] };
        }
        if (method === "webSearch") {
            return { data: [] };
        }
        return [];
    };
    return new Proxy({}, { get: (_t, prop) => handler(String(prop)) });
}

async function withServer(calls, fn) {
    const server = createDesearchMcpServer("test-key", recordingFake(calls));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "null-optional", version: "0.0.1" });
    try {
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
        await fn(client);
    } finally {
        await client.close();
        await server.close();
    }
}

function isValidationError(result) {
    return result.isError === true && /Expected|Invalid|-32602/i.test(result.content?.[0]?.text ?? "");
}

test("web-search: optional start=null behaves exactly like omitted start", async () => {
    const calls = [];
    await withServer(calls, async (client) => {
        const omitted = await client.callTool({ name: "web-search", arguments: { query: "desearch" } });
        const nulled = await client.callTool({ name: "web-search", arguments: { query: "desearch", start: null } });
        assert.notEqual(omitted.isError, true);
        assert.notEqual(nulled.isError, true);
        assert.deepEqual(nulled.content, omitted.content);
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], calls[0]);
});

test("web-search: required query=null is still rejected", async () => {
    const calls = [];
    await withServer(calls, async (client) => {
        let result;
        try {
            result = await client.callTool({ name: "web-search", arguments: { query: null } });
        } catch (error) {
            assert.match(String(error), /query|Expected|-32602/i);
            return;
        }
        assert.ok(isValidationError(result), JSON.stringify(result));
    });
    assert.equal(calls.length, 0);
});

test("CrewAI MCPServerAdapter style: every unset optional sent as null is accepted on every tool", async () => {
    const calls = [];
    await withServer(calls, async (client) => {
        const { tools } = await client.listTools();
        assert.ok(tools.length > 0);
        for (const tool of tools) {
            const schema = tool.inputSchema;
            const required = new Set(schema.required ?? []);
            const omittedArgs = {};
            const nulledArgs = {};
            for (const [key, prop] of Object.entries(schema.properties ?? {})) {
                if (required.has(key)) {
                    const sample = sampleFor(key, prop);
                    omittedArgs[key] = sample;
                    nulledArgs[key] = sample;
                } else {
                    nulledArgs[key] = null;
                }
            }
            const before = calls.length;
            const a = await client.callTool({ name: tool.name, arguments: omittedArgs });
            const b = await client.callTool({ name: tool.name, arguments: nulledArgs });
            assert.ok(!isValidationError(a), `${tool.name} omitted: ${JSON.stringify(a)}`);
            assert.ok(!isValidationError(b), `${tool.name} all-null optionals: ${JSON.stringify(b)}`);
            const made = calls.slice(before);
            if (made.length === 2) {
                assert.deepEqual(made[1], made[0], `${tool.name}: null optionals changed the upstream payload`);
            }
        }
    });
});

function sampleFor(key, prop) {
    if (prop.enum) return prop.enum[0];
    if (prop.type === "integer" || prop.type === "number") return prop.minimum ?? 1;
    if (prop.type === "boolean") return true;
    if (prop.type === "array") return [sampleFor(key, prop.items ?? { type: "string" })];
    if (/url/i.test(key)) return "https://desearch.ai";
    return "desearch";
}
