import assert from "node:assert/strict";
import test from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDesearchMcpServer } from "../build/server.js";
import {
    compactMonitorItem,
    monitorCreateBody,
    monitorEstimateBody,
    monitorNextStep,
    monitorOptions,
    monitorRunNextStep,
    monitorUpdateBody,
} from "../build/monitors.js";

const API = "https://api.desearch.ai";
const MONITOR_ID = "6f1d0c9e-0d55-4b8e-9a3c-3c4d9b8e2a10";
const RUN_ID = "0c6a7b1e-2f3d-4c5b-8a9e-1d2c3b4a5f60";
const MONITOR_PATH = `/desearch/monitors/${MONITOR_ID}`;
const JSON_HEADERS = { headers: { "content-type": "application/json" } };

// Shapes follow desearch-public-api docs/monitors.md and src/model/monitors.py.
const MONITOR = {
    monitor_id: MONITOR_ID,
    name: "Bittensor subnet news",
    query: "Bittensor subnet launches and updates",
    criteria: ["Announces a new subnet, release or partnership"],
    sources: ["web", "x", "reddit", "youtube"],
    interval: "1d",
    options: { x: { count: 20, lang: "en", min_likes: 0 }, web: { count: 10 } },
    min_score: 60,
    summary: false,
    status: "active",
    paused_reason: null,
    webhook: {
        url: "https://example.com/hooks/desearch",
        events: ["monitor.items.found", "monitor.run.failed"],
        consecutive_failures: 0,
    },
    metadata: { team: "growth" },
    max_run_cost_usd: 0.0098,
    next_run_at: "2026-11-04T09:00:00Z",
    last_run: null,
    stats: { runs: 0, items: 0, spent_usd: 0 },
    created_at: "2026-11-03T09:00:00Z",
    updated_at: "2026-11-03T09:00:00Z",
};

const RUN = {
    run_id: RUN_ID,
    monitor_id: MONITOR_ID,
    trigger: "manual",
    status: "completed",
    fail_reason: null,
    window_start: "2026-11-02T09:00:00Z",
    window_end: "2026-11-03T09:00:00Z",
    item_count: 2,
    stats: {
        sources: {
            x: { fetched: 20, in_window: 18, new: 7, passed: 1, error: null },
            web: { fetched: 10, in_window: 10, new: 6, passed: 1, error: null },
        },
        screened: 13,
        passed: 2,
        screen: "jev",
    },
    summary: null,
    reserved_usd: 0.0098,
    cost_usd: 0.0041,
    created_at: "2026-11-03T09:00:00Z",
    started_at: "2026-11-03T09:00:02Z",
    finished_at: "2026-11-03T09:00:41Z",
};

const X_ITEM = {
    item_id: "1842",
    run_id: RUN_ID,
    source: "x",
    url: "https://x.com/opentensor/status/2117000000000000000",
    title: null,
    text: "Subnet 64 is live on mainnet",
    author: { name: "Opentensor", handle: "opentensor", url: "https://x.com/opentensor" },
    published_at: "2026-11-03T08:12:00Z",
    score: 91,
    signals: { relevant: 0.91, new_info: 0.84 },
    found_at: "2026-11-03T09:00:41Z",
    data: { likes: 120, reposts: 14, replies: 9, views: 5400 },
};

const WEB_ITEM = {
    item_id: "1841",
    run_id: RUN_ID,
    source: "web",
    url: "https://example.org/news/subnet-64",
    title: "Subnet 64 launches",
    text: "x".repeat(1500),
    author: null,
    published_at: "2026-11-03T07:00:00Z",
    score: 72,
    signals: { relevant: 0.8, new_info: 0.72 },
    found_at: "2026-11-03T09:00:41Z",
    data: { domain: "example.org", highlights: ["Subnet 64 launched on mainnet today."] },
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
        /** Reply once to `method path` (path without query). */
        reply(method, path, status, body) {
            pool.intercept({ method, path: (p) => p.split("?")[0] === path }).reply(
                status,
                (opts) => {
                    seen.push({ method: opts.method, path: opts.path, headers: opts.headers, body: readBody(opts) });
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

async function withServer(fn, apiKey = "test-key") {
    const mock = installMock();
    const server = createDesearchMcpServer(apiKey);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "monitors", version: "0.0.1" });
    try {
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
        await fn(client, mock);
    } finally {
        await client.close();
        await server.close();
        await mock.restore();
    }
}

async function call(client, name, args) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, textOf(result));
    return JSON.parse(textOf(result));
}

async function rejects(client, name, args, pattern = /Input validation error/) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.match(textOf(result), pattern, `${name} ${JSON.stringify(args)}`);
}

test("monitor-create sends the settings with options and webhook nested, and says to store the secret", async () => {
    await withServer(async (client, mock) => {
        mock.reply("POST", "/desearch/monitors", 201, { ...MONITOR, webhook_secret: "whsec_abc" });

        const body = await call(client, "monitor-create", {
            query: "Bittensor subnet launches and updates",
            name: "Bittensor subnet news",
            criteria: ["Announces a new subnet, release or partnership"],
            sources: ["web", "x", "reddit", "youtube"],
            interval: "1d",
            web_count: 10,
            x_count: 20,
            x_lang: "en",
            x_min_likes: 0,
            min_score: 60,
            summary: false,
            webhook_url: "https://example.com/hooks/desearch",
            webhook_events: ["monitor.items.found", "monitor.run.failed"],
            metadata: { team: "growth" },
        });
        assert.equal(body.monitor_id, MONITOR_ID);
        assert.equal(body.webhook_secret, "whsec_abc");
        assert.equal(body.max_run_cost_usd, 0.0098);
        assert.match(body.next, /first run is queued/);
        assert.match(body.next, /Store webhook_secret now/);
        assert.match(body.next, /Desearch-Signature/);

        assert.equal(mock.seen.length, 1);
        const [sent] = mock.seen;
        assert.equal(sent.method, "POST");
        assert.equal(sent.path, "/desearch/monitors");
        assert.deepEqual(sent.body, {
            query: "Bittensor subnet launches and updates",
            name: "Bittensor subnet news",
            criteria: ["Announces a new subnet, release or partnership"],
            sources: ["web", "x", "reddit", "youtube"],
            interval: "1d",
            options: { web: { count: 10 }, x: { count: 20, lang: "en", min_likes: 0 } },
            min_score: 60,
            summary: false,
            webhook: {
                url: "https://example.com/hooks/desearch",
                events: ["monitor.items.found", "monitor.run.failed"],
            },
            metadata: { team: "growth" },
        });
        assert.equal(headerOf(sent.headers, "authorization"), "test-key");
        assert.match(headerOf(sent.headers, "content-type"), /application\/json/);
    });
});

test("monitor-create sends only the query when nothing else is set, and run_now false says how to run it", async () => {
    await withServer(async (client, mock) => {
        mock.reply("POST", "/desearch/monitors", 201, { ...MONITOR, webhook: null });
        mock.reply("POST", "/desearch/monitors", 201, { ...MONITOR, webhook: null });

        const first = await call(client, "monitor-create", { query: "OpenAI launches" });
        assert.match(first.next, /first run is queued/);
        assert.doesNotMatch(first.next, /webhook_secret/);
        const second = await call(client, "monitor-create", { query: "OpenAI launches", run_now: false, sources: ["x"] });
        assert.match(second.next, /No run is queued yet/);
        assert.match(second.next, /monitor-trigger/);

        assert.deepEqual(mock.seen[0].body, { query: "OpenAI launches" });
        assert.deepEqual(mock.seen[1].body, { query: "OpenAI launches", sources: ["x"], run_now: false });
    });
});

test("monitor-create rejects bad input before any request", async () => {
    await withServer(async (client, mock) => {
        for (const args of [
            {},
            { query: "ab" },
            { query: "x".repeat(501) },
            { query: "OpenAI launches", sources: [] },
            { query: "OpenAI launches", sources: ["tiktok"] },
            { query: "OpenAI launches", interval: "30m" },
            { query: "OpenAI launches", web_count: 12 },
            { query: "OpenAI launches", x_count: 0 },
            { query: "OpenAI launches", x_count: 101 },
            { query: "OpenAI launches", x_lang: "english" },
            { query: "OpenAI launches", min_score: 101 },
            { query: "OpenAI launches", criteria: ["a", "b", "c", "d", "e", "f"] },
            { query: "OpenAI launches", criteria: ["x".repeat(301)] },
            { query: "OpenAI launches", name: "x".repeat(121) },
            { query: "OpenAI launches", webhook_url: "not a url" },
            { query: "OpenAI launches", webhook_url: "https://example.com/h", webhook_events: ["monitor.test"] },
            { query: "OpenAI launches", metadata: { ["k".repeat(65)]: "v" } },
            { query: "OpenAI launches", metadata: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, "v"])) },
            { query: "OpenAI launches", metadata: { team: "x".repeat(501) } },
            { query: "OpenAI launches", options: { web: { count: 10 } } },
            { query: "OpenAI launches", webhook: { url: "https://example.com/h" } },
        ]) {
            await rejects(client, "monitor-create", args);
        }
        await rejects(
            client,
            "monitor-create",
            { query: "OpenAI launches", webhook_events: ["monitor.items.found"] },
            /^Create Monitor error: webhook_events needs webhook_url/
        );
        assert.equal(mock.seen.length, 0);
    });
});

test("monitor-create reports API errors under its own title", async () => {
    await withServer(async (client, mock) => {
        mock.reply("POST", "/desearch/monitors", 409, { detail: "too_many_monitors: at most 25 monitors per account." });
        mock.reply("POST", "/desearch/monitors", 402, {
            detail: "Your balance can't cover one run of this monitor. Add credits and try again.",
        });
        mock.reply("POST", "/desearch/monitors", 400, { detail: "The webhook URL must be on a public address" });
        await rejects(client, "monitor-create", { query: "OpenAI launches" }, /^Create Monitor error: HTTP 409: too_many_monitors/);
        await rejects(client, "monitor-create", { query: "OpenAI launches" }, /^Create Monitor error: HTTP 402: Your balance/);
        await rejects(
            client,
            "monitor-create",
            { query: "OpenAI launches", webhook_url: "https://10.0.0.1/hook" },
            /^Create Monitor error: HTTP 400: The webhook URL must be on a public address$/
        );
    });
});

test("monitor-estimate posts the cost settings and returns the estimate as the API sent it", async () => {
    await withServer(async (client, mock) => {
        const estimate = {
            max_run_cost_usd: 0.0123,
            runs_per_month: 720,
            max_monthly_cost_usd: 8.856,
            breakdown: { web: 0.005, x: 0.006, screen: 0.0003, summary: 0.001 },
        };
        mock.reply("POST", "/desearch/monitors/estimate", 200, estimate);
        mock.reply("POST", "/desearch/monitors/estimate", 200, estimate);

        assert.deepEqual(
            await call(client, "monitor-estimate", {
                sources: ["web", "x"],
                web_count: 20,
                x_count: 50,
                summary: true,
                interval: "1h",
            }),
            estimate
        );
        await call(client, "monitor-estimate", {});
        assert.deepEqual(mock.seen[0].body, {
            sources: ["web", "x"],
            options: { web: { count: 20 }, x: { count: 50 } },
            summary: true,
            interval: "1h",
        });
        assert.deepEqual(mock.seen[1].body, {});
        await rejects(client, "monitor-estimate", { x_lang: "en" });
        assert.equal(mock.seen.length, 2);
    });
});

test("monitor-list sends status, limit, and cursor, and returns null next_cursor on the last page", async () => {
    await withServer(async (client, mock) => {
        mock.reply("GET", "/desearch/monitors", 200, { monitors: [MONITOR], next_cursor: "MjAyNi0xMS0wM3w2ZjFk" });
        mock.reply("GET", "/desearch/monitors", 200, { monitors: [], next_cursor: null });

        const first = await call(client, "monitor-list", { status: ["active", "paused"], limit: 1 });
        assert.deepEqual(first, { monitors: [MONITOR], next_cursor: "MjAyNi0xMS0wM3w2ZjFk" });
        const last = await call(client, "monitor-list", { status: ["active", "paused"], limit: 1, cursor: first.next_cursor });
        assert.deepEqual(last, { monitors: [], next_cursor: null });

        assert.deepEqual(queryOf(mock.seen[0].path), { status: "active,paused", limit: "1" });
        assert.deepEqual(queryOf(mock.seen[1].path), {
            status: "active,paused",
            limit: "1",
            cursor: "MjAyNi0xMS0wM3w2ZjFk",
        });
        for (const args of [{ status: ["deleted"] }, { limit: 0 }, { limit: 101 }, { cursor: "" }]) {
            await rejects(client, "monitor-list", args);
        }
        assert.equal(mock.seen.length, 2);
    });
});

test("monitor-get reads one monitor and reports a 404 and a bad id", async () => {
    await withServer(async (client, mock) => {
        mock.reply("GET", MONITOR_PATH, 200, MONITOR);
        mock.reply("GET", MONITOR_PATH, 404, { detail: "Monitor not found" });

        assert.deepEqual(await call(client, "monitor-get", { monitor_id: MONITOR_ID }), MONITOR);
        await rejects(client, "monitor-get", { monitor_id: MONITOR_ID }, /^Get Monitor error: HTTP 404: Monitor not found$/);
        for (const args of [{}, { monitor_id: "../estimate" }, { monitor_id: MONITOR_ID, run_id: RUN_ID }]) {
            await rejects(client, "monitor-get", args);
        }
        assert.equal(mock.seen.length, 2);
        assert.equal(mock.seen[0].method, "GET");
        assert.equal(mock.seen[0].path, MONITOR_PATH);
    });
});

test("monitor-update patches only what changes, removes a webhook, and pauses", async () => {
    await withServer(async (client, mock) => {
        mock.reply("PATCH", MONITOR_PATH, 200, { ...MONITOR, status: "paused", paused_reason: "user" });
        mock.reply("PATCH", MONITOR_PATH, 200, { ...MONITOR, webhook: null });
        mock.reply("PATCH", MONITOR_PATH, 200, {
            ...MONITOR,
            webhook: { url: "https://hooks.example.com/new", events: ["monitor.run.completed"], consecutive_failures: 0 },
            webhook_secret: "whsec_new",
        });

        const paused = await call(client, "monitor-update", {
            monitor_id: MONITOR_ID,
            status: "paused",
            name: "Renamed",
            x_count: 50,
        });
        assert.equal(paused.status, "paused");
        assert.match(paused.next, /^Paused: no scheduled runs/);
        const removed = await call(client, "monitor-update", { monitor_id: MONITOR_ID, remove_webhook: true });
        assert.equal(removed.webhook, null);
        assert.match(removed.next, /^Updated/);
        const moved = await call(client, "monitor-update", {
            monitor_id: MONITOR_ID,
            query: "Bittensor subnet news",
            webhook_url: "https://hooks.example.com/new",
            webhook_events: ["monitor.run.completed"],
        });
        assert.equal(moved.webhook_secret, "whsec_new");
        assert.match(moved.next, /Store webhook_secret now/);

        assert.deepEqual(
            mock.seen.map((sent) => [sent.method, sent.path, sent.body]),
            [
                ["PATCH", MONITOR_PATH, { name: "Renamed", options: { x: { count: 50 } }, status: "paused" }],
                ["PATCH", MONITOR_PATH, { webhook: null }],
                [
                    "PATCH",
                    MONITOR_PATH,
                    {
                        query: "Bittensor subnet news",
                        webhook: { url: "https://hooks.example.com/new", events: ["monitor.run.completed"] },
                    },
                ],
            ]
        );
    });
});

test("monitor-update rejects an empty or contradictory change before any request", async () => {
    await withServer(async (client, mock) => {
        await rejects(client, "monitor-update", { monitor_id: MONITOR_ID }, /^Update Monitor error: Nothing to change/);
        await rejects(
            client,
            "monitor-update",
            { monitor_id: MONITOR_ID, remove_webhook: true, webhook_url: "https://example.com/h" },
            /^Update Monitor error: Send either remove_webhook or webhook_url/
        );
        await rejects(
            client,
            "monitor-update",
            { monitor_id: MONITOR_ID, webhook_events: ["monitor.run.failed"] },
            /^Update Monitor error: webhook_events needs webhook_url/
        );
        for (const args of [
            { status: "paused" },
            { monitor_id: MONITOR_ID, status: "deleted" },
            { monitor_id: MONITOR_ID, query: "ab" },
            { monitor_id: MONITOR_ID, run_now: true },
            { monitor_id: MONITOR_ID, webhook: null },
        ]) {
            await rejects(client, "monitor-update", args);
        }
        assert.equal(mock.seen.length, 0);
    });
});

test("monitor-delete deletes one monitor and reports a second delete as not found", async () => {
    await withServer(async (client, mock) => {
        mock.reply("DELETE", MONITOR_PATH, 200, { monitor_id: MONITOR_ID, deleted: true });
        mock.reply("DELETE", MONITOR_PATH, 404, { detail: "Monitor not found" });

        assert.deepEqual(await call(client, "monitor-delete", { monitor_id: MONITOR_ID }), {
            monitor_id: MONITOR_ID,
            deleted: true,
        });
        await rejects(client, "monitor-delete", { monitor_id: MONITOR_ID }, /^Delete Monitor error: HTTP 404: Monitor not found$/);
        assert.deepEqual(
            mock.seen.map((sent) => [sent.method, sent.path, sent.body]),
            [
                ["DELETE", MONITOR_PATH, undefined],
                ["DELETE", MONITOR_PATH, undefined],
            ]
        );
    });
});

test("monitor-trigger queues a run and reports a run already in progress", async () => {
    await withServer(async (client, mock) => {
        const queued = { ...RUN, status: "queued", item_count: 0, stats: {}, cost_usd: null, started_at: null, finished_at: null };
        mock.reply("POST", `${MONITOR_PATH}/trigger`, 202, queued);
        mock.reply("POST", `${MONITOR_PATH}/trigger`, 409, { detail: "This monitor is already running." });

        const run = await call(client, "monitor-trigger", { monitor_id: MONITOR_ID });
        assert.equal(run.run_id, RUN_ID);
        assert.equal(run.status, "queued");
        assert.match(run.next, /monitor-run with this run_id/);
        await rejects(
            client,
            "monitor-trigger",
            { monitor_id: MONITOR_ID },
            /^Run Monitor Now error: HTTP 409: This monitor is already running\.$/
        );
        assert.deepEqual(
            mock.seen.map((sent) => [sent.method, sent.path, sent.body]),
            [
                ["POST", `${MONITOR_PATH}/trigger`, undefined],
                ["POST", `${MONITOR_PATH}/trigger`, undefined],
            ]
        );
    });
});

test("monitor-runs pages a monitor's runs", async () => {
    await withServer(async (client, mock) => {
        mock.reply("GET", `${MONITOR_PATH}/runs`, 200, { runs: [RUN], next_cursor: "cursor-2" });
        mock.reply("GET", `${MONITOR_PATH}/runs`, 200, { runs: [], next_cursor: null });

        assert.deepEqual(await call(client, "monitor-runs", { monitor_id: MONITOR_ID, limit: 1 }), {
            runs: [RUN],
            next_cursor: "cursor-2",
        });
        assert.deepEqual(await call(client, "monitor-runs", { monitor_id: MONITOR_ID, limit: 1, cursor: "cursor-2" }), {
            runs: [],
            next_cursor: null,
        });
        assert.deepEqual(queryOf(mock.seen[0].path), { limit: "1" });
        assert.deepEqual(queryOf(mock.seen[1].path), { limit: "1", cursor: "cursor-2" });
        await rejects(client, "monitor-runs", { monitor_id: MONITOR_ID, limit: 101 });
        assert.equal(mock.seen.length, 2);
    });
});

test("monitor-run returns the run with compact items and what to do next", async () => {
    await withServer(async (client, mock) => {
        mock.reply("GET", `${MONITOR_PATH}/runs/${RUN_ID}`, 200, { ...RUN, items: [X_ITEM, WEB_ITEM] });
        mock.reply("GET", `${MONITOR_PATH}/runs/${RUN_ID}`, 200, { ...RUN, status: "running", items: [] });
        mock.reply("GET", `${MONITOR_PATH}/runs/${RUN_ID}`, 404, { detail: "Run not found" });

        const run = await call(client, "monitor-run", { monitor_id: MONITOR_ID, run_id: RUN_ID });
        assert.equal(run.status, "completed");
        assert.equal(run.cost_usd, 0.0041);
        assert.deepEqual(run.stats, RUN.stats);
        assert.equal(run.items.length, 2);
        const [x, web] = run.items;
        assert.equal(Object.hasOwn(x, "title"), false);
        assert.deepEqual(x.author, X_ITEM.author);
        assert.deepEqual(x.data, X_ITEM.data);
        assert.equal(web.text.length, 1000);
        assert.ok(web.text.endsWith("..."));
        assert.equal(Object.hasOwn(web, "author"), false);
        assert.match(run.next, /^Done/);

        const running = await call(client, "monitor-run", { monitor_id: MONITOR_ID, run_id: RUN_ID });
        assert.deepEqual(running.items, []);
        assert.match(running.next, /^Still running/);
        await rejects(
            client,
            "monitor-run",
            { monitor_id: MONITOR_ID, run_id: RUN_ID },
            /^Get Monitor Run error: HTTP 404: Run not found$/
        );
        await rejects(client, "monitor-run", { monitor_id: MONITOR_ID });
        await rejects(client, "monitor-run", { monitor_id: MONITOR_ID, run_id: "latest" });
        assert.equal(mock.seen.length, 3);
    });
});

test("monitor-items filters by source, pages with the item cursor, and compacts items", async () => {
    await withServer(async (client, mock) => {
        mock.reply("GET", `${MONITOR_PATH}/items`, 200, { items: [X_ITEM], next_cursor: "1842" });
        mock.reply("GET", `${MONITOR_PATH}/items`, 200, { items: [], next_cursor: null });

        const first = await call(client, "monitor-items", { monitor_id: MONITOR_ID, source: "x", limit: 1 });
        assert.deepEqual(first, { items: [compactMonitorItem(X_ITEM)], next_cursor: "1842" });
        const last = await call(client, "monitor-items", { monitor_id: MONITOR_ID, source: "x", limit: 1, cursor: "1842" });
        assert.deepEqual(last, { items: [], next_cursor: null });
        assert.deepEqual(queryOf(mock.seen[0].path), { source: "x", limit: "1" });
        assert.deepEqual(queryOf(mock.seen[1].path), { source: "x", limit: "1", cursor: "1842" });

        for (const args of [
            { monitor_id: MONITOR_ID, source: "tiktok" },
            { monitor_id: MONITOR_ID, limit: 201 },
            { monitor_id: MONITOR_ID, cursor: "abc" },
        ]) {
            await rejects(client, "monitor-items", args);
        }
        assert.equal(mock.seen.length, 2);
    });
});

test("monitor-webhook-test reports what the endpoint answered, and a monitor without a webhook", async () => {
    await withServer(async (client, mock) => {
        const answer = { delivered: false, status_code: 405, error: "HTTP 405", duration_ms: 212 };
        mock.reply("POST", `${MONITOR_PATH}/webhook/test`, 200, answer);
        mock.reply("POST", `${MONITOR_PATH}/webhook/test`, 400, { detail: "This monitor has no webhook. Add one first." });

        assert.deepEqual(await call(client, "monitor-webhook-test", { monitor_id: MONITOR_ID }), answer);
        await rejects(
            client,
            "monitor-webhook-test",
            { monitor_id: MONITOR_ID },
            /^Test Monitor Webhook error: HTTP 400: This monitor has no webhook\. Add one first\.$/
        );
        assert.deepEqual(mock.seen.map((sent) => [sent.method, sent.path]), [
            ["POST", `${MONITOR_PATH}/webhook/test`],
            ["POST", `${MONITOR_PATH}/webhook/test`],
        ]);
    });
});

test("monitor-webhook-rotate-secret returns the new secret once", async () => {
    await withServer(async (client, mock) => {
        mock.reply("POST", `${MONITOR_PATH}/webhook/rotate-secret`, 200, { webhook_secret: "whsec_rotated" });

        const rotated = await call(client, "monitor-webhook-rotate-secret", { monitor_id: MONITOR_ID });
        assert.equal(rotated.webhook_secret, "whsec_rotated");
        assert.match(rotated.next, /not shown again/);
        assert.deepEqual(mock.seen.map((sent) => [sent.method, sent.path, sent.body]), [
            ["POST", `${MONITOR_PATH}/webhook/rotate-secret`, undefined],
        ]);
    });
});

test("monitor tools need an API key and send nothing without one", async () => {
    await withServer(async (client, mock) => {
        for (const [name, args] of [
            ["monitor-create", { query: "OpenAI launches" }],
            ["monitor-list", {}],
            ["monitor-trigger", { monitor_id: MONITOR_ID }],
            ["monitor-delete", { monitor_id: MONITOR_ID }],
        ]) {
            await rejects(client, name, args, /API key required/);
        }
        assert.equal(mock.seen.length, 0);
    }, "");
});

test("monitor request bodies match the API models", () => {
    assert.equal(monitorOptions({}), undefined);
    assert.deepEqual(monitorOptions({ x_lang: "en" }), { x: { lang: "en" } });
    assert.deepEqual(monitorCreateBody({ query: "q q q", run_now: true, summary: true }), {
        query: "q q q",
        summary: true,
        run_now: true,
    });
    assert.deepEqual(monitorUpdateBody({ monitor_id: MONITOR_ID, status: "active", min_score: 0 }), {
        min_score: 0,
        status: "active",
    });
    assert.deepEqual(monitorUpdateBody({ monitor_id: MONITOR_ID, webhook_url: "https://example.com/h" }), {
        webhook: { url: "https://example.com/h" },
    });
    assert.throws(() => monitorUpdateBody({ monitor_id: MONITOR_ID }), /Nothing to change/);
    assert.deepEqual(monitorEstimateBody({ web_count: 15, interval: "7d" }), {
        options: { web: { count: 15 } },
        interval: "7d",
    });
});

test("monitorRunNextStep and monitorNextStep cover every status", () => {
    assert.match(monitorRunNextStep({ status: "queued" }), /^Still running/);
    assert.match(monitorRunNextStep({ status: "running" }), /^Still running/);
    assert.match(monitorRunNextStep({ status: "completed" }), /^Done/);
    assert.match(monitorRunNextStep({ status: "failed", fail_reason: "all_sources_failed" }), /all_sources_failed/);
    assert.match(monitorRunNextStep({ status: "cancelled" }), /^Cancelled/);
    assert.match(monitorRunNextStep({}), /monitor-run again/);
    assert.match(monitorNextStep({ status: "active" }), /^Updated/);
    assert.match(monitorNextStep({ status: "paused" }), /^Paused/);
    assert.match(monitorNextStep({ status: "active" }, { created: true, runNow: false }), /^Created\. No run/);
    assert.match(monitorNextStep({ webhook_secret: "whsec_x" }, { created: true }), /Store webhook_secret now/);
});
