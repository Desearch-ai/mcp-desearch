#!/usr/bin/env node
/**
 * Live smoke test for the tools added in 0.8.0: youtube, reddit, and threads. It starts
 * the built server over stdio, connects with the MCP SDK client, and calls every action
 * once against a real Desearch API, plus a second page on each action that returned
 * next_cursor. Each call is billed as one request (about $0.002) to the key's balance.
 *
 *   npm run build
 *   DESEARCH_API_KEY=... node scripts/e2e-youtube-reddit-threads.mjs
 *   node scripts/e2e-youtube-reddit-threads.mjs --base-url https://api-dev.desearch.ai --key-env DESEARCH_DEV_API_KEY
 *
 * Options:
 *   --base-url <url>  Desearch API host (default https://api.desearch.ai). Passed to the
 *                     server as DESEARCH_API_BASE.
 *   --key-env <name>  environment variable that holds the key (default DESEARCH_API_KEY).
 *                     When it is not set, it is read from ~/.config/desearch/e2e.env.
 *
 * Prints one line per call, `PASS name` or `FAIL name: error`, and exits 1 if any call
 * failed. A 5xx or a dropped connection (a known provider flake) is retried once. The key
 * is never printed.
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

let failures = 0;
let calls = 0;

function pass(name, detail) {
    console.log(detail ? `PASS ${name} (${detail})` : `PASS ${name}`);
}

function fail(name, error) {
    failures++;
    const message = error instanceof Error ? error.message : String(error);
    console.log(`FAIL ${name}: ${message.split(apiKey).join("***").replace(/\s+/g, " ").slice(0, 300)}`);
}

function textOf(result) {
    return (result.content ?? []).map((block) => block.text ?? "").join("\n");
}

const FLAKE = /HTTP 5\d\d|Unexpected Error/;

/** Call one tool; return { error } or { value }. Retries once after a 5xx or a dropped connection. */
async function call(client, tool, toolArgs) {
    for (let attempt = 0; ; attempt++) {
        calls++;
        const result = await client.callTool({ name: tool, arguments: toolArgs });
        const text = textOf(result);
        if (!result.isError) {
            return { value: JSON.parse(text) };
        }
        if (attempt === 0 && FLAKE.test(text)) {
            console.log(`RETRY ${tool}.${toolArgs.action}: ${text.slice(0, 120)}`);
            continue;
        }
        return { error: text };
    }
}

function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A list action: PASS when it returns { results: [...objects], next_cursor, next }.
 * When it pages and returns next_cursor, read page 2 with that cursor unchanged.
 */
async function list(client, tool, toolArgs, { pages = true, emptyPage2Ok = false } = {}) {
    const label = `${tool}.${toolArgs.action}`;
    const first = await call(client, tool, toolArgs);
    const check = (page, name) => {
        if (!isObject(page) || !Array.isArray(page.results) || !page.results.every(isObject)) {
            throw new Error(`expected { results: [objects] }, got ${JSON.stringify(page).slice(0, 200)}`);
        }
        if (!pages && page.next_cursor !== null) {
            throw new Error(`${name} should not return a cursor`);
        }
        if (typeof page.next !== "string") {
            throw new Error("missing next");
        }
    };
    if (first.error) {
        fail(label, first.error);
        return [];
    }
    try {
        check(first.value, label);
    } catch (error) {
        fail(label, error);
        return [];
    }
    const cursor = first.value.next_cursor;
    pass(label, `${first.value.results.length} items, next_cursor ${cursor ? "returned" : "null"}`);
    if (!pages || !cursor) {
        if (pages) console.log(`NOTE ${label}: no next_cursor, so no page 2`);
        return first.value.results;
    }
    const second = await call(client, tool, { ...toolArgs, cursor });
    const label2 = `${label} page 2`;
    if (second.error) {
        fail(label2, second.error);
        return first.value.results;
    }
    try {
        check(second.value, label2);
        if (second.value.results.length === 0 && !emptyPage2Ok) {
            throw new Error("page 2 is empty");
        }
    } catch (error) {
        fail(label2, error);
        return first.value.results;
    }
    const firstIds = new Set(first.value.results.map((row) => row.id).filter(Boolean));
    const repeated = second.value.results.filter((row) => row.id && firstIds.has(row.id)).length;
    pass(
        label2,
        `${second.value.results.length} items, ${repeated} repeated from page 1, next_cursor ${second.value.next_cursor ? "returned" : "null"}` +
            (second.value.results.length === 0 ? " (empty page: known provider flake on this route)" : "")
    );
    return [...first.value.results, ...second.value.results];
}

/** A single-item action: PASS when it returns an object that has `field`. */
async function item(client, tool, toolArgs, field, label = `${tool}.${toolArgs.action}`) {
    const result = await call(client, tool, toolArgs);
    if (result.error) {
        fail(label, result.error);
        return undefined;
    }
    if (!isObject(result.value) || result.value[field] === undefined || result.value[field] === null) {
        fail(label, `expected an object with ${field}, got ${JSON.stringify(result.value).slice(0, 200)}`);
        return undefined;
    }
    return result.value;
}

async function main() {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(ROOT, "build", "index.js")],
        env: { ...getDefaultEnvironment(), DESEARCH_API_KEY: apiKey, DESEARCH_API_BASE: baseUrl },
        stderr: "pipe",
    });
    transport.stderr?.on("data", () => {});
    const client = new Client({ name: "e2e-youtube-reddit-threads", version: "0.8.0" });
    await client.connect(transport);
    console.log(`API: ${baseUrl} (key from ${keyEnv})`);
    try {
        const { tools } = await client.listTools();
        const names = new Set(tools.map((tool) => tool.name));
        for (const name of ["youtube", "reddit", "threads"]) {
            if (names.has(name)) pass(`tools/list ${name}`);
            else fail(`tools/list ${name}`, "not listed");
        }

        // YouTube: 6 actions.
        const videos = await list(client, "youtube", { action: "search", query: "bittensor", type: "videos" });
        const typed = videos.filter((row) => typeof row.type === "string").length;
        if (videos.length > 0 && typed !== videos.length) fail("youtube.search types", `${videos.length - typed} results without a type`);
        const video = await item(client, "youtube", { action: "video", id: "dQw4w9WgXcQ" }, "title");
        if (video) pass("youtube.video", `${video.title.slice(0, 40)}, ${video.captionLanguages?.length ?? 0} caption tracks`);
        const byUrl = await item(client, "youtube", { action: "video", id: "https://youtu.be/dQw4w9WgXcQ" }, "id", "youtube.video (URL id)");
        if (byUrl) {
            if (byUrl.id === "dQw4w9WgXcQ") pass("youtube.video (URL id)", "same video");
            else fail("youtube.video (URL id)", `got id ${byUrl.id}`);
        }
        const transcript = await item(
            client,
            "youtube",
            { action: "transcript", video_id: "dQw4w9WgXcQ", language: "en" },
            "segments"
        );
        if (transcript) {
            if (Array.isArray(transcript.segments) && transcript.segments.length > 0 && transcript.text) {
                pass("youtube.transcript", `${transcript.segments.length} segments, language ${transcript.language}`);
            } else {
                fail("youtube.transcript", "no segments or text");
            }
        }
        await list(client, "youtube", { action: "comments", video_id: "dQw4w9WgXcQ" });
        const channel = await item(client, "youtube", { action: "channel", handle: "@MrBeast" }, "id");
        if (channel) pass("youtube.channel", `${channel.handle ?? channel.name}, ${channel.subscribers ?? "?"} subscribers`);
        await list(client, "youtube", { action: "channel_videos", handle: "@MrBeast" });

        // Reddit: 5 actions. post and comments use a post from the subreddit listing.
        await list(client, "reddit", { action: "search", query: "bittensor" }, { emptyPage2Ok: true });
        const subreddit = await item(client, "reddit", { action: "subreddit", name: "AskReddit" }, "name");
        if (subreddit) pass("reddit.subreddit", `${subreddit.name}, ${subreddit.weeklyActiveUsers ?? "?"} weekly active users`);
        const posts = await list(client, "reddit", { action: "subreddit_posts", name: "AskReddit", sort: "top", timeframe: "week" });
        const postId = posts.find((row) => typeof row.id === "string" && (row.commentCount ?? 0) > 0)?.id ?? "1q6pxwn";
        const post = await item(client, "reddit", { action: "post", id: postId }, "id");
        if (post) pass("reddit.post", `${post.id}, ${post.commentCount ?? "?"} comments`);
        const comments = await list(client, "reddit", { action: "comments", post_id: postId });
        const withReplies = comments.filter((row) => Array.isArray(row.replies) && row.replies.length > 0).length;
        console.log(`NOTE reddit.comments: ${withReplies} of ${comments.length} comments have nested replies`);
        const badCursor = await call(client, "reddit", { action: "comments", post_id: postId, cursor: "not-a-cursor" });
        if (badCursor.error && /HTTP 422/.test(badCursor.error)) pass("reddit.comments invalid cursor", "HTTP 422, not charged");
        else fail("reddit.comments invalid cursor", `expected HTTP 422, got ${JSON.stringify(badCursor).slice(0, 200)}`);

        // Threads: 5 actions, one page each.
        await list(client, "threads", { action: "search", query: "bittensor" }, { pages: false });
        await list(client, "threads", { action: "search_users", query: "zuck" }, { pages: false });
        const profile = await item(client, "threads", { action: "profile", username: "zuck" }, "username");
        if (profile) pass("threads.profile", `${profile.username}, ${profile.followers ?? "?"} followers`);
        await list(client, "threads", { action: "profile_posts", username: "zuck" }, { pages: false });
        const threadsPost = await item(client, "threads", { action: "post", id: "DK-BydcJHkF" }, "code");
        if (threadsPost) {
            if (Array.isArray(threadsPost.comments) && Array.isArray(threadsPost.threadItems)) {
                pass("threads.post", `${threadsPost.comments.length} replies, ${threadsPost.threadItems.length} thread items`);
            } else {
                fail("threads.post", "missing comments or threadItems");
            }
        }
    } finally {
        await client.close();
    }
}

main()
    .catch((error) => fail("e2e", error))
    .finally(() => {
        console.log(`${calls} API calls (about $${(calls * 0.00207).toFixed(3)}).`);
        console.log(failures === 0 ? "All calls passed." : `${failures} call(s) failed.`);
        process.exitCode = failures === 0 ? 0 : 1;
    });
