#!/usr/bin/env node
/**
 * Live smoke test for the Monitors tools added in 0.10.0. It starts the built server over
 * stdio, connects with the MCP SDK client, and drives every free monitor tool against a real
 * Desearch API: create (run_now false, so no run is queued), get, list, update (rename and
 * pause), estimate, runs, items, webhook test, rotate-secret, and delete. It never calls
 * monitor-trigger, so no run is billed. The monitor it creates is deleted at the end, also
 * after a failure. --with-accounts also creates (and deletes) a monitor with the TikTok source
 * and watched accounts on X, Reddit, YouTube and TikTok (desearch-public-api#635), and checks
 * the names come back cleaned, a bad name is a 422 (an X username has at most 15 characters),
 * and monitor-update replaces the options. Then, for desearch-public-api#644, it prices
 * Instagram, Facebook, Meta ads and Threads accounts (the estimate breakdown per source),
 * checks that instagram and facebook without accounts are a 422 on create and on update,
 * creates (and deletes) a monitor with all four and a webhook (names cleaned, meta_ads count,
 * webhook.last_delivery null), reads its items with source meta_ads, and makes one Facebook
 * search with sort recent and count 2: the only billed call, at most 2 ads ($0.00414).
 *
 *   npm run build
 *   DESEARCH_API_KEY=... node scripts/e2e-monitors.mjs
 *   node scripts/e2e-monitors.mjs --base-url https://api-dev.desearch.ai --key-env DESEARCH_DEV_API_KEY [--with-accounts]
 *
 * Options:
 *   --base-url <url>  Desearch API host (default https://api.desearch.ai). Passed to the
 *                     server as DESEARCH_API_BASE.
 *   --key-env <name>  environment variable that holds the key (default DESEARCH_API_KEY).
 *                     When it is not set, it is read from ~/.config/desearch/e2e.env.
 *   --with-accounts   also check the TikTok source and watched accounts (free), and the
 *                     Instagram, Facebook, Meta ads and Threads accounts sources (free) plus
 *                     one Facebook search with sort recent (billed, at most $0.00414).
 *
 * Prints one line per check, `PASS name` or `FAIL name: error`, and exits 1 if any failed.
 * The key and the webhook secrets are never printed.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function option(name, fallback) {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const baseUrl = option("--base-url", "https://api.desearch.ai").replace(/\/+$/, "");
const keyEnv = option("--key-env", "DESEARCH_API_KEY");
const withAccounts = args.includes("--with-accounts");

function keyFromEnvFile(name) {
    const path = join(homedir(), ".config", "desearch", "e2e.env");
    if (!existsSync(path)) {
        return undefined;
    }
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith(`${name}=`)) {
            return trimmed.slice(name.length + 1).trim() || undefined;
        }
    }
    return undefined;
}

const apiKey = process.env[keyEnv] || keyFromEnvFile(keyEnv);
if (!apiKey) {
    console.error(`Set ${keyEnv} (or add it to ~/.config/desearch/e2e.env) to run the live smoke test.`);
    process.exit(2);
}

const MONITOR_TOOLS = [
    "monitor-create",
    "monitor-estimate",
    "monitor-list",
    "monitor-get",
    "monitor-update",
    "monitor-delete",
    "monitor-trigger",
    "monitor-runs",
    "monitor-run",
    "monitor-items",
    "monitor-webhook-test",
    "monitor-webhook-rotate-secret",
];

let failures = 0;
let calls = 0;
const secrets = [];

function redact(text) {
    let out = text.split(apiKey).join("***");
    for (const secret of secrets) {
        out = out.split(secret).join("whsec_***");
    }
    return out.replace(/whsec_[A-Za-z0-9_-]+/g, "whsec_***");
}

function pass(name, detail) {
    console.log(detail ? `PASS ${name} (${redact(detail)})` : `PASS ${name}`);
}

function fail(name, error) {
    failures++;
    const message = error instanceof Error ? error.message : String(error);
    console.log(`FAIL ${name}: ${redact(message).replace(/\s+/g, " ").slice(0, 300)}`);
}

function textOf(result) {
    return (result.content ?? []).map((block) => block.text ?? "").join("\n");
}

function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Call one tool; return { error } or { value }. */
async function call(client, tool, toolArgs) {
    calls++;
    const result = await client.callTool({ name: tool, arguments: toolArgs });
    const text = textOf(result);
    if (result.isError) {
        return { error: text };
    }
    return { value: JSON.parse(text) };
}

/** Call a tool and check its reply; PASS or FAIL, and the reply when it passed. */
async function check(client, tool, toolArgs, test, label = tool) {
    const result = await call(client, tool, toolArgs);
    if (result.error) {
        fail(label, result.error);
        return undefined;
    }
    try {
        const detail = test(result.value);
        pass(label, detail);
        return result.value;
    } catch (error) {
        fail(label, error);
        return undefined;
    }
}

function expect(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

const WATCHED = {
    x_accounts: ["@OpenAI", "https://x.com/AnthropicAI"],
    reddit_subreddits: ["r/LocalLLaMA"],
    youtube_channels: ["https://www.youtube.com/@OpenAI"],
    tiktok_accounts: ["@openai"],
    tiktok_count: 20,
};
const CLEANED = {
    x: ["OpenAI", "AnthropicAI"],
    reddit: ["LocalLLaMA"],
    youtube: ["@OpenAI"],
    tiktok: ["openai"],
};

// X usernames are 1-15 characters (the API's limit); every name above fits.
const X_NAME_MAX = 15;

/** The TikTok source and watched accounts: estimate, create, a bad name, update, delete. */
async function checkWatchedAccounts(client, stamp) {
    const sources = ["x", "reddit", "youtube", "tiktok"];
    await check(
        client,
        "monitor-estimate",
        { sources, ...WATCHED },
        (estimate) => {
            expect(typeof estimate.breakdown?.tiktok === "number", `breakdown ${JSON.stringify(estimate.breakdown)}`);
            return `$${estimate.max_run_cost_usd} per run, ${JSON.stringify(estimate.breakdown)}`;
        },
        "monitor-estimate tiktok + watched accounts"
    );
    const badName = await call(client, "monitor-estimate", { sources: ["x"], x_accounts: ["not a name!"] });
    if (badName.error && /HTTP 422/.test(badName.error)) pass("monitor-estimate bad X username", "HTTP 422");
    else fail("monitor-estimate bad X username", `expected HTTP 422, got ${JSON.stringify(badName).slice(0, 200)}`);
    const longest = await call(client, "monitor-estimate", { sources: ["x"], x_accounts: ["a".repeat(X_NAME_MAX)] });
    if (typeof longest.value?.max_run_cost_usd === "number") pass(`monitor-estimate X username of ${X_NAME_MAX} characters`);
    else fail(`monitor-estimate X username of ${X_NAME_MAX} characters`, longest.error ?? JSON.stringify(longest.value));
    const tooLong = await call(client, "monitor-estimate", { sources: ["x"], x_accounts: ["a".repeat(X_NAME_MAX + 1)] });
    if (tooLong.error && /HTTP 422/.test(tooLong.error)) pass(`monitor-estimate X username of ${X_NAME_MAX + 1} characters`, "HTTP 422");
    else fail(`monitor-estimate X username of ${X_NAME_MAX + 1} characters`, `expected HTTP 422, got ${JSON.stringify(tooLong).slice(0, 200)}`);

    let monitorId;
    try {
        const created = await check(
            client,
            "monitor-create",
            {
                query: "OpenAI announcements",
                name: `MCP e2e accounts ${stamp}`,
                sources,
                interval: "7d",
                min_score: 0,
                run_now: false,
                ...WATCHED,
            },
            (monitor) => {
                monitorId = monitor.monitor_id;
                if (typeof monitor.webhook_secret === "string") secrets.push(monitor.webhook_secret);
                expect(JSON.stringify(monitor.sources) === JSON.stringify(sources), `sources ${JSON.stringify(monitor.sources)}`);
                const got = {
                    x: monitor.options?.x?.accounts,
                    reddit: monitor.options?.reddit?.subreddits,
                    youtube: monitor.options?.youtube?.channels,
                    tiktok: monitor.options?.tiktok?.accounts,
                };
                expect(JSON.stringify(got) === JSON.stringify(CLEANED), `names ${JSON.stringify(got)}`);
                expect(monitor.options?.tiktok?.count === 20, `tiktok ${JSON.stringify(monitor.options?.tiktok)}`);
                return `names cleaned: ${Object.values(got).flat().join(", ")}`;
            },
            "monitor-create tiktok + watched accounts"
        );
        if (!created) {
            return;
        }
        await check(
            client,
            "monitor-update",
            { monitor_id: monitorId, tiktok_count: 30, tiktok_accounts: ["openai"] },
            (monitor) => {
                expect(
                    JSON.stringify(monitor.options?.tiktok) === '{"count":30,"accounts":["openai"]}',
                    `tiktok ${JSON.stringify(monitor.options?.tiktok)}`
                );
                expect(!monitor.options?.x?.accounts?.length, `x kept ${JSON.stringify(monitor.options?.x)}`);
                return "options replaced as a whole";
            },
            "monitor-update watched accounts"
        );
        await check(
            client,
            "monitor-items",
            { monitor_id: monitorId, source: "tiktok", limit: 5 },
            (page) => {
                expect(Array.isArray(page.items) && page.items.length === 0, "items");
                return "no items";
            },
            "monitor-items source tiktok"
        );
    } finally {
        if (monitorId) {
            const deleted = await call(client, "monitor-delete", { monitor_id: monitorId });
            if (deleted.value?.deleted === true) pass("monitor-delete watched accounts");
            else fail("monitor-delete watched accounts", deleted.error ?? JSON.stringify(deleted.value));
        }
    }
}

const SOCIAL_SOURCES = ["instagram", "facebook", "meta_ads", "threads"];
const SOCIAL = {
    instagram_accounts: ["@openai", "https://www.instagram.com/nasa/?hl=en"],
    facebook_pages: ["https://www.facebook.com/NASA/", "facebook.com/profile.php?id=100044561550831"],
    threads_accounts: ["https://www.threads.com/@zuck", "@mosseri"],
    meta_ads_count: 20,
};
const SOCIAL_CLEANED = {
    instagram: ["openai", "nasa"],
    facebook: ["NASA", "100044561550831"],
    threads: ["zuck", "mosseri"],
};
// The most one run reads, at desearch-public-api#644 prices: an Instagram account $0.02484 (12
// posts), a Facebook page $0.0207 (10 posts), 10 Meta ads $0.0207, a Threads account $0.00207.
const SOCIAL_BREAKDOWN = { instagram: 2 * 0.02484, facebook: 2 * 0.0207, meta_ads: 2 * 0.0207, threads: 2 * 0.00207 };

/** The 422 for instagram or facebook without accounts, or a FAIL. Deletes a monitor created by mistake. */
async function expectMissingAccounts(client, tool, toolArgs, field, label) {
    const result = await call(client, tool, toolArgs);
    if (result.error && /HTTP 422/.test(result.error) && result.error.includes(field)) {
        pass(label, `HTTP 422 names ${field}`);
        return;
    }
    fail(label, `expected HTTP 422 naming ${field}, got ${JSON.stringify(result).slice(0, 200)}`);
    if (tool === "monitor-create" && typeof result.value?.monitor_id === "string") {
        await call(client, "monitor-delete", { monitor_id: result.value.monitor_id });
    }
}

/**
 * Instagram, Facebook, Meta ads and Threads accounts (desearch-public-api#644): the estimate
 * breakdown, the 422 without accounts on create and update, a monitor with all four and a
 * webhook, items by source meta_ads, and delete. Free: no run is queued.
 */
async function checkSocialSources(client, stamp) {
    await check(
        client,
        "monitor-estimate",
        { sources: SOCIAL_SOURCES, ...SOCIAL },
        (estimate) => {
            for (const [part, want] of Object.entries(SOCIAL_BREAKDOWN)) {
                const got = estimate.breakdown?.[part];
                expect(typeof got === "number" && Math.abs(got - want) < 0.0001, `${part} ${got}, expected ${want.toFixed(5)}`);
            }
            return `$${estimate.max_run_cost_usd} per run, ${JSON.stringify(estimate.breakdown)}`;
        },
        "monitor-estimate instagram + facebook + meta_ads + threads breakdown"
    );
    await check(
        client,
        "monitor-estimate",
        { sources: ["instagram", "facebook"] },
        (estimate) => {
            expect(typeof estimate.max_run_cost_usd === "number", "no max_run_cost_usd");
            return "estimate does not need the accounts";
        },
        "monitor-estimate instagram + facebook without accounts"
    );

    const bare = { query: "NASA launches", name: `MCP e2e no accounts ${stamp}`, interval: "7d", run_now: false };
    await expectMissingAccounts(
        client,
        "monitor-create",
        { ...bare, sources: ["instagram"] },
        "options.instagram.accounts",
        "monitor-create instagram without accounts"
    );
    await expectMissingAccounts(
        client,
        "monitor-create",
        { ...bare, sources: ["facebook"], meta_ads_count: 10 },
        "options.facebook.pages",
        "monitor-create facebook without pages"
    );

    let monitorId;
    try {
        const created = await check(
            client,
            "monitor-create",
            {
                query: "ChatGPT",
                name: `MCP e2e social ${stamp}`,
                sources: SOCIAL_SOURCES,
                interval: "7d",
                min_score: 0,
                webhook_url: "https://example.com/desearch-e2e",
                run_now: false,
                ...SOCIAL,
            },
            (monitor) => {
                monitorId = monitor.monitor_id;
                if (typeof monitor.webhook_secret === "string") secrets.push(monitor.webhook_secret);
                expect(JSON.stringify(monitor.sources) === JSON.stringify(SOCIAL_SOURCES), `sources ${JSON.stringify(monitor.sources)}`);
                const got = {
                    instagram: monitor.options?.instagram?.accounts,
                    facebook: monitor.options?.facebook?.pages,
                    threads: monitor.options?.threads?.accounts,
                };
                expect(JSON.stringify(got) === JSON.stringify(SOCIAL_CLEANED), `names ${JSON.stringify(got)}`);
                expect(monitor.options?.meta_ads?.count === 20, `meta_ads ${JSON.stringify(monitor.options?.meta_ads)}`);
                expect(isObject(monitor.webhook) && "last_delivery" in monitor.webhook, `webhook ${JSON.stringify(monitor.webhook)}`);
                expect(monitor.webhook.last_delivery === null, `last_delivery ${JSON.stringify(monitor.webhook.last_delivery)}`);
                return `names cleaned: ${Object.values(got).flat().join(", ")}; webhook.last_delivery null`;
            },
            "monitor-create instagram + facebook + meta_ads + threads accounts"
        );
        if (!created) {
            return;
        }
        await check(
            client,
            "monitor-webhook-test",
            { monitor_id: monitorId },
            (result) => {
                expect(typeof result.delivered === "boolean", "no delivered");
                return `delivered ${result.delivered}, status_code ${result.status_code}`;
            },
            "monitor-webhook-test social monitor"
        );
        await check(
            client,
            "monitor-get",
            { monitor_id: monitorId },
            (monitor) => {
                expect(monitor.webhook?.last_delivery === null, `last_delivery ${JSON.stringify(monitor.webhook?.last_delivery)}`);
                expect(monitor.webhook?.consecutive_failures === 0, `consecutive_failures ${monitor.webhook?.consecutive_failures}`);
                return "a test event leaves last_delivery null";
            },
            "monitor-get webhook.last_delivery after a test event"
        );

        // The update replaces options as a whole, and the API checks the monitor as patched.
        await expectMissingAccounts(
            client,
            "monitor-update",
            { monitor_id: monitorId, meta_ads_count: 30 },
            "options.instagram.accounts",
            "monitor-update options without instagram accounts"
        );
        await expectMissingAccounts(
            client,
            "monitor-update",
            { monitor_id: monitorId, sources: ["facebook", "meta_ads"], instagram_accounts: ["openai"] },
            "options.facebook.pages",
            "monitor-update facebook without pages"
        );
        await check(
            client,
            "monitor-update",
            { monitor_id: monitorId, sources: ["instagram", "meta_ads"], instagram_accounts: ["nasa"], meta_ads_count: 30 },
            (monitor) => {
                expect(JSON.stringify(monitor.sources) === '["instagram","meta_ads"]', `sources ${JSON.stringify(monitor.sources)}`);
                expect(JSON.stringify(monitor.options?.instagram?.accounts) === '["nasa"]', `instagram ${JSON.stringify(monitor.options?.instagram)}`);
                expect(monitor.options?.meta_ads?.count === 30, `meta_ads ${JSON.stringify(monitor.options?.meta_ads)}`);
                expect(!monitor.options?.facebook?.pages?.length && !monitor.options?.threads?.accounts?.length, `kept ${JSON.stringify(monitor.options)}`);
                return "options replaced as a whole";
            },
            "monitor-update instagram + meta_ads"
        );
        await check(
            client,
            "monitor-items",
            { monitor_id: monitorId, source: "meta_ads", limit: 5 },
            (page) => {
                expect(Array.isArray(page.items) && page.items.length === 0, "items");
                expect(page.next_cursor === null, "next_cursor");
                return "no items";
            },
            "monitor-items source meta_ads"
        );
    } finally {
        if (monitorId) {
            const deleted = await call(client, "monitor-delete", { monitor_id: monitorId });
            if (deleted.value?.deleted === true) pass("monitor-delete social sources");
            else fail("monitor-delete social sources", deleted.error ?? JSON.stringify(deleted.value));
        }
    }
}

let billedCalls = 0;

/** POST /desearch/facebook/search with sort recent: billed per ad returned, so count 2. */
async function checkFacebookSort(client) {
    billedCalls++;
    await check(
        client,
        "facebook",
        { action: "search", query: "ChatGPT", sort: "recent", count: 2 },
        (page) => {
            expect(Array.isArray(page.results), "no results");
            expect(page.results.length <= 2, `${page.results.length} results`);
            expect("next_cursor" in page, "no next_cursor");
            return `${page.results.length} ads, next_cursor ${page.next_cursor === null ? "null" : "set"}`;
        },
        "facebook search sort recent"
    );
}

async function main() {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(ROOT, "build", "index.js")],
        env: { ...getDefaultEnvironment(), DESEARCH_API_KEY: apiKey, DESEARCH_API_BASE: baseUrl },
        stderr: "pipe",
    });
    transport.stderr?.on("data", () => {});
    const client = new Client({ name: "e2e-monitors", version: "0.10.0" });
    await client.connect(transport);
    console.log(`API: ${baseUrl} (key from ${keyEnv})`);
    let monitorId;
    try {
        const { tools } = await client.listTools();
        const names = new Set(tools.map((tool) => tool.name));
        const missing = MONITOR_TOOLS.filter((name) => !names.has(name));
        if (missing.length === 0) pass("tools/list", `${tools.length} tools, all ${MONITOR_TOOLS.length} monitor tools`);
        else fail("tools/list", `missing ${missing.join(", ")}`);

        const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
        const created = await check(
            client,
            "monitor-create",
            {
                query: "Bittensor subnet launches and updates",
                name: `MCP e2e ${stamp}`,
                criteria: ["Announces a new subnet, release or partnership"],
                sources: ["x"],
                interval: "7d",
                x_count: 10,
                x_lang: "en",
                webhook_url: "https://example.com/desearch-e2e",
                metadata: { source: "mcp-e2e" },
                run_now: false,
            },
            (monitor) => {
                expect(typeof monitor.monitor_id === "string", "no monitor_id");
                monitorId = monitor.monitor_id;
                expect(typeof monitor.webhook_secret === "string" && monitor.webhook_secret.startsWith("whsec_"), "no webhook_secret");
                secrets.push(monitor.webhook_secret);
                expect(monitor.status === "active", `status ${monitor.status}`);
                expect(JSON.stringify(monitor.sources) === '["x"]', `sources ${JSON.stringify(monitor.sources)}`);
                expect(monitor.options?.x?.count === 10 && monitor.options?.x?.lang === "en", `options ${JSON.stringify(monitor.options)}`);
                expect(monitor.webhook?.url === "https://example.com/desearch-e2e", "webhook url");
                expect(monitor.last_run === null || monitor.last_run === undefined, "a run was queued");
                expect(/No run is queued yet/.test(monitor.next), "next hint");
                return `${monitor.monitor_id}, max_run_cost_usd ${monitor.max_run_cost_usd}`;
            }
        );
        if (!created) {
            return;
        }

        await check(client, "monitor-get", { monitor_id: monitorId }, (monitor) => {
            expect(monitor.monitor_id === monitorId, "wrong monitor");
            expect(monitor.webhook_secret === undefined, "get returned the secret");
            expect(monitor.metadata?.source === "mcp-e2e", "metadata");
            return `next_run_at ${monitor.next_run_at}`;
        });

        await check(client, "monitor-list", { limit: 100 }, (page) => {
            expect(Array.isArray(page.monitors), "no monitors list");
            expect("next_cursor" in page, "no next_cursor");
            expect(page.monitors.some((monitor) => monitor.monitor_id === monitorId), "new monitor not listed");
            return `${page.monitors.length} monitors, next_cursor ${page.next_cursor === null ? "null" : "set"}`;
        });
        await check(
            client,
            "monitor-list",
            { status: ["paused"], limit: 1 },
            (page) => {
                expect(page.monitors.every((monitor) => monitor.status === "paused"), "an active monitor in the paused filter");
                return `${page.monitors.length} on the first page`;
            },
            "monitor-list status filter"
        );

        await check(
            client,
            "monitor-update",
            { monitor_id: monitorId, name: `MCP e2e ${stamp} renamed`, status: "paused" },
            (monitor) => {
                expect(monitor.name === `MCP e2e ${stamp} renamed`, `name ${monitor.name}`);
                expect(monitor.status === "paused" && monitor.paused_reason === "user", `status ${monitor.status} ${monitor.paused_reason}`);
                expect(/^Paused/.test(monitor.next), "next hint");
                return `${monitor.status}, ${monitor.paused_reason}`;
            }
        );

        await check(
            client,
            "monitor-estimate",
            { sources: ["web", "x"], web_count: 20, x_count: 50, summary: true, interval: "1h" },
            (estimate) => {
                for (const field of ["max_run_cost_usd", "runs_per_month", "max_monthly_cost_usd"]) {
                    expect(typeof estimate[field] === "number", `no ${field}`);
                }
                expect(isObject(estimate.breakdown), "no breakdown");
                expect(estimate.runs_per_month === 720, `runs_per_month ${estimate.runs_per_month}`);
                return `$${estimate.max_run_cost_usd} per run, $${estimate.max_monthly_cost_usd} per month, parts ${Object.keys(estimate.breakdown).join("/")}`;
            }
        );

        await check(client, "monitor-runs", { monitor_id: monitorId }, (page) => {
            expect(Array.isArray(page.runs) && page.runs.length === 0, `runs ${JSON.stringify(page.runs).slice(0, 100)}`);
            expect(page.next_cursor === null, "next_cursor");
            return "no runs, as created with run_now false";
        });

        await check(client, "monitor-items", { monitor_id: monitorId, source: "x", limit: 5 }, (page) => {
            expect(Array.isArray(page.items) && page.items.length === 0, "items");
            expect(page.next_cursor === null, "next_cursor");
            return "no items";
        });

        const missingRun = await call(client, "monitor-run", {
            monitor_id: monitorId,
            run_id: "00000000-0000-4000-8000-000000000000",
        });
        if (missingRun.error && /HTTP 404/.test(missingRun.error)) pass("monitor-run unknown run", "HTTP 404");
        else fail("monitor-run unknown run", `expected HTTP 404, got ${JSON.stringify(missingRun).slice(0, 200)}`);

        await check(client, "monitor-webhook-test", { monitor_id: monitorId }, (result) => {
            expect(typeof result.delivered === "boolean", "no delivered");
            expect(typeof result.duration_ms === "number", "no duration_ms");
            expect("status_code" in result && "error" in result, "no status_code or error");
            return `delivered ${result.delivered}, status_code ${result.status_code}, ${result.duration_ms} ms`;
        });

        await check(client, "monitor-webhook-rotate-secret", { monitor_id: monitorId }, (result) => {
            expect(typeof result.webhook_secret === "string" && result.webhook_secret.startsWith("whsec_"), "no secret");
            expect(!secrets.includes(result.webhook_secret), "same secret");
            secrets.push(result.webhook_secret);
            return "new secret";
        });

        await check(
            client,
            "monitor-update",
            { monitor_id: monitorId, remove_webhook: true },
            (monitor) => {
                expect(monitor.webhook === null, `webhook ${JSON.stringify(monitor.webhook)}`);
                return "webhook removed";
            },
            "monitor-update remove_webhook"
        );
        const noHook = await call(client, "monitor-webhook-test", { monitor_id: monitorId });
        if (noHook.error && /HTTP 400/.test(noHook.error)) pass("monitor-webhook-test without a webhook", "HTTP 400");
        else fail("monitor-webhook-test without a webhook", `expected HTTP 400, got ${JSON.stringify(noHook).slice(0, 200)}`);

        if (withAccounts) {
            await checkWatchedAccounts(client, stamp);
            await checkSocialSources(client, stamp);
            await checkFacebookSort(client);
        }
    } finally {
        if (monitorId) {
            const deleted = await call(client, "monitor-delete", { monitor_id: monitorId });
            if (deleted.value?.deleted === true && deleted.value.monitor_id === monitorId) pass("monitor-delete");
            else fail("monitor-delete", deleted.error ?? JSON.stringify(deleted.value));
            const gone = await call(client, "monitor-get", { monitor_id: monitorId });
            if (gone.error && /HTTP 404/.test(gone.error)) pass("monitor-get after delete", "HTTP 404");
            else fail("monitor-get after delete", `expected HTTP 404, got ${JSON.stringify(gone).slice(0, 200)}`);
        }
        await client.close();
    }
}

main()
    .catch((error) => fail("e2e", error))
    .finally(() => {
        console.log(
            `${calls} tool calls, no billed runs${billedCalls ? `; ${billedCalls} billed Facebook search (at most 2 ads, $0.00414)` : ""}.`
        );
        console.log(failures === 0 ? "All checks passed." : `${failures} check(s) failed.`);
        process.exitCode = failures === 0 ? 0 : 1;
    });
