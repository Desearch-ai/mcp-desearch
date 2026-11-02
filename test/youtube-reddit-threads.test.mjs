import assert from "node:assert/strict";
import test from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDesearchMcpServer } from "../build/server.js";
import { NEXT_CURSOR_HEADER, SOCIAL_ACTIONS, socialRequest } from "../build/social.js";

const API = "https://api.desearch.ai";
const JSON_TYPE = { "content-type": "application/json" };

// Shapes follow the dev OpenAPI spec (YouTubeItem, YouTubeVideo, RedditPost, ThreadsPostDetail, ...).
const YOUTUBE_ITEM = {
    id: "dQw4w9WgXcQ",
    type: "video",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    title: "Video title",
    channel: { id: "UCuAXFkgsw1L7xaCfnd5JJOw", handle: "RickAstleyYT" },
    views: 110447,
};
const REDDIT_POST = { id: "1q6pxwn", name: "t3_1q6pxwn", title: "Post title", subreddit: "webscraping", score: 12 };
const THREADS_POST = {
    id: "3656367813102434565",
    code: "DK-BydcJHkF",
    url: "https://www.threads.com/@zuck/post/DK-BydcJHkF",
    author: { username: "zuck" },
    comments: [],
    threadItems: [],
};

// A cursor is opaque: it must come back to the API exactly as the API sent it.
const CURSOR = "eyJ2IjoxLCJyb3V0ZSI6Ii9kZXNlYXJjaC95b3V0dWJlL3NlYXJjaCJ9.c2lnbmF0dXJl+/=_-";

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
    const client = new Client({ name: "youtube-reddit-threads", version: "0.0.1" });
    try {
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
        await fn(client, mock);
    } finally {
        await client.close();
        await server.close();
        await mock.restore();
    }
}

// Every YouTube, Reddit, and Threads route, one call per action: [tool, arguments, method, path, query or body, reply].
const ROUTES = [
    [
        "youtube",
        { action: "search", query: "bittensor", type: "videos", upload_date: "this_month", sort_by: "popular", duration: "over_20_min" },
        "POST",
        "/desearch/youtube/search",
        { query: "bittensor", type: "videos", upload_date: "this_month", sort_by: "popular", duration: "over_20_min" },
        YOUTUBE_ITEM,
    ],
    ["youtube", { action: "video", id: "dQw4w9WgXcQ" }, "GET", "/desearch/youtube/video/dQw4w9WgXcQ", {}, YOUTUBE_ITEM],
    [
        "youtube",
        { action: "transcript", video_id: "dQw4w9WgXcQ", language: "en" },
        "GET",
        "/desearch/youtube/transcript/dQw4w9WgXcQ",
        { language: "en" },
        { videoId: "dQw4w9WgXcQ", text: "never gonna", segments: [{ text: "never gonna", startMs: 160 }] },
    ],
    [
        "youtube",
        { action: "comments", video_id: "dQw4w9WgXcQ", order: "newest" },
        "GET",
        "/desearch/youtube/comments/dQw4w9WgXcQ",
        { order: "newest" },
        { id: "Ugw", text: "classic", likes: 3 },
    ],
    ["youtube", { action: "channel", handle: "@MrBeast" }, "GET", "/desearch/youtube/channel/%40MrBeast", {}, { id: "UCX6", handle: "MrBeast" }],
    [
        "youtube",
        { action: "channel_videos", handle: "MrBeast", sort: "popular" },
        "GET",
        "/desearch/youtube/channel/MrBeast/videos",
        { sort: "popular" },
        YOUTUBE_ITEM,
    ],
    [
        "reddit",
        { action: "search", query: "bittensor", sort: "comment_count", timeframe: "week" },
        "POST",
        "/desearch/reddit/search",
        { query: "bittensor", sort: "comment_count", timeframe: "week" },
        REDDIT_POST,
    ],
    ["reddit", { action: "subreddit", name: "AskReddit" }, "GET", "/desearch/reddit/subreddit/AskReddit", {}, { id: "t5_2qh1i", name: "AskReddit" }],
    [
        "reddit",
        { action: "subreddit_posts", name: "AskReddit", sort: "top", timeframe: "week" },
        "GET",
        "/desearch/reddit/subreddit/AskReddit/posts",
        { sort: "top", timeframe: "week" },
        REDDIT_POST,
    ],
    ["reddit", { action: "post", id: "1q6pxwn" }, "GET", "/desearch/reddit/post/1q6pxwn", {}, REDDIT_POST],
    [
        "reddit",
        { action: "comments", post_id: "t3_1q6pxwn" },
        "GET",
        "/desearch/reddit/comments/t3_1q6pxwn",
        {},
        { id: "mymupxb", depth: 0, replies: [], hasMoreReplies: false },
    ],
    [
        "threads",
        { action: "search", query: "bittensor", start_date: "2026-01-01", end_date: "2026-10-30" },
        "POST",
        "/desearch/threads/search",
        { query: "bittensor", start_date: "2026-01-01", end_date: "2026-10-30" },
        THREADS_POST,
    ],
    ["threads", { action: "search_users", query: "zuck" }, "POST", "/desearch/threads/search/users", { query: "zuck" }, { username: "zuck" }],
    ["threads", { action: "profile", username: "zuck" }, "GET", "/desearch/threads/profile/zuck", {}, { username: "zuck", followers: 5 }],
    ["threads", { action: "profile_posts", username: "zuck" }, "GET", "/desearch/threads/profile/zuck/posts", {}, THREADS_POST],
    ["threads", { action: "post", id: "DK-BydcJHkF" }, "GET", "/desearch/threads/post/DK-BydcJHkF", {}, THREADS_POST],
];

test("the action table covers 6 YouTube, 5 Reddit, and 5 Threads routes", () => {
    assert.deepEqual(Object.keys(SOCIAL_ACTIONS.youtube), ["search", "video", "transcript", "comments", "channel", "channel_videos"]);
    assert.deepEqual(Object.keys(SOCIAL_ACTIONS.reddit), ["search", "subreddit", "subreddit_posts", "post", "comments"]);
    assert.deepEqual(Object.keys(SOCIAL_ACTIONS.threads), ["search", "search_users", "profile", "profile_posts", "post"]);
    assert.equal(ROUTES.length, 16);
    const covered = new Set(ROUTES.map(([tool, args]) => `${tool}.${args.action}`));
    assert.equal(covered.size, 16);
    // The six routes that page (OpenAPI: a cursor parameter and the x-desearch-next-cursor header).
    const paged = [];
    for (const platform of ["youtube", "reddit", "threads"]) {
        for (const [action, spec] of Object.entries(SOCIAL_ACTIONS[platform])) {
            if (spec.optional.includes("cursor")) paged.push(`${platform}.${action}`);
        }
    }
    assert.deepEqual(paged, [
        "youtube.search",
        "youtube.comments",
        "youtube.channel_videos",
        "reddit.search",
        "reddit.subreddit_posts",
        "reddit.comments",
    ]);
});

test("each YouTube, Reddit, and Threads action calls its route with only the arguments it takes", async () => {
    await withServer(async (client, mock) => {
        for (const [tool, args, method, pathname, sent, item] of ROUTES) {
            const spec = SOCIAL_ACTIONS[tool][args.action];
            mock.reply(200, spec.list ? [item] : item);
            const result = await client.callTool({ name: tool, arguments: args });
            assert.equal(result.isError, undefined, `${tool} ${args.action}: ${textOf(result)}`);
            const call = mock.seen.at(-1);
            assert.equal(call.method, method, `${tool} ${args.action}`);
            assert.equal(headerOf(call.headers, "authorization"), "test-key");
            const { pathname: gotPath, query } = split(call.path);
            assert.equal(call.path.split("?")[0], pathname, `${tool} ${args.action}`);
            assert.equal(decodeURIComponent(gotPath), decodeURIComponent(pathname));
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
                assert.deepEqual(payload.results, [item], `${tool} ${args.action}`);
                assert.equal(payload.next_cursor, null);
                assert.equal(typeof payload.next, "string");
            } else {
                // A single video, transcript, channel, subreddit, post, or profile comes back as the API sent it.
                assert.deepEqual(payload, item, `${tool} ${args.action}`);
            }
        }
        assert.equal(mock.seen.length, ROUTES.length);
    });
});

test("YouTube and Reddit list actions return x-desearch-next-cursor and send it back unchanged", async () => {
    await withServer(async (client, mock) => {
        // POST search: the cursor goes back in the JSON body.
        mock.reply(200, [YOUTUBE_ITEM], { [NEXT_CURSOR_HEADER]: CURSOR });
        const first = await client.callTool({ name: "youtube", arguments: { action: "search", query: "bittensor" } });
        assert.equal(first.isError, undefined, textOf(first));
        const page = JSON.parse(textOf(first));
        assert.equal(page.next_cursor, CURSOR);
        assert.match(page.next, /call youtube again with action "search", the same query, and cursor set to next_cursor/);
        assert.deepEqual(mock.seen[0].body, { query: "bittensor" });

        mock.reply(200, []);
        const second = await client.callTool({
            name: "youtube",
            arguments: { action: "search", query: "bittensor", cursor: page.next_cursor },
        });
        assert.deepEqual(mock.seen[1].body, { query: "bittensor", cursor: CURSOR });
        assert.deepEqual(JSON.parse(textOf(second)), {
            results: [],
            next_cursor: null,
            next: "Last page: there are no more results.",
        });

        mock.reply(200, [REDDIT_POST], { [NEXT_CURSOR_HEADER]: "reddit-2" });
        const reddit = await client.callTool({
            name: "reddit",
            arguments: { action: "search", query: "bittensor", sort: "new", cursor: CURSOR },
        });
        assert.deepEqual(mock.seen[2].body, { query: "bittensor", sort: "new", cursor: CURSOR });
        assert.equal(JSON.parse(textOf(reddit)).next_cursor, "reddit-2");

        // GET list routes: the cursor goes back as a query parameter, byte for byte.
        for (const [tool, args, target] of [
            ["youtube", { action: "comments", video_id: "dQw4w9WgXcQ", cursor: CURSOR }, "video_id"],
            ["youtube", { action: "channel_videos", handle: "@MrBeast", cursor: CURSOR }, "handle"],
            ["reddit", { action: "subreddit_posts", name: "AskReddit", cursor: CURSOR }, "name"],
            ["reddit", { action: "comments", post_id: "1q6pxwn", cursor: CURSOR }, "post_id"],
        ]) {
            mock.reply(200, [], { [NEXT_CURSOR_HEADER]: "following" });
            const result = await client.callTool({ name: tool, arguments: args });
            assert.equal(split(mock.seen.at(-1).path).query.cursor, CURSOR, `${tool} ${args.action}`);
            const payload = JSON.parse(textOf(result));
            assert.equal(payload.next_cursor, "following", `${tool} ${args.action}`);
            assert.ok(payload.next.includes(`the same ${target}`), `${tool} ${args.action}: ${payload.next}`);
        }
    });
});

test("Threads list actions return one page and no action takes a cursor", async () => {
    await withServer(async (client, mock) => {
        mock.reply(200, [THREADS_POST]);
        const result = await client.callTool({ name: "threads", arguments: { action: "profile_posts", username: "@zuck" } });
        assert.equal(mock.seen[0].path, "/desearch/threads/profile/zuck/posts");
        const page = JSON.parse(textOf(result));
        assert.equal(page.next_cursor, null);
        assert.equal(page.next, "This action returns one page and takes no cursor.");

        const listed = await client.listTools();
        const threads = listed.tools.find((tool) => tool.name === "threads");
        assert.equal(threads.inputSchema.properties.cursor, undefined);
        // The tool schema has no cursor, so a cursor is refused before any request.
        const refused = await client.callTool({ name: "threads", arguments: { action: "search", query: "x", cursor: CURSOR } });
        assert.equal(refused.isError, true);
        assert.match(textOf(refused), /Input validation error/);

        for (const [tool, args] of [
            ["youtube", { action: "video", id: "dQw4w9WgXcQ", cursor: CURSOR }],
            ["youtube", { action: "transcript", video_id: "dQw4w9WgXcQ", cursor: CURSOR }],
            ["reddit", { action: "post", id: "1q6pxwn", cursor: CURSOR }],
        ]) {
            const noCursor = await client.callTool({ name: tool, arguments: args });
            assert.equal(noCursor.isError, true, `${tool} ${args.action}`);
            assert.match(textOf(noCursor), /does not take cursor/, `${tool} ${args.action}`);
        }
        assert.equal(mock.seen.length, 1);
    });
});

test("each action names the argument it is missing, does not take, or has the wrong value for, before any request", async () => {
    await withServer(async (client, mock) => {
        const cases = [
            [
                "youtube",
                { action: "transcript", id: "dQw4w9WgXcQ" },
                'YouTube error: youtube action "transcript" needs video_id. youtube action "transcript" does not take id. transcript takes: video_id (required), language. No request was sent.',
            ],
            [
                "youtube",
                { action: "channel_videos", handle: "MrBeast", order: "top" },
                'YouTube error: youtube action "channel_videos" does not take order. channel_videos takes: handle (required), sort, cursor. No request was sent.',
            ],
            [
                "youtube",
                { action: "search", query: "x", sort: "latest" },
                'YouTube error: youtube action "search" does not take sort. search takes: query (required), type, upload_date, sort_by, duration, cursor. No request was sent.',
            ],
            [
                "reddit",
                { action: "search", query: "bittensor", sort: "hot" },
                'Reddit error: reddit action "search" takes sort relevance, new, top, comment_count, not "hot". search takes: query (required), sort, timeframe, cursor. No request was sent.',
            ],
            [
                "reddit",
                { action: "subreddit_posts", name: "AskReddit", sort: "relevance" },
                'Reddit error: reddit action "subreddit_posts" takes sort best, hot, new, top, rising, not "relevance". subreddit_posts takes: name (required), sort, timeframe, cursor. No request was sent.',
            ],
            [
                "reddit",
                { action: "comments", id: "1q6pxwn" },
                'Reddit error: reddit action "comments" needs post_id. reddit action "comments" does not take id. comments takes: post_id (required), cursor. No request was sent.',
            ],
            [
                "reddit",
                { action: "subreddit", name: " r/ " },
                'Reddit error: reddit action "subreddit" needs name. subreddit takes: name (required). No request was sent.',
            ],
            [
                "threads",
                { action: "search_users", query: "zuck", start_date: "2026-01-01" },
                'Threads error: threads action "search_users" does not take start_date. search_users takes: query (required). No request was sent.',
            ],
            [
                "threads",
                { action: "post" },
                'Threads error: threads action "post" needs id. post takes: id (required). No request was sent.',
            ],
        ];
        for (const [tool, args, message] of cases) {
            const result = await client.callTool({ name: tool, arguments: args });
            assert.equal(result.isError, true, JSON.stringify(args));
            assert.equal(textOf(result), message);
        }

        // Schema checks: unknown action or argument, enum values, date and language formats, query length.
        for (const [tool, args] of [
            ["youtube", {}],
            ["youtube", { action: "playlist", id: "1" }],
            ["youtube", { action: "search", query: "x", type: "video" }],
            ["youtube", { action: "search", query: "x", duration: "short" }],
            ["youtube", { action: "search", query: "x", count: 5 }],
            ["youtube", { action: "search", query: "x".repeat(501) }],
            ["youtube", { action: "transcript", video_id: "dQw4w9WgXcQ", language: "english" }],
            ["youtube", { action: "comments", video_id: "dQw4w9WgXcQ", order: "oldest" }],
            ["youtube", { action: "channel_videos", handle: "MrBeast", sort: "oldest" }],
            ["reddit", { action: "search", query: "x", sort: "controversial" }],
            ["reddit", { action: "search", query: "x", timeframe: "hour" }],
            ["reddit", { action: "subreddit", username: "AskReddit" }],
            ["reddit", { action: "comments", post_id: "1q6pxwn", cursor: "" }],
            ["threads", { action: "search", query: "x", start_date: "2026/01/01" }],
            ["threads", { action: "profile", username: "" }],
            ["threads", { action: "hashtag", tag: "ai" }],
        ]) {
            const result = await client.callTool({ name: tool, arguments: args });
            assert.equal(result.isError, true, JSON.stringify(args));
            assert.match(textOf(result), /Input validation error/, JSON.stringify(args));
        }
        assert.equal(mock.seen.length, 0);
    });
});

test("URL ids are encoded as one path value; @ and r/ prefixes are handled; null optional arguments are omitted", async () => {
    await withServer(async (client, mock) => {
        for (const [tool, args, path] of [
            [
                "youtube",
                { action: "video", id: "https://youtu.be/dQw4w9WgXcQ" },
                "/desearch/youtube/video/https%3A%2F%2Fyoutu.be%2FdQw4w9WgXcQ",
            ],
            [
                "youtube",
                { action: "transcript", video_id: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
                "/desearch/youtube/transcript/https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ",
            ],
            [
                "reddit",
                { action: "post", id: "https://www.reddit.com/r/webscraping/comments/1q6pxwn/" },
                "/desearch/reddit/post/https%3A%2F%2Fwww.reddit.com%2Fr%2Fwebscraping%2Fcomments%2F1q6pxwn%2F",
            ],
            [
                "threads",
                { action: "post", id: "https://www.threads.com/@zuck/post/DK-BydcJHkF" },
                "/desearch/threads/post/https%3A%2F%2Fwww.threads.com%2F%40zuck%2Fpost%2FDK-BydcJHkF",
            ],
            // The API takes a channel handle with or without @; it is sent as given.
            ["youtube", { action: "channel", handle: " @MrBeast " }, "/desearch/youtube/channel/%40MrBeast"],
            ["reddit", { action: "subreddit", name: "r/AskReddit" }, "/desearch/reddit/subreddit/AskReddit"],
            ["reddit", { action: "subreddit", name: "/r/AskReddit" }, "/desearch/reddit/subreddit/AskReddit"],
            ["threads", { action: "profile", username: "@zuck" }, "/desearch/threads/profile/zuck"],
            [
                "youtube",
                { action: "comments", video_id: "dQw4w9WgXcQ", order: null, cursor: null },
                "/desearch/youtube/comments/dQw4w9WgXcQ",
            ],
        ]) {
            mock.reply(200, {});
            const result = await client.callTool({ name: tool, arguments: args });
            assert.equal(result.isError, undefined, `${tool} ${args.action}: ${textOf(result)}`);
            assert.equal(mock.seen.at(-1).path, path, `${tool} ${args.action}`);
        }
    });
    // The same rules without a server.
    assert.deepEqual(socialRequest("reddit", { action: "subreddit_posts", name: "r/AskReddit", sort: "top" }), {
        spec: SOCIAL_ACTIONS.reddit.subreddit_posts,
        path: "/desearch/reddit/subreddit/AskReddit/posts",
        values: { sort: "top" },
    });
    assert.throws(() => socialRequest("reddit", { action: "search", query: "x", sort: "best" }), /takes sort relevance/);
});

test("YouTube, Reddit, and Threads API errors keep the HTTP status and the API detail", async () => {
    await withServer(async (client, mock) => {
        mock.reply(422, { detail: "Invalid request parameters" });
        const badCursor = await client.callTool({
            name: "reddit",
            arguments: { action: "comments", post_id: "1q6pxwn", cursor: "10" },
        });
        assert.equal(badCursor.isError, true);
        assert.equal(textOf(badCursor), "Reddit error: HTTP 422: Invalid request parameters");

        mock.reply(404, { detail: "Not Found" });
        const noCaptions = await client.callTool({ name: "youtube", arguments: { action: "transcript", video_id: "abc" } });
        assert.equal(textOf(noCaptions), "YouTube error: HTTP 404: Not Found");

        mock.reply(401, { detail: "Invalid API key" });
        const denied = await client.callTool({ name: "threads", arguments: { action: "profile", username: "zuck" } });
        assert.equal(textOf(denied), "Threads error: HTTP 401: Invalid API key");
    });
});

test("youtube, reddit, and threads need an API key and send nothing without one", async () => {
    await withServer(async (client, mock) => {
        for (const [name, args] of [
            ["youtube", { action: "video", id: "dQw4w9WgXcQ" }],
            ["reddit", { action: "subreddit", name: "AskReddit" }],
            ["threads", { action: "profile", username: "zuck" }],
        ]) {
            const result = await client.callTool({ name, arguments: args });
            assert.equal(result.isError, true, name);
            assert.match(textOf(result), /API key required/, name);
        }
        assert.equal(mock.seen.length, 0);
    }, "");
});
