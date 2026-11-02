import assert from "node:assert/strict";
import test from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDesearchMcpServer } from "../build/server.js";
import { PEOPLE_EXPORT_MAX_CHARS, exportRecordEnds, truncateExport } from "../build/people.js";

const API = "https://api.desearch.ai";
const TASK_ID = "3f1c2b9e-8d4a-4c1e-9b7a-2e5f6a7b8c9d";

// Python's csv writer: \r\n line ends, and a field with a line break or a quote is quoted.
function csvFile(rows) {
    const header = "handle,name,bio,score\r\n";
    return (
        header +
        Array.from({ length: rows }, (_, i) =>
            i % 2 === 0
                ? `creator${i},Creator ${i},"Line one\nline two, with ""quotes""",${80 + (i % 20)}\r\n`
                : `creator${i},Creator ${i},Short bio,${80 + (i % 20)}\r\n`
        ).join("")
    );
}

function jsonlFile(rows) {
    return Array.from({ length: rows }, (_, i) => JSON.stringify({ handle: `creator${i}`, bio: "a\nb" }) + "\n").join("");
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
        reply(status, body, contentType) {
            pool.intercept({ method: () => true, path: () => true }).reply(
                status,
                (opts) => {
                    seen.push({ method: opts.method, path: opts.path });
                    return body;
                },
                { headers: { "content-type": contentType } }
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
    const client = new Client({ name: "people-export", version: "0.0.1" });
    try {
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
        await fn(client, mock);
    } finally {
        await client.close();
        await server.close();
        await mock.restore();
    }
}

function split(path) {
    const url = new URL(path, API);
    return { pathname: url.pathname, query: Object.fromEntries(url.searchParams) };
}

function texts(result) {
    return result.content.map((block) => {
        assert.equal(block.type, "text");
        return block.text;
    });
}

test("exportRecordEnds counts CSV rows with quoted line breaks and JSON Lines rows", () => {
    const csv = csvFile(4);
    assert.equal(exportRecordEnds(csv, "csv").length, 5);
    // A naive line split would see 7 lines (two rows carry a line break in their bio).
    assert.equal(csv.split("\n").filter(Boolean).length, 7);
    assert.equal(exportRecordEnds(jsonlFile(3), "jsonl").length, 3);
    assert.deepEqual(exportRecordEnds("", "csv"), []);
    assert.equal(exportRecordEnds("a,b\r\n1,2", "csv").length, 2);
    assert.equal(exportRecordEnds("a,b\r\n\r\n1,2\r\n\r\n", "csv").length, 2);
});

test("truncateExport keeps the header and whole rows, and counts the rows it cut", () => {
    const csv = csvFile(10);
    const kept = truncateExport(csv, "csv", 3);
    assert.equal(kept.total_rows, 10);
    assert.equal(kept.returned_rows, 3);
    assert.equal(kept.cut_rows, 7);
    assert.equal(kept.char_limited, false);
    // A prefix of the file: header plus the first three rows, byte for byte.
    assert.ok(csv.startsWith(kept.text));
    assert.ok(kept.text.endsWith('creator2,Creator 2,"Line one\nline two, with ""quotes""",82\r\n'));

    const whole = truncateExport(csv, "csv", 100);
    assert.equal(whole.text, csv);
    assert.equal(whole.cut_rows, 0);

    const byChars = truncateExport(csv, "csv", 100, 200);
    assert.equal(byChars.char_limited, true);
    assert.ok(byChars.text.length <= 200);
    assert.equal(byChars.returned_rows + byChars.cut_rows, 10);
    assert.ok(byChars.returned_rows > 0 && byChars.returned_rows < 10);

    const headerOnly = truncateExport("handle,name\r\n", "csv", 5);
    assert.deepEqual(headerOnly, { text: "handle,name\r\n", total_rows: 0, returned_rows: 0, cut_rows: 0, char_limited: false });

    const jsonl = truncateExport(jsonlFile(5), "jsonl", 2);
    assert.equal(jsonl.returned_rows, 2);
    assert.equal(jsonl.cut_rows, 3);
    assert.equal(jsonl.text.trim().split("\n").length, 2);
});

test("people-search-export exports one task as CSV with filters and a note on what was cut", async () => {
    await withServer(async (client, mock) => {
        mock.reply(200, csvFile(250), "text/csv; charset=utf-8");
        const result = await client.callTool({
            name: "people-search-export",
            arguments: {
                task_id: TASK_ID,
                has: ["email", "instagram"],
                min_audience: 1000,
                max_audience: 500000,
                min_score: 70,
                location: "united states",
                verified: false,
                max_rows: 20,
            },
        });
        assert.equal(result.isError, undefined, texts(result)[0]);
        const { pathname, query } = split(mock.seen[0].path);
        assert.equal(mock.seen[0].method, "GET");
        assert.equal(pathname, `/desearch/people/tasks/${TASK_ID}/export`);
        assert.deepEqual(query, {
            format: "csv",
            has: "email,instagram",
            min_audience: "1000",
            max_audience: "500000",
            min_score: "70",
            location: "united states",
            verified: "false",
        });
        const [note, data] = texts(result);
        assert.equal(
            note,
            `CSV export of task ${TASK_ID}: 250 rows. Showing the first 20 rows; 230 rows were cut by max_rows 20. For the whole file, call GET https://api.desearch.ai/desearch/people/tasks/${TASK_ID}/export?format=csv (plus the same filters) with your API key, or page through people with people-search-status or people-profiles.`
        );
        assert.ok(data.startsWith("handle,name,bio,score\r\n"));
        assert.equal(exportRecordEnds(data, "csv").length, 21);
        assert.ok(csvFile(250).startsWith(data));
    });
});

test("people-search-export defaults to 100 rows and stops before the character limit", async () => {
    await withServer(async (client, mock) => {
        mock.reply(200, csvFile(150), "text/csv; charset=utf-8");
        const byRows = await client.callTool({ name: "people-search-export", arguments: { task_id: TASK_ID } });
        assert.match(texts(byRows)[0], /150 rows\. Showing the first 100 rows; 50 rows were cut by max_rows 100\./);

        // Long rows: the character limit cuts before max_rows does.
        const longRow = (i) => `creator${i},Name,"${"x".repeat(2000)}",90\r\n`;
        const big = "handle,name,bio,score\r\n" + Array.from({ length: 80 }, (_, i) => longRow(i)).join("");
        mock.reply(200, big, "text/csv; charset=utf-8");
        const byChars = await client.callTool({
            name: "people-search-export",
            arguments: { task_id: TASK_ID, max_rows: 1000 },
        });
        const [note, data] = texts(byChars);
        assert.ok(data.length <= PEOPLE_EXPORT_MAX_CHARS, String(data.length));
        const kept = exportRecordEnds(data, "csv").length - 1;
        assert.ok(kept > 0 && kept < 80);
        assert.equal(
            note.split(" For the whole file")[0],
            `CSV export of task ${TASK_ID}: 80 rows. Showing the first ${kept} rows; ${80 - kept} rows were cut to keep this reply under 50,000 characters.`
        );
    });
});

test("people-search-export exports everyone found on a platform as JSON Lines", async () => {
    await withServer(async (client, mock) => {
        mock.reply(200, jsonlFile(3), "application/x-ndjson");
        const result = await client.callTool({
            name: "people-search-export",
            arguments: { platform: "tiktok", format: "jsonl", q: "skincare", sort: "audience", has: ["email"] },
        });
        assert.equal(result.isError, undefined, texts(result)[0]);
        const { pathname, query } = split(mock.seen[0].path);
        assert.equal(pathname, "/desearch/people/profiles/export");
        assert.deepEqual(query, { platform: "tiktok", q: "skincare", sort: "audience", format: "jsonl", has: "email" });
        const [note, data] = texts(result);
        assert.equal(note, "JSON Lines export of everyone found on tiktok: 3 rows, all shown.");
        assert.equal(data, jsonlFile(3));

        // A single JSON Lines row is still returned as file text, not re-serialized JSON.
        mock.reply(200, jsonlFile(1), "application/x-ndjson");
        const one = await client.callTool({ name: "people-search-export", arguments: { platform: "x", format: "jsonl" } });
        assert.deepEqual(texts(one), ["JSON Lines export of everyone found on x: 1 row, all shown.", jsonlFile(1)]);

        // An empty export returns only the note.
        mock.reply(200, "", "application/x-ndjson");
        const empty = await client.callTool({ name: "people-search-export", arguments: { platform: "x", format: "jsonl" } });
        assert.deepEqual(texts(empty), ["JSON Lines export of everyone found on x: 0 rows, all shown."]);
    });
});

test("people-search-export checks its arguments before any request", async () => {
    await withServer(async (client, mock) => {
        const neither = await client.callTool({ name: "people-search-export", arguments: {} });
        assert.equal(neither.isError, true);
        assert.equal(
            texts(neither)[0],
            "People Search Export error: Send task_id to export one search, or platform to export everyone your searches found on it."
        );

        const both = await client.callTool({
            name: "people-search-export",
            arguments: { task_id: TASK_ID, platform: "tiktok", q: "skincare" },
        });
        assert.equal(both.isError, true);
        assert.equal(
            texts(both)[0],
            "People Search Export error: platform, q apply only to a platform export. Send task_id to export one search, or platform (without task_id) to export everyone your searches found on it."
        );

        for (const args of [
            { task_id: "not-a-uuid" },
            { platform: "instagram" },
            { platform: "x", format: "xlsx" },
            { platform: "x", max_rows: 0 },
            { platform: "x", max_rows: 1001 },
            { platform: "x", has: ["phone"] },
            { platform: "x", min_score: 101 },
            { platform: "x", limit: 10 },
        ]) {
            const rejected = await client.callTool({ name: "people-search-export", arguments: args });
            assert.equal(rejected.isError, true, JSON.stringify(args));
            assert.match(texts(rejected)[0], /Input validation error/, JSON.stringify(args));
        }
        assert.equal(mock.seen.length, 0);
    });
});

test("people-search-export reports a missing or expired task", async () => {
    await withServer(async (client, mock) => {
        mock.reply(404, JSON.stringify({ detail: "Task not found" }), "application/json");
        const missing = await client.callTool({ name: "people-search-export", arguments: { task_id: TASK_ID } });
        assert.equal(missing.isError, true);
        assert.equal(texts(missing)[0], "People Search Export error: HTTP 404: Task not found");

        mock.reply(410, JSON.stringify({ detail: "Results expired 30 days after the search ended." }), "application/json");
        const expired = await client.callTool({ name: "people-search-export", arguments: { task_id: TASK_ID } });
        assert.equal(texts(expired)[0], "People Search Export error: HTTP 410: Results expired 30 days after the search ended.");
    });
});
