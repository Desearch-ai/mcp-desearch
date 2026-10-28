import assert from "node:assert/strict";
import test from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDesearchMcpServer } from "../build/server.js";

const API = "https://api.desearch.ai";

// SearchResponse in the production OpenAPI spec.
const SEARCH_RESPONSE = {
    results: [
        {
            url: "https://www.nobelprize.org/prizes/physics/2024/summary/",
            title: "The Nobel Prize in Physics 2024",
            published_date: "2024-10-08",
            highlights: ["The Nobel Prize in Physics 2024 was awarded jointly to John J. Hopfield and Geoffrey Hinton."],
        },
    ],
    cost_usd: 0.004,
    usage_count: 1,
    service: "Search API",
    currency: "USD",
};

function textOf(result) {
    assert.equal(result.content[0].type, "text");
    return result.content[0].text;
}

function installMock() {
    const previous = getGlobalDispatcher();
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    const seen = [];
    const pool = agent.get(API);
    return {
        seen,
        reply(status, body, contentType = "application/json") {
            pool.intercept({ method: () => true, path: () => true }).reply(
                status,
                (opts) => {
                    const raw = opts.body;
                    seen.push({
                        method: opts.method,
                        path: opts.path,
                        body: raw == null ? undefined : JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8")),
                    });
                    return body;
                },
                { headers: { "content-type": contentType } }
            );
        },
        async restore() {
            setGlobalDispatcher(previous);
            await agent.close();
        },
    };
}

async function withServer(fn) {
    const mock = installMock();
    const server = createDesearchMcpServer("test-key");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "search-api", version: "0.0.1" });
    try {
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
        await fn(client, mock);
    } finally {
        await client.close();
        await server.close();
        await mock.restore();
    }
}

test("search-api posts to /search with only the fields the caller set and returns the API body", async () => {
    await withServer(async (client, mock) => {
        mock.reply(200, SEARCH_RESPONSE);
        const plain = await client.callTool({
            name: "search-api",
            arguments: { query: "Who won the 2024 Nobel Prize in Physics?" },
        });
        assert.equal(plain.isError, undefined, textOf(plain));
        assert.deepEqual(JSON.parse(textOf(plain)), SEARCH_RESPONSE);

        mock.reply(200, SEARCH_RESPONSE);
        await client.callTool({
            name: "search-api",
            arguments: {
                query: "bittensor subnets",
                mode: "fast",
                count: 15,
                start_date: "2026-01-01",
                end_date: "2026-09-17",
                highlights: false,
                page_text: true,
            },
        });

        // CrewAI-style nulls are the same as leaving the argument out.
        mock.reply(200, SEARCH_RESPONSE);
        await client.callTool({
            name: "search-api",
            arguments: { query: "desearch", mode: null, count: null, start_date: null, page_text: null },
        });

        assert.deepEqual(
            mock.seen.map((call) => [call.method, call.path, call.body]),
            [
                ["POST", "/search", { query: "Who won the 2024 Nobel Prize in Physics?" }],
                [
                    "POST",
                    "/search",
                    {
                        query: "bittensor subnets",
                        mode: "fast",
                        count: 15,
                        start_date: "2026-01-01",
                        end_date: "2026-09-17",
                        highlights: false,
                        page_text: true,
                    },
                ],
                ["POST", "/search", { query: "desearch" }],
            ]
        );
    });
});

test("search-api rejects out-of-range input before the request", async () => {
    await withServer(async (client, mock) => {
        for (const args of [
            {},
            { query: "" },
            { query: "x".repeat(2001) },
            { query: "desearch", count: 12 },
            { query: "desearch", count: 5 },
            { query: "desearch", count: 25 },
            { query: "desearch", mode: "slow" },
            { query: "desearch", start_date: "01/02/2026" },
            { query: "desearch", end_date: "2026-1-2" },
        ]) {
            const rejected = await client.callTool({ name: "search-api", arguments: args });
            assert.equal(rejected.isError, true, JSON.stringify(args).slice(0, 80));
            assert.match(textOf(rejected), /Input validation error/, JSON.stringify(args).slice(0, 80));
        }
        assert.equal(mock.seen.length, 0);
    });
});

test("search-api maps API errors to a tool error with the status and detail", async () => {
    await withServer(async (client, mock) => {
        mock.reply(503, { detail: "Search is temporarily unavailable." });
        const down = await client.callTool({ name: "search-api", arguments: { query: "desearch" } });
        assert.equal(down.isError, true);
        assert.equal(textOf(down), "Search API error: HTTP 503: Search is temporarily unavailable.");

        mock.reply(402, { detail: "Insufficient balance" });
        const broke = await client.callTool({ name: "search-api", arguments: { query: "desearch" } });
        assert.equal(textOf(broke), "Search API error: HTTP 402: Insufficient balance");
    });
});
