import assert from "node:assert/strict";
import test from "node:test";
import mcpHandler from "../api/mcp.js";
import { MCP_DOCS_URL } from "../build/http.js";

const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const url = "https://mcp.desearch.ai/mcp";
const call = (init) => mcpHandler.fetch(new Request(url, init));

test("keyless browser GET and HEAD of /mcp redirect to the MCP docs page", async () => {
    assert.equal(MCP_DOCS_URL, "https://www.desearch.ai/docs/guide/sdk/mcp");
    for (const [method, accept] of [["GET", BROWSER_ACCEPT], ["GET", "text/html"], ["HEAD", BROWSER_ACCEPT]]) {
        const response = await call({ method, headers: { accept } });
        assert.equal(response.status, 301, `${method} ${accept}`);
        assert.equal(response.headers.get("location"), MCP_DOCS_URL);
        assert.equal(response.headers.get("vary"), "Accept");
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(response.headers.get("www-authenticate"), null);
    }
    const slash = await mcpHandler.fetch(new Request(`${url}/`, { headers: { accept: BROWSER_ACCEPT } }));
    assert.equal(slash.status, 301);
});

test("MCP clients without a key keep the 401 challenge", async () => {
    const cases = [
        { method: "GET", headers: { accept: "text/event-stream" } },
        { method: "GET", headers: { accept: "text/html, text/event-stream" } },
        { method: "GET", headers: { accept: "application/json, text/event-stream" } },
        { method: "GET", headers: { accept: "*/*" } },
        { method: "GET", headers: {} },
        { method: "GET", headers: { accept: "text/html", "mcp-protocol-version": "2025-06-18" } },
        { method: "GET", headers: { accept: "text/html", "mcp-session-id": "abc" } },
        { method: "DELETE", headers: { accept: "text/html" } },
        {
            method: "POST",
            headers: { accept: "text/html, application/json, text/event-stream", "content-type": "application/json" },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: "web-search", arguments: { query: "x" } },
            }),
        },
    ];
    for (const init of cases) {
        const response = await call(init);
        assert.equal(response.status, 401, JSON.stringify(init.headers) + init.method);
        assert.match(response.headers.get("www-authenticate") ?? "", /^Bearer /);
        assert.equal(response.headers.get("location"), null);
        assert.match(await response.text(), /Unauthorized\. Send your Desearch API key/);
    }
});

test("browser GET with a key or a bad token is not redirected", async () => {
    const keyed = await call({ headers: { accept: BROWSER_ACCEPT, authorization: "Bearer test-key" } });
    assert.equal(keyed.status, 405);
    const bad = await call({ headers: { accept: BROWSER_ACCEPT, authorization: "Bearer dsoat_not-a-real-token" } });
    assert.notEqual(bad.status, 301);
});

test("POST with a key is not affected", async () => {
    const response = await call({
        method: "POST",
        headers: { accept: "application/json, text/event-stream", "content-type": "application/json", "x-api-key": "test-key" },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
        }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.serverInfo.name, "Desearch");
});
