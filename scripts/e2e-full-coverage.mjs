#!/usr/bin/env node
/**
 * Live smoke test for the tools added in 0.7.0: search-api, tiktok, facebook,
 * instagram, and people-search-export. It starts the built server over stdio,
 * connects with the MCP SDK client, and calls each new tool action once against
 * the real Desearch API with the smallest counts. Each call is billed to the key's
 * Desearch balance at normal prices (https://desearch.ai/pricing).
 *
 *   npm run build
 *   DESEARCH_API_KEY=... node scripts/e2e-full-coverage.mjs
 *
 * Options:
 *   --task-id <uuid>  also export that existing People Search task (free).
 *   --with-people     start one small People Search job (paid: it reserves 5 TikTok
 *                     people), wait for it to end, then export it. Off by default.
 *
 * Prints one line per call, `PASS name` or `FAIL name: error`, follows one social
 * cursor page when a list call returns next_cursor, and exits 1 if any call failed.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const withPeople = args.includes("--with-people");
const taskIdFlag = args.indexOf("--task-id");
const existingTaskId = taskIdFlag >= 0 ? args[taskIdFlag + 1] : undefined;

const apiKey = process.env.DESEARCH_API_KEY;
if (!apiKey) {
    console.error("Set DESEARCH_API_KEY to run the live smoke test.");
    process.exit(2);
}

let failures = 0;

function pass(name, detail) {
    console.log(detail ? `PASS ${name} (${detail})` : `PASS ${name}`);
}

function fail(name, error) {
    failures++;
    const message = error instanceof Error ? error.message : String(error);
    console.log(`FAIL ${name}: ${message.replace(/\s+/g, " ").slice(0, 300)}`);
}

function textOf(result) {
    return (result.content ?? []).map((block) => block.text ?? "").join("\n");
}

/** Call one tool; return the parsed JSON payload, or undefined after printing FAIL. */
async function callJson(client, name, toolArgs, label = name) {
    try {
        const result = await client.callTool({ name, arguments: toolArgs });
        const text = textOf(result);
        if (result.isError) {
            fail(label, text);
            return undefined;
        }
        return JSON.parse(text);
    } catch (error) {
        fail(label, error);
        return undefined;
    }
}

/** A social list action: PASS when it returns { results: [...] }. Keeps the cursor for later. */
const cursors = [];
async function list(client, tool, toolArgs, label = `${tool}.${toolArgs.action}`) {
    const page = await callJson(client, tool, toolArgs, label);
    if (page === undefined) {
        return [];
    }
    if (!Array.isArray(page.results)) {
        fail(label, `expected a results array, got ${JSON.stringify(page).slice(0, 200)}`);
        return [];
    }
    pass(label, `${page.results.length} items, next_cursor ${page.next_cursor ? "returned" : "null"}`);
    if (page.next_cursor) {
        cursors.push({ tool, args: toolArgs, cursor: page.next_cursor });
    }
    return page.results;
}

/** A single-item action: PASS when it returns a JSON object. */
async function item(client, tool, toolArgs, missing) {
    const label = `${tool}.${toolArgs.action}`;
    if (missing) {
        fail(label, missing);
        return;
    }
    const value = await callJson(client, tool, toolArgs, label);
    if (value === undefined) {
        return;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail(label, `expected an object, got ${JSON.stringify(value).slice(0, 200)}`);
        return;
    }
    pass(label);
}

function firstField(rows, field) {
    for (const row of rows) {
        if (row && typeof row[field] === "string" && row[field]) {
            return row[field];
        }
    }
    return undefined;
}

async function exportPeople(client, toolArgs, label) {
    try {
        const result = await client.callTool({ name: "people-search-export", arguments: toolArgs });
        const [note] = (result.content ?? []).map((block) => block.text ?? "");
        if (result.isError) {
            fail(label, note);
            return;
        }
        pass(label, note.split(". ")[0]);
    } catch (error) {
        fail(label, error);
    }
}

async function runPeopleJob(client) {
    const started = await callJson(client, "people-search", {
        platform: "tiktok",
        query: "Skincare creators who review sunscreen",
        count: 5,
        idempotency_key: `e2e-full-coverage-${new Date().toISOString().slice(0, 10)}`,
    });
    if (!started?.task_id) {
        if (started) fail("people-search", `no task_id in ${JSON.stringify(started).slice(0, 200)}`);
        return;
    }
    pass("people-search", `task ${started.task_id}, reserved ${started.reserved_cost_usd} USD`);
    const deadline = Date.now() + 8 * 60 * 1000;
    let status = started;
    while (!status.done && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20_000));
        const next = await callJson(client, "people-search-status", { task_id: started.task_id, include_people: false });
        if (!next) return;
        status = next;
    }
    if (!status.done) {
        fail("people-search-status", `task ${started.task_id} still ${status.status} after 8 minutes`);
        return;
    }
    pass("people-search-status", `${status.status}, ${status.result_count} people`);
    await exportPeople(client, { task_id: started.task_id, max_rows: 3 }, "people-search-export (new task)");
}

async function main() {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(ROOT, "build", "index.js")],
        env: { ...getDefaultEnvironment(), DESEARCH_API_KEY: apiKey },
        stderr: "pipe",
    });
    transport.stderr?.on("data", () => {});
    const client = new Client({ name: "e2e-full-coverage", version: "0.7.0" });
    await client.connect(transport);
    try {
        const { tools } = await client.listTools();
        const names = new Set(tools.map((tool) => tool.name));
        for (const name of ["search-api", "tiktok", "facebook", "instagram", "people-search-export"]) {
            if (names.has(name)) pass(`tools/list ${name}`);
            else fail(`tools/list ${name}`, "not listed");
        }

        // Search API: count 10 is the smallest the route accepts.
        const search = await callJson(client, "search-api", { query: "desearch ai search api", count: 10, mode: "fast" });
        if (search) {
            if (Array.isArray(search.results)) pass("search-api", `${search.results.length} results`);
            else fail("search-api", `no results array in ${JSON.stringify(search).slice(0, 200)}`);
        }

        // TikTok: 7 actions. The video id for post and comments comes from the profile's posts.
        await list(client, "tiktok", { action: "search", query: "ai", count: 3 });
        const tiktokPosts = await list(client, "tiktok", { action: "profile_posts", username: "tiktok", count: 2 });
        await list(client, "tiktok", { action: "hashtag", tag: "ai", count: 2 });
        await list(client, "tiktok", { action: "trending", region: "US", count: 3 });
        await item(client, "tiktok", { action: "profile", username: "tiktok" });
        const videoId = firstField(tiktokPosts, "id");
        await item(client, "tiktok", { action: "post", id: videoId }, videoId ? undefined : "no video id from tiktok.profile_posts");
        if (videoId) await list(client, "tiktok", { action: "comments", video_id: videoId, count: 3 });
        else fail("tiktok.comments", "no video id from tiktok.profile_posts");

        // Facebook: 6 actions. search and hashtag read the Meta Ad Library.
        await list(client, "facebook", { action: "search", query: "ai", count: 2 });
        const facebookPosts = await list(client, "facebook", { action: "profile_posts", profile_id: "facebook", count: 2 });
        await list(client, "facebook", { action: "hashtag", tag: "ai", count: 2 });
        await item(client, "facebook", { action: "profile", profile_id: "facebook" });
        const postId = firstField(facebookPosts, "id");
        await item(client, "facebook", { action: "post", id: postId }, postId ? undefined : "no post id from facebook.profile_posts");
        if (postId) await list(client, "facebook", { action: "comments", post_id: postId, count: 3 });
        else fail("facebook.comments", "no post id from facebook.profile_posts");

        // Instagram: 6 actions. comments needs the post shortcode.
        await list(client, "instagram", { action: "search", query: "instagram", count: 3 });
        const instagramPosts = await list(client, "instagram", { action: "profile_posts", username: "instagram", count: 2 });
        await list(client, "instagram", { action: "hashtag", tag: "ai", count: 2 });
        await item(client, "instagram", { action: "profile", username: "instagram" });
        const shortcode = firstField(instagramPosts, "shortcode");
        await item(client, "instagram", { action: "media", id: shortcode }, shortcode ? undefined : "no shortcode from instagram.profile_posts");
        if (shortcode) await list(client, "instagram", { action: "comments", shortcode, count: 3 });
        else fail("instagram.comments", "no shortcode from instagram.profile_posts");

        // One cursor page: send the first next_cursor back unchanged on the same action and target.
        const followed = cursors[0];
        if (followed) {
            await list(
                client,
                followed.tool,
                { ...followed.args, cursor: followed.cursor },
                `${followed.tool}.${followed.args.action} page 2`
            );
        } else {
            console.log("SKIP cursor page: no list call returned next_cursor");
        }

        // People Search export is free. A platform export needs no job.
        await exportPeople(client, { platform: "tiktok", max_rows: 3 }, "people-search-export (platform)");
        if (existingTaskId) {
            await exportPeople(client, { task_id: existingTaskId, format: "jsonl", max_rows: 3 }, "people-search-export (task)");
        }
        if (withPeople) {
            await runPeopleJob(client);
        } else {
            console.log("SKIP people-search job: pass --with-people to start one (paid)");
        }
    } finally {
        await client.close();
    }
}

main()
    .catch((error) => fail("e2e", error))
    .finally(() => {
        console.log(failures === 0 ? "All calls passed." : `${failures} call(s) failed.`);
        process.exitCode = failures === 0 ? 0 : 1;
    });
