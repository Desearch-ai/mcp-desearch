import assert from "node:assert/strict";
import test from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Desearch from "desearch-js";
import { createDesearchMcpServer, presentSearchBody } from "../build/server.js";

const WEB_LINKS_BODY = {
    search_results: [
        {
            title: "Bittensor subnet news",
            snippet: "Latest subnet updates",
            link: "https://example.com/subnet",
        },
    ],
    cost_usd: 0.00015,
    usage_count: 10,
    service: "/desearch/ai/search/links/web",
    currency: "USD",
};

function textOf(result) {
    assert.equal(result.content[0].type, "text");
    return result.content[0].text;
}

async function withServer(fn) {
    const server = createDesearchMcpServer("test-key");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "links", version: "0.0.1" });
    try {
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
        await fn(client);
    } finally {
        await client.close();
        await server.close();
    }
}

function installMock() {
    const previous = getGlobalDispatcher();
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    const pool = agent.get("https://api.desearch.ai");
    return {
        pool,
        async restore() {
            setGlobalDispatcher(previous);
            await agent.close();
        },
    };
}

function readBody(opts) {
    const raw = opts.body;
    if (typeof raw === "string") {
        return JSON.parse(raw);
    }
    if (raw instanceof Uint8Array) {
        return JSON.parse(Buffer.from(raw).toString("utf8"));
    }
    return JSON.parse(String(raw));
}

test("desearch-js 1.5.0 methods used by server.ts exist", () => {
    const client = new Desearch("test-key");
    const methods = [
        "aiSearch",
        "xSearch",
        "webSearch",
        "aiWebLinksSearch",
        "aiXLinksSearch",
        "xPostsByUrls",
        "xPostById",
        "xPostsByUser",
        "xPostRetweeters",
        "xUserPosts",
        "xUserReplies",
        "xPostReplies",
        "xTrends",
        "extract",
        "webCrawl",
    ];
    for (const name of methods) {
        assert.equal(typeof client[name], "function", name);
    }
    assert.equal(client.AISearch, undefined);
    assert.equal(client.twitterSearch, undefined);
});

test("presentSearchBody keeps search_results and billing, and hoists nested link arrays", () => {
    assert.deepEqual(presentSearchBody(WEB_LINKS_BODY), WEB_LINKS_BODY);

    const costOnly = {
        cost_usd: 0.00015,
        usage_count: 10,
        service: "/desearch/ai/search",
        currency: "USD",
    };
    assert.deepEqual(presentSearchBody(costOnly), costOnly);

    const nested = {
        cost_usd: 0.00015,
        usage_count: 10,
        service: "/desearch/ai/search",
        currency: "USD",
        payload: {
            results: [{ title: "Nested", link: "https://example.com/nested", snippet: "n" }],
        },
    };
    const presented = presentSearchBody(nested);
    assert.equal(presented.results[0].link, "https://example.com/nested");
    assert.equal(presented.cost_usd, 0.00015);
    assert.equal(presented.payload.results[0].link, "https://example.com/nested");

    const notLinks = {
        cost_usd: 0.00015,
        usage_count: 1,
        service: "/desearch/ai/search",
        currency: "USD",
        meta: { data: [1, 2, 3] },
    };
    assert.deepEqual(presentSearchBody(notLinks), notLinks);
    assert.equal(Object.hasOwn(presentSearchBody(notLinks), "data"), false);

    const underSearch = {
        search: [{ title: "AI", link: "https://example.com/ai", snippet: "s" }],
        completion: "summary",
        cost_usd: 0.0003,
        currency: "USD",
    };
    assert.deepEqual(presentSearchBody(underSearch), underSearch);
});

test("web-links-search posts to /links/web and returns search_results plus billing", async () => {
    const mock = installMock();
    let seen;
    mock.pool
        .intercept({ path: "/desearch/ai/search/links/web", method: "POST" })
        .reply(200, (opts) => {
            seen = { path: opts.path, method: opts.method, body: readBody(opts), headers: opts.headers };
            return WEB_LINKS_BODY;
        }, {
            headers: { "content-type": "application/json" },
        });

    try {
        await withServer(async (client) => {
            const result = await client.callTool({
                name: "web-links-search",
                arguments: {
                    prompt: "bittensor subnet news",
                    tools: ["web"],
                    count: 10,
                },
            });
            assert.equal(result.isError, undefined);
            assert.deepEqual(JSON.parse(textOf(result)), WEB_LINKS_BODY);
        });
    } finally {
        await mock.restore();
    }

    assert.equal(seen.path, "/desearch/ai/search/links/web");
    assert.equal(seen.method, "POST");
    assert.deepEqual(seen.body, {
        prompt: "bittensor subnet news",
        tools: ["web"],
        count: 10,
    });
    const headerBag = seen.headers;
    const authorization =
        typeof headerBag?.get === "function"
            ? headerBag.get("authorization") ?? headerBag.get("Authorization")
            : headerBag?.authorization ?? headerBag?.Authorization;
    assert.equal(authorization, "test-key", `header keys: ${headerBag && typeof headerBag === "object" ? Object.keys(headerBag).join(",") : typeof headerBag}`);
});

test("web-links-search omits count when the caller does not set it", async () => {
    const mock = installMock();
    let seenBody;
    mock.pool
        .intercept({ path: "/desearch/ai/search/links/web", method: "POST" })
        .reply(200, (opts) => {
            seenBody = readBody(opts);
            return WEB_LINKS_BODY;
        }, {
            headers: { "content-type": "application/json" },
        });

    try {
        await withServer(async (client) => {
            const result = await client.callTool({
                name: "web-links-search",
                arguments: { prompt: "bittensor subnet news", tools: ["web"] },
            });
            assert.deepEqual(JSON.parse(textOf(result)).search_results[0].link, "https://example.com/subnet");
        });
    } finally {
        await mock.restore();
    }

    assert.deepEqual(seenBody, { prompt: "bittensor subnet news", tools: ["web"] });
    assert.equal(Object.hasOwn(seenBody, "count"), false);
});

test("ai-search ONLY_LINKS posts to /desearch/ai/search and keeps whichever link key is present", async () => {
    const mock = installMock();
    const seen = [];
    const costOnly = {
        cost_usd: 0.00015,
        usage_count: 1,
        service: "/desearch/ai/search",
        currency: "USD",
    };
    const withSearch = {
        search: [{ title: "Docs", link: "https://desearch.ai", snippet: "sdk" }],
        cost_usd: 0.00015,
        usage_count: 1,
        service: "/desearch/ai/search",
        currency: "USD",
    };
    const withResults = {
        results: [{ title: "Other", link: "https://example.com/other", snippet: "o" }],
        cost_usd: 0.00015,
        usage_count: 1,
        service: "/desearch/ai/search",
        currency: "USD",
    };
    const withData = {
        data: [{ title: "Data", link: "https://example.com/data", snippet: "d" }],
        cost_usd: 0.00015,
        usage_count: 1,
        service: "/desearch/ai/search",
        currency: "USD",
    };
    const bodies = [costOnly, withSearch, withResults, withData];
    let call = 0;
    mock.pool
        .intercept({ path: "/desearch/ai/search", method: "POST" })
        .reply(200, (opts) => {
            seen.push(readBody(opts));
            return bodies[call++];
        }, {
            headers: { "content-type": "application/json" },
        })
        .times(4);

    try {
        await withServer(async (client) => {
            const onlyLinks = await client.callTool({
                name: "ai-search",
                arguments: {
                    prompt: "bittensor subnet news",
                    tools: ["Web Search"],
                    result_type: "ONLY_LINKS",
                },
            });
            assert.deepEqual(JSON.parse(textOf(onlyLinks)), costOnly);

            const searchKey = await client.callTool({
                name: "ai-search",
                arguments: {
                    prompt: "bittensor subnet news",
                    tools: ["Web Search"],
                    result_type: "ONLY_LINKS",
                },
            });
            const searchBody = JSON.parse(textOf(searchKey));
            assert.equal(searchBody.search[0].link, "https://desearch.ai");
            assert.equal(searchBody.cost_usd, 0.00015);

            const resultsKey = await client.callTool({
                name: "ai-search",
                arguments: { prompt: "links", result_type: "ONLY_LINKS" },
            });
            assert.equal(JSON.parse(textOf(resultsKey)).results[0].link, "https://example.com/other");

            const dataKey = await client.callTool({
                name: "ai-search",
                arguments: { prompt: "links", result_type: "ONLY_LINKS" },
            });
            const dataBody = JSON.parse(textOf(dataKey));
            assert.equal(dataBody.data[0].link, "https://example.com/data");
            assert.equal(dataBody.currency, "USD");
        });
    } finally {
        await mock.restore();
    }

    assert.equal(seen.length, 4);
    for (const body of seen) {
        assert.equal(body.result_type, "ONLY_LINKS");
        assert.equal(body.streaming, false);
        assert.equal(body.model, "NOVA");
        assert.equal(Object.hasOwn(body, "date_filter"), false);
    }
    assert.deepEqual(seen[0].tools, ["Web Search"]);
    assert.equal(seen[0].prompt, "bittensor subnet news");
});
