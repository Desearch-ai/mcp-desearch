import assert from "node:assert/strict";
import test from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDesearchMcpServer } from "../build/server.js";
import { recordCost, recordCostHeaders, withCostMeter } from "../build/cost-meta.js";

// Every billed tool result carries the API's X-Desearch-Cost-Usd / X-Desearch-Usage-Count
// headers in `_meta` as { cost_usd, usage_count }, whatever the body shape. These tests use the
// real desearch-js client and the direct API caller against a mocked api.desearch.ai.

const API = "https://api.desearch.ai";
const JSON_TYPE = { "content-type": "application/json" };

function costHeaders(costUsd, usageCount) {
    return { "x-desearch-cost-usd": String(costUsd), "x-desearch-usage-count": String(usageCount) };
}

function installMock() {
    const previous = getGlobalDispatcher();
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    const pool = agent.get(API);
    const seen = [];
    return {
        seen,
        /** Reply once to the next request on `path` (pathname, query ignored). */
        reply(path, status, body, headers = {}, delayMs = 0) {
            const interceptor = pool
                .intercept({ method: () => true, path: (p) => new URL(p, API).pathname === path })
                .reply(
                    status,
                    (opts) => {
                        seen.push({ method: opts.method, path: opts.path });
                        return typeof body === "string" ? body : JSON.stringify(body);
                    },
                    { headers: { ...JSON_TYPE, ...headers } }
                );
            if (delayMs) {
                interceptor.delay(delayMs);
            }
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
    const client = new Client({ name: "cost-meta", version: "0.0.1" });
    try {
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
        await fn(client, mock);
    } finally {
        await client.close();
        await server.close();
        await mock.restore();
    }
}

const POST = { id: "1", text: "hello", created_at: "2026-11-12T10:00:00Z" };

test("bare-list X bodies (x-search, x-posts-by-user) carry cost_usd and usage_count in _meta", async () => {
    await withServer(async (client, mock) => {
        mock.reply("/twitter", 200, [POST], costHeaders("0.0014999999999999998", 10));
        const search = await client.callTool({ name: "x-search", arguments: { query: "tidepools", count: 10 } });
        assert.equal(search.isError, undefined);
        assert.deepEqual(search._meta, { cost_usd: 0.0015, usage_count: 10 });
        assert.deepEqual(JSON.parse(search.content[0].text), [POST], "content is the body, unchanged");
        assert.equal(search.structuredContent, undefined);

        mock.reply("/twitter/post/user", 200, [POST, { ...POST, id: "2" }], costHeaders("0.0045", 30));
        const byUser = await client.callTool({
            name: "x-posts-by-user",
            arguments: { user: "rauchg", count: 30 },
        });
        assert.deepEqual(byUser._meta, { cost_usd: 0.0045, usage_count: 30 });
        assert.equal(JSON.parse(byUser.content[0].text).length, 2);
    });
});

test("extract (JSON-encoded text body) and web-crawl (plain text body) carry cost in _meta", async () => {
    await withServer(async (client, mock) => {
        mock.reply("/web/extract", 200, JSON.stringify("Tide pools are rocky..."), costHeaders("0.0005", 1));
        const extract = await client.callTool({
            name: "extract",
            arguments: { url: "https://en.wikipedia.org/wiki/Tide_pool", format: "text" },
        });
        assert.deepEqual(extract._meta, { cost_usd: 0.0005, usage_count: 1 });
        assert.equal(JSON.parse(extract.content[0].text), "Tide pools are rocky...");

        mock.reply("/web/crawl", 200, "<p>legacy</p>", { "content-type": "text/html", ...costHeaders("0.0005", 1) });
        const crawl = await client.callTool({ name: "web-crawl", arguments: { url: "https://desearch.ai" } });
        assert.deepEqual(crawl._meta, { cost_usd: 0.0005, usage_count: 1 });
        assert.equal(JSON.parse(crawl.content[0].text), "<p>legacy</p>");
    });
});

test("JSON-object bodies keep their own cost fields and also get _meta", async () => {
    await withServer(async (client, mock) => {
        const body = { data: [{ title: "Desearch", link: "https://desearch.ai" }], cost_usd: 0.001 };
        mock.reply("/web", 200, body, costHeaders("0.001", 1));
        const result = await client.callTool({ name: "web-search", arguments: { query: "desearch" } });
        assert.deepEqual(result._meta, { cost_usd: 0.001, usage_count: 1 });
        assert.deepEqual(JSON.parse(result.content[0].text), body);
    });
});

test("search and fetch (structuredContent with an output schema) also carry _meta", async () => {
    await withServer(async (client, mock) => {
        mock.reply("/web", 200, { data: [{ title: "Desearch", link: "https://desearch.ai" }] }, costHeaders("0.001", 1));
        const search = await client.callTool({ name: "search", arguments: { query: "desearch" } });
        assert.equal(search.isError, undefined);
        assert.deepEqual(search._meta, { cost_usd: 0.001, usage_count: 1 });
        assert.equal(search.structuredContent.results[0].url, "https://desearch.ai");

        mock.reply("/web/extract", 200, JSON.stringify("page text"), costHeaders("0.0005", 1));
        const fetched = await client.callTool({ name: "fetch", arguments: { id: "https://desearch.ai" } });
        assert.equal(fetched.isError, undefined);
        assert.deepEqual(fetched._meta, { cost_usd: 0.0005, usage_count: 1 });
    });
});

test("direct API tools (social, search-api) carry cost in _meta", async () => {
    await withServer(async (client, mock) => {
        mock.reply("/desearch/tiktok/hashtag/ai", 200, [{ id: "7620891413932166433" }], costHeaders("0.0021", 3));
        const social = await client.callTool({ name: "tiktok", arguments: { action: "hashtag", tag: "ai", count: 3 } });
        assert.equal(social.isError, undefined);
        assert.deepEqual(social._meta, { cost_usd: 0.0021, usage_count: 3 });

        mock.reply("/desearch/tiktok/post/7620891413932166433", 200, { id: "7620891413932166433" }, costHeaders("0.0007", 1));
        const single = await client.callTool({ name: "tiktok", arguments: { action: "post", id: "7620891413932166433" } });
        assert.deepEqual(single._meta, { cost_usd: 0.0007, usage_count: 1 });

        mock.reply("/search", 200, { results: [], cost_usd: 0.002, usage_count: 1 }, costHeaders("0.002", 1));
        const searchApi = await client.callTool({ name: "search-api", arguments: { query: "nobel prize" } });
        assert.deepEqual(searchApi._meta, { cost_usd: 0.002, usage_count: 1 });
    });
});

test("a $0 response reports cost_usd 0; no cost headers means no _meta", async () => {
    await withServer(async (client, mock) => {
        mock.reply("/twitter", 200, [], costHeaders("0", 0));
        const free = await client.callTool({ name: "x-search", arguments: { query: "nothing" } });
        assert.deepEqual(free._meta, { cost_usd: 0, usage_count: 0 });

        mock.reply("/twitter/trends", 200, { trends: [] });
        const unbilled = await client.callTool({ name: "x-trends", arguments: { woeid: 1 } });
        assert.equal(unbilled._meta, undefined);
    });
});

test("a failed API call (not billed) returns an error with no _meta", async () => {
    await withServer(async (client, mock) => {
        mock.reply("/twitter", 402, { detail: "Insufficient balance" }, costHeaders("0", 0));
        const sdk = await client.callTool({ name: "x-search", arguments: { query: "x" } });
        assert.equal(sdk.isError, true);
        assert.equal(sdk._meta, undefined);

        mock.reply("/desearch/tiktok/hashtag/ai", 500, { detail: "Service request failed" });
        const direct = await client.callTool({ name: "tiktok", arguments: { action: "hashtag", tag: "ai" } });
        assert.equal(direct.isError, true);
        assert.equal(direct._meta, undefined);
    });
});

test("concurrent calls on one server keep their own cost", async () => {
    await withServer(async (client, mock) => {
        mock.reply("/twitter/post", 200, POST, costHeaders("0.0003", 1), 40);
        mock.reply("/web/extract", 200, JSON.stringify("page"), costHeaders("0.0005", 1), 5);
        const [slow, fast] = await Promise.all([
            client.callTool({ name: "x-post-by-id", arguments: { id: "1" } }),
            client.callTool({ name: "extract", arguments: { url: "https://desearch.ai" } }),
        ]);
        assert.deepEqual(slow._meta, { cost_usd: 0.0003, usage_count: 1 });
        assert.deepEqual(fast._meta, { cost_usd: 0.0005, usage_count: 1 });
    });
});

test("withCostMeter sums several billed responses in one call and ignores bad header values", async () => {
    const headers = (map) => ({ get: (name) => map[name] ?? null });
    const { result, cost } = await withCostMeter(async () => {
        recordCostHeaders(headers({ "x-desearch-cost-usd": "0.1", "x-desearch-usage-count": "1" }));
        recordCostHeaders(headers({ "x-desearch-cost-usd": "0.2", "x-desearch-usage-count": "2" }));
        recordCostHeaders(headers({ "x-desearch-cost-usd": "not-a-number", "x-desearch-usage-count": "" }));
        return "done";
    });
    assert.equal(result, "done");
    assert.deepEqual(cost, { cost_usd: 0.3, usage_count: 3 });

    const empty = await withCostMeter(async () => "none");
    assert.deepEqual(empty.cost, {});

    // Outside a tool call there is no meter: recording is a no-op.
    recordCost(1, 1);
});
