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
            return {
                search_results: [{ title: "Docs", link: "https://desearch.ai", snippet: "sdk" }],
                cost_usd: 0.00015,
                usage_count: 10,
                service: "/desearch/ai/search/links/web",
                currency: "USD",
            };
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
        const linksBody = JSON.parse(textOf(links));
        assert.equal(linksBody.search_results[0].title, "Docs");
        assert.equal(linksBody.search_results[0].link, "https://desearch.ai");
        assert.equal(linksBody.cost_usd, 0.00015);
        assert.equal(linksBody.usage_count, 10);
        assert.equal(linksBody.service, "/desearch/ai/search/links/web");
        assert.equal(linksBody.currency, "USD");

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

test("phase 3 x tools call the matching desearch-js methods", async () => {
    const calls = [];
    const fake = {
        async xSearch(payload) {
            calls.push(["xSearch", payload]);
            return [{ id: "filtered" }];
        },
        async aiXLinksSearch(payload) {
            calls.push(["aiXLinksSearch", payload]);
            return { search_results: [{ link: "https://x.com/user/status/1" }] };
        },
        async xPostsByUrls(payload) {
            calls.push(["xPostsByUrls", payload]);
            return [{ id: "url-post" }];
        },
        async xPostById(payload) {
            calls.push(["xPostById", payload]);
            if (payload.id === "missing") {
                throw new Error("HTTP 404: not found");
            }
            return { id: payload.id, text: "one post" };
        },
        async xPostsByUser(payload) {
            calls.push(["xPostsByUser", payload]);
            return [{ id: "user-post" }];
        },
        async xPostRetweeters(payload) {
            calls.push(["xPostRetweeters", payload]);
            return { users: [{ username: "alice" }], cursor: "next" };
        },
        async xUserPosts(payload) {
            calls.push(["xUserPosts", payload]);
            return { posts: [{ id: "timeline" }] };
        },
        async xUserReplies(payload) {
            calls.push(["xUserReplies", payload]);
            return [{ id: "reply" }];
        },
        async xPostReplies(payload) {
            calls.push(["xPostReplies", payload]);
            return [{ id: "thread" }];
        },
    };

    await withFakeClient(fake, async (client) => {
        const filtered = await client.callTool({
            name: "x-search",
            arguments: {
                query: "bittensor",
                count: 15,
                user: "opentensor",
                start_date: "2024-01-01",
                end_date: "2024-02-01",
                lang: "en",
                verified: true,
                blue_verified: false,
                is_quote: true,
                is_video: false,
                is_image: true,
                min_retweets: 5,
                min_replies: "2",
                min_likes: 10,
            },
        });
        assert.equal(JSON.parse(textOf(filtered))[0].id, "filtered");

        const links = await client.callTool({
            name: "x-links-search",
            arguments: { prompt: "subnet updates", count: 20 },
        });
        assert.equal(JSON.parse(textOf(links)).search_results[0].link, "https://x.com/user/status/1");

        const byUrls = await client.callTool({
            name: "x-posts-by-urls",
            arguments: { urls: ["https://x.com/user/status/1"] },
        });
        assert.equal(JSON.parse(textOf(byUrls))[0].id, "url-post");

        const byId = await client.callTool({
            name: "x-post-by-id",
            arguments: { id: "123" },
        });
        assert.equal(JSON.parse(textOf(byId)).text, "one post");

        const byUser = await client.callTool({
            name: "x-posts-by-user",
            arguments: { user: "elonmusk", query: "mars", count: 5 },
        });
        assert.equal(JSON.parse(textOf(byUser))[0].id, "user-post");

        const retweeters = await client.callTool({
            name: "x-post-retweeters",
            arguments: { id: "123", cursor: "page-2" },
        });
        assert.equal(JSON.parse(textOf(retweeters)).users[0].username, "alice");

        const timeline = await client.callTool({
            name: "x-user-posts",
            arguments: { username: "elonmusk" },
        });
        assert.equal(JSON.parse(textOf(timeline)).posts[0].id, "timeline");

        const userReplies = await client.callTool({
            name: "x-user-replies",
            arguments: { user: "elonmusk", count: 8, query: "starship" },
        });
        assert.equal(JSON.parse(textOf(userReplies))[0].id, "reply");

        const postReplies = await client.callTool({
            name: "x-post-replies",
            arguments: { post_id: "123" },
        });
        assert.equal(JSON.parse(textOf(postReplies))[0].id, "thread");

        const failed = await client.callTool({
            name: "x-post-by-id",
            arguments: { id: "missing" },
        });
        assert.equal(failed.isError, true);
        assert.match(textOf(failed), /^X Post By ID error: HTTP 404: not found$/);

        const rejectedLinks = await client.callTool({
            name: "x-links-search",
            arguments: { prompt: "too few", count: 5 },
        });
        assert.equal(rejectedLinks.isError, true);

        const rejectedUrls = await client.callTool({
            name: "x-posts-by-urls",
            arguments: { urls: [] },
        });
        assert.equal(rejectedUrls.isError, true);
    });

    assert.deepEqual(calls, [
        [
            "xSearch",
            {
                query: "bittensor",
                sort: "Top",
                count: 15,
                user: "opentensor",
                start_date: "2024-01-01",
                end_date: "2024-02-01",
                lang: "en",
                verified: true,
                blue_verified: false,
                is_quote: true,
                is_video: false,
                is_image: true,
                min_retweets: 5,
                min_replies: "2",
                min_likes: 10,
            },
        ],
        ["aiXLinksSearch", { prompt: "subnet updates", count: 20 }],
        ["xPostsByUrls", { urls: ["https://x.com/user/status/1"] }],
        ["xPostById", { id: "123" }],
        ["xPostsByUser", { user: "elonmusk", query: "mars", count: 5 }],
        ["xPostRetweeters", { id: "123", cursor: "page-2" }],
        ["xUserPosts", { username: "elonmusk", cursor: undefined }],
        ["xUserReplies", { user: "elonmusk", count: 8, query: "starship" }],
        ["xPostReplies", { post_id: "123", count: undefined, query: undefined }],
        ["xPostById", { id: "missing" }],
    ]);
});

test("phase 4 extract, web-crawl, and x-trends call the matching desearch-js methods", async () => {
    const calls = [];
    const fake = {
        async extract(payload) {
            calls.push(["extract", payload]);
            if (payload.url === "https://fail.example") {
                throw new Error("HTTP 422: bad url");
            }
            return "page text";
        },
        async webCrawl(payload) {
            calls.push(["webCrawl", payload]);
            return "<p>legacy</p>";
        },
        async xTrends(payload) {
            calls.push(["xTrends", payload]);
            return { trends: [{ name: "Desearch", rank: 1 }] };
        },
    };

    await withFakeClient(fake, async (client) => {
        const listed = await client.listTools();
        assert.deepEqual(
            listed.tools.map((tool) => tool.name).sort(),
            [
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
            ]
        );

        const extracted = await client.callTool({
            name: "extract",
            arguments: {
                url: "https://desearch.ai",
                format: "text",
                js: true,
                wait: 1500,
            },
        });
        assert.equal(extracted.isError, undefined);
        assert.equal(JSON.parse(textOf(extracted)), "page text");

        const extractedDefaults = await client.callTool({
            name: "extract",
            arguments: { url: "https://desearch.ai/docs" },
        });
        assert.equal(JSON.parse(textOf(extractedDefaults)), "page text");

        const crawled = await client.callTool({
            name: "web-crawl",
            arguments: {
                url: "https://desearch.ai",
                format: "html",
                js: false,
                wait: 0,
            },
        });
        assert.equal(JSON.parse(textOf(crawled)), "<p>legacy</p>");

        const trends = await client.callTool({
            name: "x-trends",
            arguments: { woeid: 23424977, count: 30 },
        });
        assert.equal(JSON.parse(textOf(trends)).trends[0].name, "Desearch");

        const trendsDefaultCount = await client.callTool({
            name: "x-trends",
            arguments: { woeid: 1 },
        });
        assert.equal(JSON.parse(textOf(trendsDefaultCount)).trends[0].rank, 1);

        const failed = await client.callTool({
            name: "extract",
            arguments: { url: "https://fail.example" },
        });
        assert.equal(failed.isError, true);
        assert.match(textOf(failed), /^Extract error: HTTP 422: bad url$/);

        const rejectedFormat = await client.callTool({
            name: "extract",
            arguments: { url: "https://desearch.ai", format: "markdown" },
        });
        assert.equal(rejectedFormat.isError, true);

        const rejectedCrawl = await client.callTool({
            name: "web-crawl",
            arguments: { format: "text" },
        });
        assert.equal(rejectedCrawl.isError, true);

        const rejectedCount = await client.callTool({
            name: "x-trends",
            arguments: { woeid: 23424977, count: 10 },
        });
        assert.equal(rejectedCount.isError, true);

        const rejectedWoeid = await client.callTool({
            name: "x-trends",
            arguments: { count: 30 },
        });
        assert.equal(rejectedWoeid.isError, true);
    });

    assert.deepEqual(calls, [
        [
            "extract",
            { url: "https://desearch.ai", format: "text", js: true, wait: 1500 },
        ],
        [
            "extract",
            { url: "https://desearch.ai/docs", format: undefined, js: undefined, wait: undefined },
        ],
        [
            "webCrawl",
            { url: "https://desearch.ai", format: "html", js: false, wait: 0 },
        ],
        ["xTrends", { woeid: 23424977, count: 30 }],
        ["xTrends", { woeid: 1, count: undefined }],
        ["extract", { url: "https://fail.example", format: undefined, js: undefined, wait: undefined }],
    ]);
});
