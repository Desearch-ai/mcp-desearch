import assert from "node:assert/strict";
import test from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDesearchMcpServer } from "../build/server.js";
import { PEOPLE_SEARCH_FILTERS, compactPerson, peopleSearchBody, unverifiedCriteria } from "../build/people.js";

const API = "https://api.desearch.ai";
const TASK_ID = "3f1c2b9e-8d4a-4c1e-9b7a-2e5f6a7b8c9d";
const TASK_PATH = `/desearch/people/tasks/${TASK_ID}`;
const JSON_HEADERS = { headers: { "content-type": "application/json" } };

// Shapes follow desearch-public-api src/model/people.py (PeopleTask, Person, PeopleProfile).
const TASK = {
    task_id: TASK_ID,
    search_type: "tiktok_creator_search",
    platform: "tiktok",
    status: "running",
    stage: "searching",
    query: "Skincare creators who review sunscreen",
    count: 10,
    result_count: 2,
    metadata: {},
    interpreted: { criteria: ["reviews sunscreen"], queries: ["spf review"] },
    progress: { round: 1, candidates_processed: 12, qualified: 2 },
    errors: [],
    reserved_cost_usd: 0.5,
    final_cost_usd: null,
    refunded_usd: null,
    created_by: { user_id: null, api_key_id: "5b0c7f6e-1d2a-4b3c-8d9e-0f1a2b3c4d5e", via: "api_key" },
    created_at: "2026-10-17T10:00:00Z",
    started_at: "2026-10-17T10:00:02Z",
    paused_at: null,
    finished_at: null,
    results_expire_at: null,
    links: {
        self: TASK_PATH,
        results: `${TASK_PATH}/results`,
        export: `${TASK_PATH}/export`,
    },
};

const TIKTOK_PERSON = {
    id: "tiktok:glowwithmia",
    platform: "tiktok",
    handle: "glowwithmia",
    url: "https://www.tiktok.com/@glowwithmia",
    name: "Mia",
    avatar_url: "https://example.com/mia.jpg",
    bio: "Skincare reviews. SPF every day.",
    location: "United States",
    metrics: { followers: 48200, following: 310, likes: 1200000, videos: 240 },
    attributes: { verified: false, region: "US", language: "en" },
    links: [
        { type: "instagram", url: "https://instagram.com/glowwithmia", source: "tiktok_profile" },
        { type: "website", url: "", source: "tiktok_profile" },
    ],
    contacts: [{ type: "email", value: "mia@example.com", source_url: "https://www.tiktok.com/@glowwithmia" }],
    evidence: [
        {
            type: "video",
            url: "https://www.tiktok.com/@glowwithmia/video/1",
            text: "Testing five sunscreens",
            metrics: { views: 50000 },
        },
    ],
    score: {
        value: 88,
        qualified: true,
        summary: "Reviews sunscreen every week.",
        matched_signals: ["sunscreen reviews"],
        profile_fit: ["Skincare creator"],
        buying_triggers: ["Posts SPF comparisons"],
        evidence: ["Testing five sunscreens"],
        reasons: ["Skincare creator", "Posts SPF comparisons", "Testing five sunscreens", "Fourth reason"],
        concerns: [],
    },
};

const TIKTOK_COMPACT = {
    id: "tiktok:glowwithmia",
    platform: "tiktok",
    handle: "glowwithmia",
    name: "Mia",
    url: "https://www.tiktok.com/@glowwithmia",
    audience: 48200,
    location: "United States",
    verified: false,
    score: 88,
    why: "Reviews sunscreen every week.",
    reasons: ["Skincare creator", "Posts SPF comparisons", "Testing five sunscreens"],
    contacts: [{ type: "email", value: "mia@example.com" }],
    links: [{ type: "instagram", url: "https://instagram.com/glowwithmia" }],
    evidence_url: "https://www.tiktok.com/@glowwithmia/video/1",
};

const YOUTUBE_PERSON = {
    id: "youtube:@homebarista",
    platform: "youtube",
    handle: "@homebarista",
    url: "https://www.youtube.com/@homebarista",
    name: "Home Barista",
    location: null,
    metrics: { subscribers: 125000, videos: 300, views: 9000000 },
    attributes: { channel_id: "UC123", country: null },
    links: [],
    contacts: [],
    evidence: [],
    score: { value: 71, summary: null, reasons: [] },
};

function textOf(result) {
    assert.equal(result.content[0].type, "text");
    return result.content[0].text;
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

function readBody(opts) {
    const raw = opts.body;
    if (raw === undefined || raw === null) {
        return undefined;
    }
    return JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
}

function queryOf(path) {
    return Object.fromEntries(new URL(path, API).searchParams);
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
        /** Reply once to `method path` (path without query, or a predicate). */
        reply(method, path, status, body) {
            pool.intercept({
                method,
                path: typeof path === "function" ? path : (p) => p.split("?")[0] === path,
            }).reply(
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
                JSON_HEADERS
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
    const client = new Client({ name: "people", version: "0.0.1" });
    try {
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
        await fn(client, mock);
    } finally {
        await client.close();
        await server.close();
        await mock.restore();
    }
}

test("people-search starts a billed TikTok search with that platform's filters", async () => {
    await withServer(async (client, mock) => {
        mock.reply("POST", "/desearch/people/search/tiktok", 202, {
            ...TASK,
            status: "queued",
            stage: null,
            result_count: 0,
            progress: {},
            started_at: null,
            cost_usd: 0.5,
            usage_count: 10,
            service: "/desearch/people/search/tiktok",
            currency: "USD",
        });

        const result = await client.callTool({
            name: "people-search",
            arguments: {
                platform: "tiktok",
                query: "Skincare creators who review sunscreen",
                count: 10,
                min_score: 60,
                exclude: ["@spam_account"],
                idempotency_key: "search-1",
                min_followers: 10000,
                require_contact: true,
                keywords: ["spf"],
            },
        });
        assert.equal(result.isError, undefined, textOf(result));
        const body = JSON.parse(textOf(result));
        assert.equal(body.task_id, TASK_ID);
        assert.equal(body.platform, "tiktok");
        assert.equal(body.status, "queued");
        assert.equal(body.done, false);
        assert.equal(body.count, 10);
        assert.equal(body.result_count, 0);
        assert.equal(body.reserved_cost_usd, 0.5);
        assert.equal(body.cost_usd, 0.5);
        assert.equal(body.currency, "USD");
        assert.equal(body.existing_task, undefined);
        assert.match(body.next, /people-search-status/);
        assert.match(body.next, /1 to 5 minutes/);
        for (const dropped of ["links", "created_by", "interpreted", "search_type", "progress", "stage", "final_cost_usd"]) {
            assert.equal(Object.hasOwn(body, dropped), false, dropped);
        }

        assert.equal(mock.seen.length, 1);
        const [call] = mock.seen;
        assert.equal(call.method, "POST");
        assert.equal(call.path, "/desearch/people/search/tiktok");
        assert.deepEqual(call.body, {
            query: "Skincare creators who review sunscreen",
            count: 10,
            min_score: 60,
            exclude: ["@spam_account"],
            filters: { min_followers: 10000, require_contact: true, keywords: ["spf"] },
        });
        assert.equal(headerOf(call.headers, "authorization"), "test-key");
        assert.equal(headerOf(call.headers, "idempotency-key"), "search-1");
        assert.match(headerOf(call.headers, "content-type"), /application\/json/);
    });
});

test("people-search sends only the fields the caller set, per platform", async () => {
    await withServer(async (client, mock) => {
        mock.reply("POST", "/desearch/people/search/x", 202, { ...TASK, platform: "x", status: "queued" });
        mock.reply("POST", "/desearch/people/search/youtube", 202, { ...TASK, platform: "youtube", status: "queued" });
        mock.reply("POST", "/desearch/people/search/linkedin", 202, { ...TASK, platform: "linkedin", status: "queued" });

        const x = await client.callTool({
            name: "people-search",
            arguments: { platform: "x", query: "Indie hackers who share their MRR" },
        });
        assert.equal(x.isError, undefined, textOf(x));

        const youtube = await client.callTool({
            name: "people-search",
            arguments: {
                platform: "youtube",
                query: "Fitness creators who review supplements",
                min_subscribers: 10000,
                max_subscribers: 500000,
                countries: ["US"],
                require_contact: true,
                exclude_keywords: ["giveaway"],
            },
        });
        assert.equal(youtube.isError, undefined, textOf(youtube));

        const linkedin = await client.callTool({
            name: "people-search",
            arguments: {
                platform: "linkedin",
                query: "Heads of sales at fintech startups",
                count: 5,
                max_followers: 20000,
                countries: ["United States", "United Kingdom"],
            },
        });
        assert.equal(linkedin.isError, undefined, textOf(linkedin));

        assert.deepEqual(
            mock.seen.map((call) => [call.path, call.body, headerOf(call.headers, "idempotency-key")]),
            [
                ["/desearch/people/search/x", { query: "Indie hackers who share their MRR" }, undefined],
                [
                    "/desearch/people/search/youtube",
                    {
                        query: "Fitness creators who review supplements",
                        filters: {
                            min_subscribers: 10000,
                            max_subscribers: 500000,
                            countries: ["US"],
                            require_contact: true,
                            exclude_keywords: ["giveaway"],
                        },
                    },
                    undefined,
                ],
                [
                    "/desearch/people/search/linkedin",
                    {
                        query: "Heads of sales at fintech startups",
                        count: 5,
                        filters: { max_followers: 20000, countries: ["United States", "United Kingdom"] },
                    },
                    undefined,
                ],
            ]
        );
    });
});

test("people-search request bodies match the API models", () => {
    assert.deepEqual(peopleSearchBody({ platform: "x", query: "Indie hackers" }), { query: "Indie hackers" });
    assert.deepEqual(
        peopleSearchBody({
            platform: "x",
            query: "Indie hackers",
            verified_only: true,
            countries: ["US", "GB"],
            min_followers: 200,
        }),
        { query: "Indie hackers", filters: { min_followers: 200, verified_only: true, countries: ["US", "GB"] } }
    );
    assert.deepEqual(
        peopleSearchBody({
            platform: "youtube",
            query: "Fitness creators",
            min_subscribers: 10000,
            max_subscribers: 500000,
            countries: ["US"],
            require_contact: true,
            exclude_keywords: ["giveaway"],
        }),
        {
            query: "Fitness creators",
            filters: {
                min_subscribers: 10000,
                max_subscribers: 500000,
                countries: ["US"],
                require_contact: true,
                exclude_keywords: ["giveaway"],
            },
        }
    );
    assert.throws(
        () => peopleSearchBody({ platform: "tiktok", query: "Skincare", countries: ["US"], verified_only: true }),
        /^Error: verified_only, countries do not apply to tiktok\. tiktok filters: min_followers, max_followers, require_contact, keywords, exclude_keywords\. Nothing was charged\.$/
    );
    // Filter lists from XProfileSearchFilters, YouTubeCreatorSearchFilters,
    // LinkedInProfileSearchFilters, TikTokCreatorSearchFilters.
    assert.deepEqual(PEOPLE_SEARCH_FILTERS, {
        x: ["min_followers", "max_followers", "verified_only", "countries", "keywords", "exclude_keywords"],
        youtube: ["min_subscribers", "max_subscribers", "countries", "require_contact", "keywords", "exclude_keywords"],
        linkedin: ["min_followers", "max_followers", "countries", "keywords", "exclude_keywords"],
        tiktok: ["min_followers", "max_followers", "require_contact", "keywords", "exclude_keywords"],
    });
});

test("people-search marks a repeated idempotency_key as the first task, not a new charge", async () => {
    await withServer(async (client, mock) => {
        mock.reply("POST", "/desearch/people/search/tiktok", 200, {
            ...TASK,
            cost_usd: 0,
            usage_count: 10,
            currency: "USD",
        });
        const result = await client.callTool({
            name: "people-search",
            arguments: { platform: "tiktok", query: "Skincare creators", idempotency_key: "search-1" },
        });
        const body = JSON.parse(textOf(result));
        assert.equal(body.existing_task, true);
        assert.equal(body.cost_usd, 0);
        assert.equal(body.reserved_cost_usd, 0.5);
        assert.match(body.next, /not charged again/);
    });
});

test("people-search rejects bad input before any request", async () => {
    await withServer(async (client, mock) => {
        const wrongPlatformFilter = await client.callTool({
            name: "people-search",
            arguments: { platform: "youtube", query: "Fitness creators", min_followers: 1000 },
        });
        assert.equal(wrongPlatformFilter.isError, true);
        assert.equal(
            textOf(wrongPlatformFilter),
            "People Search error: min_followers does not apply to youtube. youtube filters: min_subscribers, max_subscribers, countries, require_contact, keywords, exclude_keywords. Nothing was charged."
        );

        for (const args of [
            { platform: "instagram", query: "Skincare creators" },
            { platform: "tiktok", query: "hi" },
            { platform: "tiktok", query: "Skincare creators", count: 4 },
            { platform: "tiktok", query: "Skincare creators", count: 201 },
            { platform: "tiktok", query: "Skincare creators", min_score: 101 },
            { platform: "tiktok", query: "Skincare creators", keywords: Array.from({ length: 21 }, (_, i) => `k${i}`) },
            { platform: "tiktok", query: "Skincare creators", filters: { min_followers: 1 } },
            { query: "Skincare creators" },
        ]) {
            const rejected = await client.callTool({ name: "people-search", arguments: args });
            assert.equal(rejected.isError, true, JSON.stringify(args));
            assert.match(textOf(rejected), /Input validation error/, JSON.stringify(args));
        }
        assert.equal(mock.seen.length, 0);
    });
});

test("people-search sends metadata labels and returns them on the task", async () => {
    await withServer(async (client, mock) => {
        const metadata = { campaign: "q4-outbound", "workspace.id": "ws_42" };
        mock.reply("POST", "/desearch/people/search/linkedin", 202, {
            ...TASK,
            platform: "linkedin",
            status: "queued",
            metadata,
        });
        mock.reply("POST", "/desearch/people/search/x", 202, { ...TASK, platform: "x", status: "queued" });

        const tagged = await client.callTool({
            name: "people-search",
            arguments: { platform: "linkedin", query: "Heads of sales at fintech startups", count: 5, metadata },
        });
        assert.equal(tagged.isError, undefined, textOf(tagged));
        assert.deepEqual(JSON.parse(textOf(tagged)).metadata, metadata);

        // An empty object is not sent, and the task's empty metadata is left out of the reply.
        const untagged = await client.callTool({
            name: "people-search",
            arguments: { platform: "x", query: "Indie hackers", metadata: {} },
        });
        assert.equal(untagged.isError, undefined, textOf(untagged));
        assert.equal(Object.hasOwn(JSON.parse(textOf(untagged)), "metadata"), false);

        assert.deepEqual(
            mock.seen.map((call) => [call.path, call.body]),
            [
                [
                    "/desearch/people/search/linkedin",
                    { query: "Heads of sales at fintech startups", count: 5, metadata },
                ],
                ["/desearch/people/search/x", { query: "Indie hackers" }],
            ]
        );
    });
});

test("people-search rejects bad metadata before the billed call", async () => {
    await withServer(async (client, mock) => {
        const elevenKeys = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, "v"]));
        for (const metadata of [
            { "Campaign": "q4" },
            { "has space": "q4" },
            { ["k".repeat(41)]: "q4" },
            { "": "q4" },
            { campaign: "v".repeat(201) },
            { campaign: 42 },
            elevenKeys,
            ["campaign"],
        ]) {
            const rejected = await client.callTool({
                name: "people-search",
                arguments: { platform: "tiktok", query: "Skincare creators", metadata },
            });
            assert.equal(rejected.isError, true, JSON.stringify(metadata));
            assert.match(textOf(rejected), /Input validation error/, JSON.stringify(metadata));
        }
        assert.equal(mock.seen.length, 0);

        mock.reply("POST", "/desearch/people/search/tiktok", 202, { ...TASK, status: "queued" });
        const tenKeys = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, "v".repeat(200)]));
        const accepted = await client.callTool({
            name: "people-search",
            arguments: { platform: "tiktok", query: "Skincare creators", metadata: tenKeys },
        });
        assert.equal(accepted.isError, undefined, textOf(accepted));
        assert.deepEqual(mock.seen[0].body.metadata, tenKeys);
    });
});

test("people-search reports API errors such as missing credits", async () => {
    await withServer(async (client, mock) => {
        mock.reply("POST", "/desearch/people/search/tiktok", 402, {
            detail: "People Search needs account credits. Add credits in the Desearch console to run a search.",
        });
        mock.reply("POST", "/desearch/people/search/tiktok", 429, {
            detail: "You already have 5 searches queued, running or paused. Wait for one to finish or cancel one, then try again. You were not charged.",
        });
        const noCredits = await client.callTool({
            name: "people-search",
            arguments: { platform: "tiktok", query: "Skincare creators" },
        });
        assert.equal(noCredits.isError, true);
        assert.equal(
            textOf(noCredits),
            "People Search error: HTTP 402: People Search needs account credits. Add credits in the Desearch console to run a search."
        );
        const busy = await client.callTool({
            name: "people-search",
            arguments: { platform: "tiktok", query: "Skincare creators" },
        });
        assert.match(textOf(busy), /^People Search error: HTTP 429: You already have 5 searches/);
    });
});

test("people-search-status returns the task and a compact page of people", async () => {
    await withServer(async (client, mock) => {
        mock.reply("GET", TASK_PATH, 200, TASK);
        mock.reply("GET", `${TASK_PATH}/results`, 200, {
            task_id: TASK_ID,
            status: "running",
            results: [TIKTOK_PERSON, YOUTUBE_PERSON],
            next_cursor: "2",
            has_more: false,
        });

        const result = await client.callTool({
            name: "people-search-status",
            arguments: { task_id: TASK_ID, cursor: "0", limit: 10 },
        });
        assert.equal(result.isError, undefined, textOf(result));
        const body = JSON.parse(textOf(result));
        assert.deepEqual(body, {
            task_id: TASK_ID,
            platform: "tiktok",
            status: "running",
            stage: "searching",
            done: false,
            query: "Skincare creators who review sunscreen",
            count: 10,
            result_count: 2,
            progress: { round: 1, candidates_processed: 12, qualified: 2 },
            reserved_cost_usd: 0.5,
            created_at: "2026-10-17T10:00:00Z",
            people: [
                TIKTOK_COMPACT,
                {
                    id: "youtube:@homebarista",
                    platform: "youtube",
                    handle: "@homebarista",
                    name: "Home Barista",
                    url: "https://www.youtube.com/@homebarista",
                    audience: 125000,
                    score: 71,
                },
            ],
            next_cursor: "2",
            has_more: false,
            next: 'Still searching. Wait 15 to 30 seconds, then call people-search-status again with cursor "2" to get only the people found since this call.',
        });

        assert.deepEqual(
            mock.seen.map((call) => [call.method, call.path.split("?")[0], queryOf(call.path)]),
            [
                ["GET", TASK_PATH, {}],
                ["GET", `${TASK_PATH}/results`, { cursor: "0", limit: "10" }],
            ]
        );
        assert.equal(headerOf(mock.seen[0].headers, "authorization"), "test-key");
    });
});

test("people-search-status says when more people are ready or the search is done", async () => {
    await withServer(async (client, mock) => {
        mock.reply("GET", TASK_PATH, 200, {
            ...TASK,
            status: "completed",
            stage: "finalizing",
            result_count: 30,
            final_cost_usd: 1.2,
            refunded_usd: 0.3,
            finished_at: "2026-10-17T10:04:00Z",
            results_expire_at: "2026-11-16T10:04:00Z",
        });
        mock.reply("GET", `${TASK_PATH}/results`, 200, {
            task_id: TASK_ID,
            status: "completed",
            results: [TIKTOK_PERSON],
            next_cursor: "25",
            has_more: true,
        });
        mock.reply("GET", TASK_PATH, 200, { ...TASK, status: "completed", result_count: 30 });
        mock.reply("GET", `${TASK_PATH}/results`, 200, {
            task_id: TASK_ID,
            status: "completed",
            results: [TIKTOK_PERSON],
            next_cursor: "30",
            has_more: false,
        });

        const first = JSON.parse(
            textOf(await client.callTool({ name: "people-search-status", arguments: { task_id: TASK_ID } }))
        );
        assert.equal(first.done, true);
        assert.equal(first.final_cost_usd, 1.2);
        assert.equal(first.refunded_usd, 0.3);
        assert.equal(first.results_expire_at, "2026-11-16T10:04:00Z");
        assert.equal(first.has_more, true);
        assert.equal(first.next, 'More people are ready now: call people-search-status again with cursor "25".');

        const second = JSON.parse(
            textOf(
                await client.callTool({
                    name: "people-search-status",
                    arguments: { task_id: TASK_ID, cursor: first.next_cursor },
                })
            )
        );
        assert.equal(second.next_cursor, "30");
        assert.equal(second.next, "Finished. You have every person this search found.");

        // Default page size is 25; the cursor is omitted on the first read.
        assert.deepEqual(queryOf(mock.seen[1].path), { limit: "25" });
        assert.deepEqual(queryOf(mock.seen[3].path), { cursor: "25", limit: "25" });
    });
});

test("people-search-status skips the results call when there is nothing to read", async () => {
    await withServer(async (client, mock) => {
        mock.reply("GET", TASK_PATH, 200, { ...TASK, status: "queued", stage: null, result_count: 0, progress: {} });
        mock.reply("GET", TASK_PATH, 200, { ...TASK, status: "expired", result_count: 12 });
        mock.reply("GET", TASK_PATH, 200, { ...TASK, status: "paused" });
        mock.reply("GET", TASK_PATH, 200, {
            ...TASK,
            status: "failed",
            result_count: 0,
            errors: [{ code: "search_unavailable", message: "Every search failed.", at: "2026-10-17T10:01:00Z" }],
        });

        const queued = JSON.parse(
            textOf(await client.callTool({ name: "people-search-status", arguments: { task_id: TASK_ID } }))
        );
        assert.deepEqual(queued.people, []);
        assert.equal(queued.next_cursor, "0");
        assert.equal(queued.has_more, false);
        assert.equal(Object.hasOwn(queued, "progress"), false);
        assert.match(queued.next, /^Still searching\./);

        const expired = JSON.parse(
            textOf(await client.callTool({ name: "people-search-status", arguments: { task_id: TASK_ID, cursor: "7" } }))
        );
        assert.equal(expired.done, true);
        assert.deepEqual(expired.people, []);
        assert.equal(expired.next_cursor, "7");
        assert.equal(expired.next, "Results expired 30 days after the search ended.");

        const statusOnly = JSON.parse(
            textOf(
                await client.callTool({
                    name: "people-search-status",
                    arguments: { task_id: TASK_ID, include_people: false },
                })
            )
        );
        assert.equal(statusOnly.status, "paused");
        assert.equal(Object.hasOwn(statusOnly, "people"), false);
        assert.equal(Object.hasOwn(statusOnly, "next_cursor"), false);
        assert.match(statusOnly.next, /resume/);

        const failed = JSON.parse(
            textOf(await client.callTool({ name: "people-search-status", arguments: { task_id: TASK_ID } }))
        );
        assert.deepEqual(failed.errors, [
            { code: "search_unavailable", message: "Every search failed.", at: "2026-10-17T10:01:00Z" },
        ]);
        assert.match(failed.next, /not charged/);

        assert.deepEqual(
            mock.seen.map((call) => call.path),
            [TASK_PATH, TASK_PATH, TASK_PATH, TASK_PATH]
        );
    });
});

test("people-search-status reports a missing task and rejects a malformed task_id", async () => {
    await withServer(async (client, mock) => {
        mock.reply("GET", TASK_PATH, 404, { detail: "Task not found" });
        const missing = await client.callTool({ name: "people-search-status", arguments: { task_id: TASK_ID } });
        assert.equal(missing.isError, true);
        assert.equal(textOf(missing), "People Search Status error: HTTP 404: Task not found");

        for (const args of [{ task_id: "../search/x" }, { task_id: TASK_ID, limit: 101 }, {}]) {
            const rejected = await client.callTool({ name: "people-search-status", arguments: args });
            assert.equal(rejected.isError, true, JSON.stringify(args));
            assert.match(textOf(rejected), /Input validation error/, JSON.stringify(args));
        }
        assert.equal(mock.seen.length, 1);
    });
});

test("people-search-pause, people-search-resume, and people-search-cancel change a task", async () => {
    await withServer(async (client, mock) => {
        mock.reply("POST", `${TASK_PATH}/pause`, 200, { ...TASK, status: "pausing" });
        mock.reply("POST", `${TASK_PATH}/resume`, 200, { ...TASK, status: "queued", stage: null });
        mock.reply("POST", `${TASK_PATH}/cancel`, 200, { ...TASK, status: "cancelling" });
        mock.reply("POST", `${TASK_PATH}/resume`, 409, {
            detail: "Only paused searches can be resumed.",
            task: { ...TASK, status: "running" },
        });

        const paused = JSON.parse(
            textOf(await client.callTool({ name: "people-search-pause", arguments: { task_id: TASK_ID } }))
        );
        assert.equal(paused.status, "pausing");
        assert.equal(paused.done, false);
        assert.match(paused.next, /^Pausing after the current batch/);

        const resumed = JSON.parse(
            textOf(await client.callTool({ name: "people-search-resume", arguments: { task_id: TASK_ID } }))
        );
        assert.equal(resumed.status, "queued");
        assert.equal(resumed.next, "Still searching. Wait 15 to 30 seconds, then call people-search-status again.");

        const cancelled = JSON.parse(
            textOf(await client.callTool({ name: "people-search-cancel", arguments: { task_id: TASK_ID } }))
        );
        assert.equal(cancelled.status, "cancelling");
        assert.equal(Object.hasOwn(cancelled, "progress"), false);

        const conflict = await client.callTool({
            name: "people-search-resume",
            arguments: { task_id: TASK_ID },
        });
        assert.equal(conflict.isError, true);
        assert.equal(
            textOf(conflict),
            "People Search Resume error: HTTP 409: Only paused searches can be resumed. Task status: running."
        );

        for (const name of ["people-search-pause", "people-search-resume", "people-search-cancel"]) {
            for (const args of [{ task_id: TASK_ID, action: "pause" }, { task_id: TASK_ID, extra: true }, { task_id: "not-a-uuid" }, {}]) {
                const rejected = await client.callTool({ name, arguments: args });
                assert.equal(rejected.isError, true, `${name} ${JSON.stringify(args)}`);
                assert.match(textOf(rejected), /Input validation error/, `${name} ${JSON.stringify(args)}`);
            }
        }

        const { tools } = await client.listTools();
        assert.equal(tools.some((tool) => tool.name === "people-search-control"), false);

        assert.deepEqual(
            mock.seen.map((call) => [call.method, call.path, call.body]),
            [
                ["POST", `${TASK_PATH}/pause`, undefined],
                ["POST", `${TASK_PATH}/resume`, undefined],
                ["POST", `${TASK_PATH}/cancel`, undefined],
                ["POST", `${TASK_PATH}/resume`, undefined],
            ]
        );
    });
});

test("people-search-tasks lists tasks with platform and status filters", async () => {
    await withServer(async (client, mock) => {
        mock.reply("GET", "/desearch/people/tasks", 200, { tasks: [TASK], next_cursor: "MjAyNi0xMC0xN3wz" });
        mock.reply("GET", "/desearch/people/tasks", 200, { tasks: [], next_cursor: null });

        const filtered = JSON.parse(
            textOf(
                await client.callTool({
                    name: "people-search-tasks",
                    arguments: { platform: "tiktok", status: ["running", "paused"], limit: 5, cursor: "abc" },
                })
            )
        );
        assert.deepEqual(filtered, {
            tasks: [
                {
                    task_id: TASK_ID,
                    platform: "tiktok",
                    status: "running",
                    stage: "searching",
                    done: false,
                    query: "Skincare creators who review sunscreen",
                    count: 10,
                    result_count: 2,
                    reserved_cost_usd: 0.5,
                    created_at: "2026-10-17T10:00:00Z",
                },
            ],
            next_cursor: "MjAyNi0xMC0xN3wz",
        });

        const all = JSON.parse(textOf(await client.callTool({ name: "people-search-tasks", arguments: {} })));
        assert.deepEqual(all, { tasks: [], next_cursor: null });

        assert.deepEqual(queryOf(mock.seen[0].path), {
            platform: "tiktok",
            status: "running,paused",
            limit: "5",
            cursor: "abc",
        });
        assert.equal(mock.seen[1].path, "/desearch/people/tasks");

        const rejected = await client.callTool({ name: "people-search-tasks", arguments: { status: ["done"] } });
        assert.equal(rejected.isError, true);
        assert.match(textOf(rejected), /Input validation error/);
    });
});

test("people-search-tasks filters by metadata as metadata.<key> query parameters", async () => {
    await withServer(async (client, mock) => {
        const metadata = { campaign: "q4 outbound & more", "team.id": "t-1" };
        mock.reply("GET", "/desearch/people/tasks", 200, {
            tasks: [{ ...TASK, status: "completed", metadata }],
            next_cursor: null,
        });

        const listed = JSON.parse(
            textOf(
                await client.callTool({
                    name: "people-search-tasks",
                    arguments: { status: ["completed"], metadata },
                })
            )
        );
        assert.deepEqual(listed.tasks[0].metadata, metadata);
        assert.equal(listed.next_cursor, null);
        assert.equal(
            mock.seen[0].path,
            "/desearch/people/tasks?status=completed&metadata.campaign=q4+outbound+%26+more&metadata.team.id=t-1"
        );
        assert.deepEqual(queryOf(mock.seen[0].path), {
            status: "completed",
            "metadata.campaign": "q4 outbound & more",
            "metadata.team.id": "t-1",
        });

        for (const filter of [{ a: "1", b: "2", c: "3", d: "4" }, { "Bad Key": "x" }, { campaign: "v".repeat(201) }]) {
            const rejected = await client.callTool({ name: "people-search-tasks", arguments: { metadata: filter } });
            assert.equal(rejected.isError, true, JSON.stringify(filter));
            assert.match(textOf(rejected), /Input validation error/, JSON.stringify(filter));
        }
        assert.equal(mock.seen.length, 1);
    });
});

test("people-profiles sends the result filters as query parameters", async () => {
    await withServer(async (client, mock) => {
        const foundBy = {
            task_id: TASK_ID,
            query: "Skincare creators who review sunscreen",
            found_at: "2026-10-17T10:02:00Z",
            times_found: 2,
        };
        mock.reply("GET", "/desearch/people/profiles", 200, {
            profiles: [{ ...TIKTOK_PERSON, found_by: foundBy }],
            total: 31,
            next_cursor: "30",
        });
        mock.reply("GET", "/desearch/people/profiles", 200, { profiles: [], total: 0, next_cursor: null });

        const filtered = JSON.parse(
            textOf(
                await client.callTool({
                    name: "people-profiles",
                    arguments: {
                        platform: "tiktok",
                        q: "skincare",
                        sort: "audience",
                        limit: 10,
                        cursor: "20",
                        has: ["email", "instagram"],
                        min_audience: 1000,
                        max_audience: 500000,
                        min_score: 60,
                        location: "united states",
                        verified: true,
                    },
                })
            )
        );
        assert.deepEqual(filtered, {
            total: 31,
            next_cursor: "30",
            profiles: [{ ...TIKTOK_COMPACT, found_by: foundBy }],
        });

        const defaults = JSON.parse(
            textOf(await client.callTool({ name: "people-profiles", arguments: { platform: "youtube" } }))
        );
        assert.deepEqual(defaults, { total: 0, next_cursor: null, profiles: [] });

        assert.deepEqual(
            mock.seen.map((call) => [call.path.split("?")[0], queryOf(call.path)]),
            [
                [
                    "/desearch/people/profiles",
                    {
                        platform: "tiktok",
                        q: "skincare",
                        sort: "audience",
                        limit: "10",
                        cursor: "20",
                        has: "email,instagram",
                        min_audience: "1000",
                        max_audience: "500000",
                        min_score: "60",
                        location: "united states",
                        verified: "true",
                    },
                ],
                ["/desearch/people/profiles", { platform: "youtube", limit: "25" }],
            ]
        );

        for (const args of [
            {},
            { platform: "tiktok", has: ["facebook"] },
            { platform: "tiktok", sort: "followers" },
            { platform: "tiktok", limit: 201 },
            { platform: "tiktok", min_score: -1 },
        ]) {
            const rejected = await client.callTool({ name: "people-profiles", arguments: args });
            assert.equal(rejected.isError, true, JSON.stringify(args));
            assert.match(textOf(rejected), /Input validation error/, JSON.stringify(args));
        }
        assert.equal(mock.seen.length, 2);
    });
});

test("compactPerson keeps who, audience, fit, and contact fields and drops the rest", () => {
    assert.deepEqual(compactPerson(TIKTOK_PERSON), TIKTOK_COMPACT);
    assert.deepEqual(
        compactPerson({
            id: "linkedin:jane",
            platform: "linkedin",
            handle: "jane",
            url: "https://www.linkedin.com/in/jane",
            name: "Jane Doe",
            location: "London",
            metrics: { followers: 900, connections: 500 },
            attributes: { headline: "Head of Sales", company: "Acme", experience: [{ title: "AE" }] },
            links: [{ type: "linkedin", url: "https://www.linkedin.com/in/jane", source: "linkedin_profile" }],
            contacts: [],
            evidence: [{ type: "profile", url: null }, { type: "post", url: "https://www.linkedin.com/posts/1" }],
            score: { value: 64.5, summary: "Posts about outbound." },
        }),
        {
            id: "linkedin:jane",
            platform: "linkedin",
            handle: "jane",
            name: "Jane Doe",
            url: "https://www.linkedin.com/in/jane",
            audience: 900,
            location: "London",
            headline: "Head of Sales",
            company: "Acme",
            score: 64.5,
            why: "Posts about outbound.",
            links: [{ type: "linkedin", url: "https://www.linkedin.com/in/jane" }],
            evidence_url: "https://www.linkedin.com/posts/1",
        }
    );
    assert.deepEqual(compactPerson(null), {});
});

// Shapes from a real prod LinkedIn task (2026-10-20) and api.desearch.ai/openapi.json:
// PeopleTask.completion_reason / coverage_limited / warnings, PeopleScore.criteria_checks /
// fully_verified, Person.attributes.enrichment / enrichment_error.
const LINKEDIN_WARNING = {
    code: "partial_enrichment",
    platform: "linkedin",
    attempted: 20,
    enriched: 13,
    failed: 7,
    by_reason: { not_found: 7 },
    message:
        '7 of 20 LinkedIn profiles could not be read after search; those candidates were scored on search data only, and results among them have attributes.enrichment = "failed".',
};

const LINKEDIN_CHECKS = [
    {
        criterion: "Profile fit: Software Engineer based in Georgia",
        verdict: "met",
        quote: "Software Engineer at EPAM Systems",
        source_url: "https://www.linkedin.com/in/ana",
        reason: "Role and Tbilisi location supplied.",
    },
    {
        criterion: "Topic signal: coding or development work",
        verdict: "met",
        quote: "Experienced Web Developer",
        source_url: "https://www.linkedin.com/in/ana",
        reason: "Development work explicitly stated.",
    },
    {
        criterion: "Disqualifier: exclude recruiters, talent acquisition professionals, non-engineering managers",
        verdict: "unknown",
        quote: null,
        source_url: null,
        reason: "",
    },
];

function linkedinPerson(handle, overrides = {}) {
    return {
        id: `linkedin:${handle}`,
        platform: "linkedin",
        handle,
        url: `https://www.linkedin.com/in/${handle}`,
        name: handle,
        location: "Tbilisi, Georgia",
        metrics: { followers: 300 },
        attributes: { headline: "Software Engineer at EPAM Systems", company: "EPAM Systems", enrichment: "ok" },
        links: [],
        contacts: [],
        evidence: [],
        score: { value: 80, summary: "Engineer in Tbilisi.", criteria_checks: LINKEDIN_CHECKS, fully_verified: true },
        ...overrides,
    };
}

test("people-search-status shows why the search ended, its warnings, and what each person confirms", async () => {
    await withServer(async (client, mock) => {
        mock.reply("GET", TASK_PATH, 200, {
            ...TASK,
            search_type: "linkedin_profile_search",
            platform: "linkedin",
            status: "completed",
            stage: null,
            count: 5,
            result_count: 2,
            completion_reason: "count_reached",
            coverage_limited: false,
            warnings: [LINKEDIN_WARNING],
        });
        mock.reply("GET", `${TASK_PATH}/results`, 200, {
            task_id: TASK_ID,
            status: "completed",
            results: [
                linkedinPerson("ana"),
                linkedinPerson("giorgi", {
                    location: null,
                    attributes: { enrichment: "failed", enrichment_error: "not_found" },
                    score: {
                        value: 72,
                        criteria_checks: [
                            { ...LINKEDIN_CHECKS[0], verdict: "unknown", quote: null, source_url: null },
                            { ...LINKEDIN_CHECKS[1], verdict: "not_met", quote: null, source_url: null },
                            { ...LINKEDIN_CHECKS[2], verdict: "met", quote: "Talent partner" },
                        ],
                        fully_verified: false,
                    },
                }),
            ],
            next_cursor: "2",
            has_more: false,
        });

        const body = JSON.parse(
            textOf(await client.callTool({ name: "people-search-status", arguments: { task_id: TASK_ID } }))
        );
        assert.equal(body.completion_reason, "count_reached");
        assert.equal("coverage_limited" in body, false);
        assert.deepEqual(body.warnings, [
            { code: "partial_enrichment", platform: "linkedin", attempted: 20, failed: 7, by_reason: { not_found: 7 } },
        ]);
        const [ana, giorgi] = body.people;
        assert.equal(ana.fully_verified, true);
        assert.equal("unverified_criteria" in ana, false);
        assert.equal("enrichment" in ana, false);
        assert.equal(giorgi.fully_verified, false);
        assert.deepEqual(giorgi.unverified_criteria, [
            "Profile fit: Software Engineer based in Georgia (unknown)",
            "Topic signal: coding or development work (not met)",
            "Disqualifier: exclude recruiters, talent acquisition professionals, non-engineering managers (applies)",
        ]);
        assert.equal(giorgi.enrichment, "failed");
        assert.equal(giorgi.enrichment_error, "not_found");
        assert.equal(body.next, "Finished. You have every person this search found.");
    });
});

test("people-search-status says when a budget or an empty search ended the task", async () => {
    await withServer(async (client, mock) => {
        const ended = { ...TASK, status: "completed", stage: null, result_count: 0, warnings: [] };
        mock.reply("GET", TASK_PATH, 200, {
            ...ended,
            count: 50,
            result_count: 12,
            completion_reason: "cost_limit",
            coverage_limited: true,
        });
        mock.reply("GET", TASK_PATH, 200, { ...ended, completion_reason: "no_candidates", coverage_limited: false });
        mock.reply("GET", TASK_PATH, 200, { ...ended, completion_reason: "zero_qualified", coverage_limited: false });
        mock.reply("GET", TASK_PATH, 200, { ...TASK, completion_reason: null, coverage_limited: false, warnings: [] });

        const read = async () =>
            JSON.parse(
                textOf(
                    await client.callTool({
                        name: "people-search-status",
                        arguments: { task_id: TASK_ID, include_people: false },
                    })
                )
            );
        const limited = await read();
        assert.equal(limited.completion_reason, "cost_limit");
        assert.equal(limited.coverage_limited, true);
        assert.equal("warnings" in limited, false);
        assert.equal(
            limited.next,
            "Finished early: a budget stopped it (cost_limit) before it found 50 people, so more people may match. You have every person it found."
        );
        assert.equal((await read()).next, "Finished: its searches found nobody to check. Try a broader description.");
        assert.equal(
            (await read()).next,
            "Finished: it checked the people its searches found and none fit. Try a broader description."
        );
        const running = await read();
        assert.equal("completion_reason" in running, false);
        assert.equal("coverage_limited" in running, false);
        assert.equal(running.done, false);
        assert.equal(mock.seen.length, 4);
    });
});

test("people-search-tasks shows each task's completion reason and coverage", async () => {
    await withServer(async (client, mock) => {
        mock.reply("GET", "/desearch/people/tasks", 200, {
            tasks: [
                { ...TASK, status: "completed", completion_reason: "candidate_budget", coverage_limited: true, warnings: [] },
                { ...TASK, status: "completed", completion_reason: "count_reached", coverage_limited: false, warnings: [] },
            ],
            next_cursor: null,
        });
        const body = JSON.parse(textOf(await client.callTool({ name: "people-search-tasks", arguments: {} })));
        assert.deepEqual(
            body.tasks.map((task) => [task.completion_reason, task.coverage_limited]),
            [
                ["candidate_budget", true],
                ["count_reached", undefined],
            ]
        );
    });
});

test("unverifiedCriteria follows the CSV rule, labels each verdict, and stays short", () => {
    assert.deepEqual(unverifiedCriteria({ criteria_checks: LINKEDIN_CHECKS }), []);
    assert.deepEqual(unverifiedCriteria({}), []);
    assert.deepEqual(unverifiedCriteria(null), []);
    assert.deepEqual(unverifiedCriteria({ criteria_checks: "not a list" }), []);

    const long = "Evidence quality: " + "posts about software projects and engineering practices ".repeat(4);
    const checks = [
        { criterion: long, verdict: "unknown" },
        { criterion: "Topic signal: one", verdict: "not_met" },
        { criterion: "Topic signal: two", verdict: "unknown" },
        { criterion: "Topic signal: three", verdict: "unknown" },
        { criterion: "Disqualifier: exclude agencies", verdict: "met" },
        { criterion: "Disqualifier: exclude students", verdict: "not_met" },
        { criterion: "Topic signal: four", verdict: "unknown" },
        { criterion: "Topic signal: five", verdict: "unknown" },
        { criterion: "", verdict: "unknown" },
        { verdict: "unknown" },
    ];
    const listed = unverifiedCriteria({ criteria_checks: checks });
    assert.equal(listed.length, 6);
    assert.equal(listed[0].length, 120 + " (unknown)".length);
    assert.ok(listed[0].endsWith("... (unknown)"));
    assert.deepEqual(listed.slice(1), [
        "Topic signal: one (not met)",
        "Topic signal: two (unknown)",
        "Topic signal: three (unknown)",
        "Disqualifier: exclude agencies (applies)",
        "and 2 more",
    ]);
});

test("compactPerson leaves results scored before criteria checks unchanged", () => {
    assert.deepEqual(compactPerson(TIKTOK_PERSON), TIKTOK_COMPACT);
    const failedWithoutReason = compactPerson(
        linkedinPerson("nino", { attributes: { enrichment: "failed" }, score: { value: 70, fully_verified: null } })
    );
    assert.equal(failedWithoutReason.enrichment, "failed");
    assert.equal("enrichment_error" in failedWithoutReason, false);
    assert.equal("fully_verified" in failedWithoutReason, false);
});

test("task warnings with a code this server does not know keep the API message", async () => {
    await withServer(async (client, mock) => {
        mock.reply("GET", TASK_PATH, 200, {
            ...TASK,
            warnings: [{ code: "slow_provider", platform: "x", message: "X search was slow; fewer queries ran." }],
        });
        const body = JSON.parse(
            textOf(
                await client.callTool({
                    name: "people-search-status",
                    arguments: { task_id: TASK_ID, include_people: false },
                })
            )
        );
        assert.deepEqual(body.warnings, [
            { code: "slow_provider", platform: "x", message: "X search was slow; fewer queries ran." },
        ]);
    });
});

test("unverifiedCriteria reads is_disqualifier before the keyword rule", () => {
    assert.deepEqual(
        unverifiedCriteria({
            criteria_checks: [
                // The flag wins over the wording, both ways.
                { criterion: "Profile fit: excluding agencies is fine", verdict: "met", is_disqualifier: false },
                { criterion: "Agency owners", verdict: "met", is_disqualifier: true },
                { criterion: "Disqualifier: students", verdict: "unknown", is_disqualifier: true },
                // No flag (scored before it existed) or null: the keyword rule.
                { criterion: "Disqualifier: recruiters", verdict: "met" },
                { criterion: "Not qualified leads", verdict: "met", is_disqualifier: null },
                { criterion: "Topic signal: excludes nothing", verdict: "met" },
            ],
        }),
        ["Agency owners (applies)", "Disqualifier: recruiters (applies)", "Not qualified leads (applies)"]
    );
});
