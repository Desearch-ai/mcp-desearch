import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDesearchMcpServer } from "../build/server.js";

function textOf(result) {
    assert.equal(result.content[0].type, "text");
    return result.content[0].text;
}

async function withFakeClient(fake, fn) {
    const server = createDesearchMcpServer("ignored-when-client-is-injected", fake);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "tools", version: "0.0.1" });
    try {
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
        await fn(client);
    } finally {
        await client.close();
        await server.close();
    }
}

test("tools call the desearch-js 1.5 methods with the existing ai/x payloads", async () => {
    const calls = [];
    const fake = {
        async aiSearch(payload) {
            calls.push(["aiSearch", payload]);
            return { completion: "summary" };
        },
        async xSearch(payload) {
            calls.push(["xSearch", payload]);
            return [{ id: "1", text: "tweet" }];
        },
        async webSearch(payload) {
            calls.push(["webSearch", payload]);
            if (payload.query === "fail") {
                throw new Error("HTTP 401: bad key");
            }
            return { data: [{ title: "Docs", link: "https://desearch.ai", snippet: "sdk" }] };
        },
        async aiWebLinksSearch(payload) {
            calls.push(["aiWebLinksSearch", payload]);
            return { search_results: [{ title: "Docs", link: "https://desearch.ai", snippet: "sdk" }] };
        },
    };

    await withFakeClient(fake, async (client) => {
        const ai = await client.callTool({
            name: "ai-search",
            arguments: { prompt: "latest AI news" },
        });
        assert.equal(ai.isError, undefined);
        assert.equal(JSON.parse(textOf(ai)).completion, "summary");

        const x = await client.callTool({
            name: "x-search",
            arguments: { query: "from:elonmusk" },
        });
        assert.equal(JSON.parse(textOf(x))[0].id, "1");

        const web = await client.callTool({
            name: "web-search",
            arguments: { query: "desearch sdk", start: 10 },
        });
        assert.equal(JSON.parse(textOf(web)).data[0].link, "https://desearch.ai");

        const links = await client.callTool({
            name: "web-links-search",
            arguments: { prompt: "browser automation", tools: ["web", "reddit"], count: 20 },
        });
        assert.equal(JSON.parse(textOf(links)).search_results[0].title, "Docs");

        const failed = await client.callTool({
            name: "web-search",
            arguments: { query: "fail" },
        });
        assert.equal(failed.isError, true);
        assert.match(textOf(failed), /^Web Search error: HTTP 401: bad key$/);

        const rejected = await client.callTool({
            name: "web-links-search",
            arguments: { prompt: "too few", tools: ["web"], count: 5 },
        });
        assert.equal(rejected.isError, true);
    });

    assert.deepEqual(calls, [
        [
            "aiSearch",
            {
                prompt: "latest AI news",
                tools: ["Twitter Search", "Web Search"],
                date_filter: undefined,
                start_date: undefined,
                end_date: undefined,
                result_type: undefined,
                include_domains: undefined,
                exclude_domains: undefined,
                model: "NOVA",
                streaming: false,
            },
        ],
        ["xSearch", { query: "from:elonmusk", sort: "Top", count: 20 }],
        ["webSearch", { query: "desearch sdk", start: 10 }],
        [
            "aiWebLinksSearch",
            { prompt: "browser automation", tools: ["web", "reddit"], count: 20 },
        ],
        ["webSearch", { query: "fail", start: undefined }],
    ]);
});
