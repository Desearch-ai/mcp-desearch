import assert from "node:assert/strict";
import test from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDesearchMcpServer } from "../build/server.js";
import { NEXT_CURSOR_HEADER, SOCIAL_ACTIONS, socialRequest } from "../build/social.js";

const API = "https://api.desearch.ai";
const JSON_TYPE = { "content-type": "application/json" };

// Shapes follow the production OpenAPI spec (TikTokPost, FacebookPost, InstagramMedia, ...).
const TIKTOK_POST = {
    id: "7620891413932166433",
    url: "https://www.tiktok.com/@tiktok/video/7620891413932166433",
    text: "caption text",
    author: { username: "tiktok" },
    hashtags: ["ai"],
    mentions: [],
};

// A cursor is opaque: it must come back to the API exactly as the API sent it.
const CURSOR = "eyJ2IjoxLCJyb3V0ZSI6Ii9kZXNlYXJjaC90aWt0b2svaGFzaHRhZyJ9.c2lnbmF0dXJl+/=_-";

function textOf(result) {
    assert.equal(result.content[0].type, "text");
    return result.content[0].text;
}

function readBody(opts) {
    const raw = opts.body;
    if (raw === undefined || raw === null) {
        return undefined;
    }
    return JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
}

function headerOf(headers, name) {
    if (typeof headers?.get === "function") {
        return headers.get(name) ?? undefined;
    }
    for (const [key, value] of Object.entries(headers ?? {})) {
        if (key.toLowerCase() === name) {
            return value;
        }
    }
    return undefined;
}

function split(path) {
    const url = new URL(path, API);
    return { pathname: url.pathname, query: Object.fromEntries(url.searchParams) };
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
        /** Reply once to the next request, whatever its path, and record it. */
        reply(status, body, headers = {}) {
            pool.intercept({ method: () => true, path: () => true }).reply(
                status,
                (opts) => {
                    seen.push({
                        method: opts.method,
                        path: opts.path,
                        headers: opts.headers,
                        body: readBody(opts),
                    });
                    return body;
                },
                { headers: { ...JSON_TYPE, ...headers } }
            );
        },
        async restore() {
            setGlobalDispatcher(previous);
            await agent.close();
        },
    };
}

async function withServer(fn, apiKey = "test-key") {
    const mock = installMock();
    const server = createDesearchMcpServer(apiKey);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "social", version: "0.0.1" });
    try {
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
        await fn(client, mock);
    } finally {
        await client.close();
        await server.close();
        await mock.restore();
    }
}

// Every route in the spec, with one call per action: [tool, arguments, method, path, query or body].
const ROUTES = [
    ["tiktok", { action: "search", query: "bittensor", count: 3, sort: "relevance" }, "POST", "/desearch/tiktok/search", { query: "bittensor", count: 3, sort: "relevance" }],
    ["tiktok", { action: "post", id: "7620891413932166433" }, "GET", "/desearch/tiktok/post/7620891413932166433", {}],
    ["tiktok", { action: "profile", username: "tiktok" }, "GET", "/desearch/tiktok/profile/tiktok", {}],
    ["tiktok", { action: "profile_posts", username: "tiktok", count: 2 }, "GET", "/desearch/tiktok/profile/tiktok/posts", { count: "2" }],
    ["tiktok", { action: "comments", video_id: "7620891413932166433", count: 1 }, "GET", "/desearch/tiktok/comments/7620891413932166433", { count: "1" }],
    ["tiktok", { action: "hashtag", tag: "ai" }, "GET", "/desearch/tiktok/hashtag/ai", {}],
    ["tiktok", { action: "trending", region: "GB", count: 3 }, "GET", "/desearch/tiktok/trending", { region: "GB", count: "3" }],
    ["facebook", { action: "search", query: "running shoes", count: 2 }, "POST", "/desearch/facebook/search", { query: "running shoes", count: 2 }],
    ["facebook", { action: "post", id: "1525856912919657" }, "GET", "/desearch/facebook/post/1525856912919657", {}],
    ["facebook", { action: "profile", profile_id: "facebook" }, "GET", "/desearch/facebook/profile/facebook", {}],
    ["facebook", { action: "profile_posts", profile_id: "facebook", count: 3 }, "GET", "/desearch/facebook/profile/facebook/posts", { count: "3" }],
    ["facebook", { action: "comments", post_id: "1525856912919657" }, "GET", "/desearch/facebook/comments/1525856912919657", {}],
    ["facebook", { action: "hashtag", tag: "ai", count: 1 }, "GET", "/desearch/facebook/hashtag/ai", { count: "1" }],
    ["instagram", { action: "search", query: "desearch", count: 3 }, "POST", "/desearch/instagram/search", { query: "desearch", count: 3 }],
    ["instagram", { action: "media", id: "DeuOR-CjKE9" }, "GET", "/desearch/instagram/media/DeuOR-CjKE9", {}],
    ["instagram", { action: "profile", username: "instagram" }, "GET", "/desearch/instagram/profile/instagram", {}],
    ["instagram", { action: "profile_posts", username: "instagram", count: 2 }, "GET", "/desearch/instagram/profile/instagram/posts", { count: "2" }],
    ["instagram", { action: "comments", shortcode: "DeuOR-CjKE9" }, "GET", "/desearch/instagram/comments/DeuOR-CjKE9", {}],
    ["instagram", { action: "hashtag", tag: "ai" }, "GET", "/desearch/instagram/hashtag/ai", {}],
];

test("the action table covers 7 TikTok, 6 Facebook, and 6 Instagram routes", () => {
    assert.deepEqual(Object.keys(SOCIAL_ACTIONS.tiktok), [
        "search",
        "post",
        "profile",
        "profile_posts",
        "comments",
        "hashtag",
        "trending",
    ]);
    assert.deepEqual(Object.keys(SOCIAL_ACTIONS.facebook), ["search", "post", "profile", "profile_posts", "comments", "hashtag"]);
    assert.deepEqual(Object.keys(SOCIAL_ACTIONS.instagram), ["search", "media", "profile", "profile_posts", "comments", "hashtag"]);
    assert.equal(ROUTES.length, 19);
    const covered = new Set(ROUTES.map(([tool, args]) => `${tool}.${args.action}`));
    assert.equal(covered.size, 19);
});

test("each social action calls its route with only the arguments it takes", async () => {
    await withServer(async (client, mock) => {
        for (const [tool, args, method, pathname, sent] of ROUTES) {
            const spec = SOCIAL_ACTIONS[tool][args.action];
            mock.reply(200, spec.list ? [TIKTOK_POST] : TIKTOK_POST);
            const result = await client.callTool({ name: tool, arguments: args });
            assert.equal(result.isError, undefined, `${tool} ${args.action}: ${textOf(result)}`);
            const call = mock.seen.at(-1);
            assert.equal(call.method, method, `${tool} ${args.action}`);
            assert.equal(headerOf(call.headers, "authorization"), "test-key");
            const { pathname: gotPath, query } = split(call.path);
            assert.equal(gotPath, pathname, `${tool} ${args.action}`);
            if (method === "POST") {
                assert.deepEqual(call.body, sent, `${tool} ${args.action}`);
                assert.deepEqual(query, {});
                assert.equal(headerOf(call.headers, "content-type"), "application/json");
            } else {
                assert.equal(call.body, undefined);
                assert.deepEqual(query, sent, `${tool} ${args.action}`);
            }
            const payload = JSON.parse(textOf(result));
            if (spec.list) {
                assert.deepEqual(payload.results, [TIKTOK_POST], `${tool} ${args.action}`);
                assert.equal(payload.next_cursor, null);
                assert.equal(typeof payload.next, "string");
            } else {
                // A single post, profile, or media item comes back as the API sent it.
                assert.deepEqual(payload, TIKTOK_POST, `${tool} ${args.action}`);
            }
        }
        assert.equal(mock.seen.length, ROUTES.length);
    });
});

test("list actions return the next-page cursor from x-desearch-next-cursor and send it back unchanged", async () => {
    await withServer(async (client, mock) => {
        mock.reply(200, [TIKTOK_POST], { [NEXT_CURSOR_HEADER]: CURSOR });
        const first = await client.callTool({ name: "tiktok", arguments: { action: "hashtag", tag: "ai", count: 2 } });
        assert.equal(first.isError, undefined, textOf(first));
        const page = JSON.parse(textOf(first));
        assert.equal(page.next_cursor, CURSOR);
        assert.match(page.next, /call tiktok again with action "hashtag", the same tag, and cursor set to next_cursor/);
        assert.equal(Object.hasOwn(split(mock.seen[0].path).query, "cursor"), false);

        // Second page: the cursor goes back as a query parameter, byte for byte. No header: last page.
        mock.reply(200, []);
        const second = await client.callTool({
            name: "tiktok",
            arguments: { action: "hashtag", tag: "ai", count: 2, cursor: page.next_cursor },
        });
        const last = JSON.parse(textOf(second));
        assert.equal(split(mock.seen[1].path).query.cursor, CURSOR);
        assert.deepEqual(last, { results: [], next_cursor: null, next: "Last page: there are no more results." });

        // POST search routes take the cursor in the body.
        mock.reply(200, [TIKTOK_POST], { [NEXT_CURSOR_HEADER]: "next-2" });
        const search = await client.callTool({
            name: "facebook",
            arguments: { action: "search", query: "running shoes", cursor: CURSOR },
        });
        assert.deepEqual(mock.seen[2].body, { query: "running shoes", cursor: CURSOR });
        assert.equal(JSON.parse(textOf(search)).next_cursor, "next-2");

        for (const [tool, args] of [
            ["instagram", { action: "comments", shortcode: "DeuOR-CjKE9", cursor: CURSOR }],
            ["instagram", { action: "profile_posts", username: "instagram", cursor: CURSOR }],
            ["facebook", { action: "comments", post_id: "1", cursor: CURSOR }],
            ["tiktok", { action: "profile_posts", username: "tiktok", cursor: CURSOR }],
        ]) {
            mock.reply(200, [], { [NEXT_CURSOR_HEADER]: "following" });
            const result = await client.callTool({ name: tool, arguments: args });
            assert.equal(split(mock.seen.at(-1).path).query.cursor, CURSOR, `${tool} ${args.action}`);
            assert.equal(JSON.parse(textOf(result)).next_cursor, "following", `${tool} ${args.action}`);
        }
    });
});

test("TikTok trending and Instagram search return one page and refuse a cursor", async () => {
    await withServer(async (client, mock) => {
        mock.reply(200, [TIKTOK_POST]);
        const trending = await client.callTool({ name: "tiktok", arguments: { action: "trending" } });
        const page = JSON.parse(textOf(trending));
        assert.equal(page.next_cursor, null);
        assert.equal(page.next, "This action returns one page and takes no cursor.");
        assert.deepEqual(split(mock.seen[0].path).query, {});

        for (const [tool, args] of [
            ["tiktok", { action: "trending", cursor: CURSOR }],
            ["instagram", { action: "search", query: "desearch", cursor: CURSOR }],
        ]) {
            const refused = await client.callTool({ name: tool, arguments: args });
            assert.equal(refused.isError, true);
            assert.match(textOf(refused), /does not take cursor/);
        }
        assert.equal(mock.seen.length, 1);
    });
});

test("each action names the argument it is missing or does not take, before any request", async () => {
    await withServer(async (client, mock) => {
        const cases = [
            [
                "tiktok",
                { action: "comments" },
                'TikTok error: tiktok action "comments" needs video_id. comments takes: video_id (required), count, cursor. No request was sent.',
            ],
            [
                "tiktok",
                { action: "comments", id: "7620891413932166433" },
                'TikTok error: tiktok action "comments" needs video_id. tiktok action "comments" does not take id. comments takes: video_id (required), count, cursor. No request was sent.',
            ],
            [
                "tiktok",
                { action: "trending", cursor: "abc", tag: "ai" },
                'TikTok error: tiktok action "trending" does not take tag, cursor. trending takes: region, count. No request was sent.',
            ],
            [
                "tiktok",
                { action: "post", id: "1", count: 5 },
                'TikTok error: tiktok action "post" does not take count. post takes: id (required). No request was sent.',
            ],
            [
                "facebook",
                { action: "profile", post_id: "1525856912919657" },
                'Facebook error: facebook action "profile" needs profile_id. facebook action "profile" does not take post_id. profile takes: profile_id (required). No request was sent.',
            ],
            [
                "facebook",
                { action: "search" },
                'Facebook error: facebook action "search" needs query. search takes: query (required), count, cursor. No request was sent.',
            ],
            [
                "instagram",
                { action: "comments", id: "DeuOR-CjKE9" },
                'Instagram error: instagram action "comments" needs shortcode. instagram action "comments" does not take id. comments takes: shortcode (required), count, cursor. No request was sent.',
            ],
            [
                "instagram",
                { action: "hashtag", tag: "  #  " },
                'Instagram error: instagram action "hashtag" needs tag. hashtag takes: tag (required), count, cursor. No request was sent.',
            ],
        ];
        for (const [tool, args, message] of cases) {
            const result = await client.callTool({ name: tool, arguments: args });
            assert.equal(result.isError, true, JSON.stringify(args));
            assert.equal(textOf(result), message);
        }

        // Schema checks: unknown action, unknown argument, out-of-range count, empty strings, bad region.
        for (const [tool, args] of [
            ["tiktok", {}],
            ["tiktok", { action: "media", id: "1" }],
            ["instagram", { action: "trending" }],
            ["facebook", { action: "post", id: "1", limit: 5 }],
            ["facebook", { action: "profile", username: "facebook" }],
            ["tiktok", { action: "hashtag", tag: "ai", count: 0 }],
            ["tiktok", { action: "hashtag", tag: "ai", count: 101 }],
            ["tiktok", { action: "hashtag", tag: "ai", count: 2.5 }],
            ["tiktok", { action: "hashtag", tag: "ai", cursor: "" }],
            ["tiktok", { action: "profile", username: "" }],
            ["tiktok", { action: "trending", region: "USA" }],
        ]) {
            const result = await client.callTool({ name: tool, arguments: args });
            assert.equal(result.isError, true, JSON.stringify(args));
            assert.match(textOf(result), /Input validation error/, JSON.stringify(args));
        }
        assert.equal(mock.seen.length, 0);
    });
});

test("path arguments are URL-encoded; @ and # prefixes are dropped; null optional arguments are omitted", async () => {
    await withServer(async (client, mock) => {
        mock.reply(200, {});
        await client.callTool({
            name: "instagram",
            arguments: { action: "media", id: "https://www.instagram.com/p/DeuOR-CjKE9/" },
        });
        // An {id:path} route takes a "/" in the id; encoded, it stays one path value.
        assert.equal(mock.seen[0].path, "/desearch/instagram/media/https%3A%2F%2Fwww.instagram.com%2Fp%2FDeuOR-CjKE9%2F");

        mock.reply(200, {});
        await client.callTool({ name: "tiktok", arguments: { action: "profile", username: " @tiktok " } });
        assert.equal(mock.seen[1].path, "/desearch/tiktok/profile/tiktok");

        mock.reply(200, []);
        await client.callTool({ name: "instagram", arguments: { action: "hashtag", tag: "#ai", count: null, cursor: null } });
        assert.equal(mock.seen[2].path, "/desearch/instagram/hashtag/ai");

        mock.reply(200, {});
        await client.callTool({ name: "facebook", arguments: { action: "post", id: "123/456?x=1#y" } });
        assert.equal(mock.seen[3].path, "/desearch/facebook/post/123%2F456%3Fx%3D1%23y");
    });
    // The same rules without a server, for the argument values the request is built from.
    assert.deepEqual(socialRequest("tiktok", { action: "hashtag", tag: "##ai", count: 2 }).values, { count: 2 });
    assert.equal(socialRequest("tiktok", { action: "hashtag", tag: "##ai" }).path, "/desearch/tiktok/hashtag/ai");
});

test("social API errors keep the HTTP status and the API detail", async () => {
    await withServer(async (client, mock) => {
        mock.reply(422, { detail: "Invalid request parameters" });
        const badCursor = await client.callTool({
            name: "tiktok",
            arguments: { action: "hashtag", tag: "ai", cursor: "10" },
        });
        assert.equal(badCursor.isError, true);
        assert.equal(textOf(badCursor), "TikTok error: HTTP 422: Invalid request parameters");

        mock.reply(422, { detail: [{ loc: ["body", "count"], msg: "Input should be less than or equal to 100" }] });
        const validation = await client.callTool({ name: "facebook", arguments: { action: "search", query: "x" } });
        assert.equal(
            textOf(validation),
            'Facebook error: HTTP 422: [{"loc":["body","count"],"msg":"Input should be less than or equal to 100"}]'
        );

        mock.reply(404, { detail: "Not Found" });
        const missing = await client.callTool({ name: "instagram", arguments: { action: "comments", shortcode: "123" } });
        assert.equal(textOf(missing), "Instagram error: HTTP 404: Not Found");

        mock.reply(401, { detail: "Invalid API key" });
        const denied = await client.callTool({ name: "instagram", arguments: { action: "profile", username: "instagram" } });
        assert.equal(textOf(denied), "Instagram error: HTTP 401: Invalid API key");

        mock.reply(502, "upstream timed out", { "content-type": "text/plain" });
        const upstream = await client.callTool({ name: "tiktok", arguments: { action: "post", id: "1" } });
        assert.equal(textOf(upstream), "TikTok error: HTTP 502: upstream timed out");

        // No interceptor left and the network is disabled: a transport failure.
        const offline = await client.callTool({ name: "tiktok", arguments: { action: "trending" } });
        assert.equal(offline.isError, true);
        assert.match(textOf(offline), /^TikTok error: Unexpected Error: /);
    });
});

test("social tools and search-api need an API key and send nothing without one", async () => {
    await withServer(async (client, mock) => {
        for (const [name, args] of [
            ["tiktok", { action: "trending" }],
            ["facebook", { action: "profile", profile_id: "facebook" }],
            ["instagram", { action: "profile", username: "instagram" }],
            ["search-api", { query: "desearch" }],
            ["people-search-export", { platform: "tiktok" }],
        ]) {
            const result = await client.callTool({ name, arguments: args });
            assert.equal(result.isError, true, name);
            assert.match(textOf(result), /API key required/, name);
        }
        assert.equal(mock.seen.length, 0);
    }, "");
});
