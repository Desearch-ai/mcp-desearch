import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDesearchMcpServer } from "../build/server.js";
import {
    AI_SEARCH_TOOLS,
    LEGACY_DISPLAY_TO_ID,
    WEB_LINK_TOOLS,
    canonicalToolId,
} from "../build/tool-sources.js";
import {
    PEOPLE_CONTROL_ACTIONS,
    PEOPLE_FILTER_CHANNELS,
    PEOPLE_PLATFORMS,
    PEOPLE_PROFILE_SORTS,
    PEOPLE_SEARCH_FILTERS,
    PEOPLE_TASK_STATUSES,
} from "../build/people.js";

function textOf(result) {
    assert.equal(result.content[0].type, "text");
    return result.content[0].text;
}

async function withFakeClient(fake, fn) {
    const server = createDesearchMcpServer("ignored-when-client-is-injected", fake);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "tool-enums", version: "0.0.1" });
    try {
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
        await fn(client);
    } finally {
        await client.close();
        await server.close();
    }
}

const AI_SEARCH_ENUM = ["web", "twitter", "arxiv", "wikipedia", "hackernews", "reddit"];

test("canonicalToolId maps legacy display labels and leaves short ids alone", () => {
    assert.deepEqual([...AI_SEARCH_TOOLS], AI_SEARCH_ENUM);
    assert.equal(canonicalToolId("Web Search"), "web");
    assert.equal(canonicalToolId("Twitter Search"), "twitter");
    assert.equal(canonicalToolId("ArXiv Search"), "arxiv");
    assert.equal(canonicalToolId("Wikipedia Search"), "wikipedia");
    assert.equal(canonicalToolId("Hacker News Search"), "hackernews");
    assert.equal(canonicalToolId("Reddit Search"), "reddit");
    assert.equal(canonicalToolId("web"), "web");
    assert.equal(canonicalToolId("not-a-source"), "not-a-source");
    assert.equal(canonicalToolId("Youtube Search"), "Youtube Search");
    assert.equal(canonicalToolId("youtube"), "youtube");
    assert.equal(Object.hasOwn(LEGACY_DISPLAY_TO_ID, "Youtube Search"), false);
    for (const [label, id] of Object.entries(LEGACY_DISPLAY_TO_ID)) {
        assert.equal(canonicalToolId(label), id);
        assert.equal(AI_SEARCH_TOOLS.includes(id), true, id);
        assert.equal(/youtube/i.test(label), false, label);
        assert.equal(/youtube/i.test(id), false, id);
    }
    const allowed = [...AI_SEARCH_TOOLS, ...Object.keys(LEGACY_DISPLAY_TO_ID), ...Object.values(LEGACY_DISPLAY_TO_ID)];
    assert.equal(allowed.some((value) => /youtube/i.test(value)), false);
    for (const id of ["web", "twitter", "reddit", "arxiv", "wikipedia", "hackernews"]) {
        assert.equal(AI_SEARCH_TOOLS.includes(id), true, id);
    }
    assert.equal(WEB_LINK_TOOLS.includes("twitter"), false);
    assert.equal(WEB_LINK_TOOLS.includes("web"), true);
});

test("ai-search and web-links-search schemas use short ids and validate both ways", async () => {
    const calls = [];
    const fake = {
        async aiSearch(payload) {
            calls.push(["aiSearch", payload.tools]);
            return { completion: "ok" };
        },
        async aiWebLinksSearch(payload) {
            calls.push(["aiWebLinksSearch", payload.tools]);
            return { search_results: [] };
        },
    };

    await withFakeClient(fake, async (client) => {
        const listed = await client.listTools();
        const aiSearch = listed.tools.find((tool) => tool.name === "ai-search");
        const webLinks = listed.tools.find((tool) => tool.name === "web-links-search");

        assert.deepEqual(aiSearch.inputSchema.properties.tools.items.enum, AI_SEARCH_ENUM);
        assert.deepEqual(aiSearch.inputSchema.properties.tools.items.enum, [...AI_SEARCH_TOOLS]);
        for (const id of ["web", "twitter", "reddit", "arxiv", "wikipedia", "hackernews"]) {
            assert.equal(aiSearch.inputSchema.properties.tools.items.enum.includes(id), true, id);
        }
        assert.equal(JSON.stringify(aiSearch.inputSchema).toLowerCase().includes("youtube"), false);
        assert.equal(aiSearch.inputSchema.properties.tools.items.enum.includes("Web Search"), false);
        assert.deepEqual(aiSearch.inputSchema.properties.tools.default, ["web", "twitter"]);
        assert.deepEqual(webLinks.inputSchema.properties.tools.items.enum, [...WEB_LINK_TOOLS]);
        assert.equal(webLinks.inputSchema.properties.tools.items.enum.includes("Web Search"), false);
        assert.equal(webLinks.inputSchema.properties.tools.items.enum.includes("twitter"), false);

        const shortAi = await client.callTool({
            name: "ai-search",
            arguments: { prompt: "latest", tools: ["web"] },
        });
        assert.equal(shortAi.isError, undefined);
        assert.equal(JSON.parse(textOf(shortAi)).completion, "ok");

        const legacyAi = await client.callTool({
            name: "ai-search",
            arguments: { prompt: "latest", tools: ["Web Search", "Twitter Search"] },
        });
        assert.equal(legacyAi.isError, undefined);

        const aliases = await client.callTool({
            name: "ai-search",
            arguments: {
                prompt: "latest",
                tools: ["reddit", "ArXiv Search", "Wikipedia Search", "Hacker News Search"],
            },
        });
        assert.equal(aliases.isError, undefined);

        const rejectedAi = await client.callTool({
            name: "ai-search",
            arguments: { prompt: "latest", tools: ["not-a-source"] },
        });
        assert.equal(rejectedAi.isError, true);

        for (const source of ["youtube", "Youtube", "YOUTUBE", "Youtube Search"]) {
            const rejectedSource = await client.callTool({
                name: "ai-search",
                arguments: { prompt: "latest", tools: [source] },
            });
            assert.equal(rejectedSource.isError, true, source);
        }

        const shortLinks = await client.callTool({
            name: "web-links-search",
            arguments: { prompt: "latest", tools: ["web"] },
        });
        assert.equal(shortLinks.isError, undefined);

        const extraSource = await client.callTool({
            name: "web-links-search",
            arguments: { prompt: "latest", tools: ["web", "reddit"] },
        });
        assert.equal(extraSource.isError, true);

        const legacyLinks = await client.callTool({
            name: "web-links-search",
            arguments: { prompt: "latest", tools: ["Web Search"] },
        });
        assert.equal(legacyLinks.isError, undefined);

        const twitterOnLinks = await client.callTool({
            name: "web-links-search",
            arguments: { prompt: "latest", tools: ["twitter"] },
        });
        assert.equal(twitterOnLinks.isError, true);

        const displayTwitterOnLinks = await client.callTool({
            name: "web-links-search",
            arguments: { prompt: "latest", tools: ["Twitter Search"] },
        });
        assert.equal(displayTwitterOnLinks.isError, true);

        const rejectedLinks = await client.callTool({
            name: "web-links-search",
            arguments: { prompt: "latest", tools: ["not-a-source"] },
        });
        assert.equal(rejectedLinks.isError, true);
    });

    assert.deepEqual(calls, [
        ["aiSearch", ["web"]],
        ["aiSearch", ["web", "twitter"]],
        ["aiSearch", ["reddit", "arxiv", "wikipedia", "hackernews"]],
        ["aiWebLinksSearch", ["web"]],
        ["aiWebLinksSearch", ["web"]],
    ]);
});

// Values from desearch-public-api: model/people.py (TaskStatus, platforms),
// utils/people_filters.py (FILTER_CHANNELS), routers/people.py (PROFILE_SORTS, control routes).
const PEOPLE_PLATFORM_ENUM = ["x", "youtube", "linkedin", "tiktok"];
const PEOPLE_STATUS_ENUM = [
    "queued",
    "running",
    "pausing",
    "paused",
    "cancelling",
    "completed",
    "partial",
    "failed",
    "cancelled",
    "expired",
];
const PEOPLE_CHANNEL_ENUM = ["email", "website", "x", "linkedin", "instagram", "youtube", "tiktok"];

test("people tools advertise the People Search API enums", async () => {
    assert.deepEqual([...PEOPLE_PLATFORMS], PEOPLE_PLATFORM_ENUM);
    assert.deepEqual([...PEOPLE_TASK_STATUSES], PEOPLE_STATUS_ENUM);
    assert.deepEqual([...PEOPLE_FILTER_CHANNELS], PEOPLE_CHANNEL_ENUM);
    assert.deepEqual([...PEOPLE_PROFILE_SORTS], ["score", "recent", "audience"]);
    assert.deepEqual([...PEOPLE_CONTROL_ACTIONS], ["pause", "resume", "cancel"]);
    assert.deepEqual(Object.keys(PEOPLE_SEARCH_FILTERS), PEOPLE_PLATFORM_ENUM);

    await withFakeClient({}, async (client) => {
        const { tools } = await client.listTools();
        const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema.properties]));

        assert.deepEqual(byName["people-search"].platform.enum, PEOPLE_PLATFORM_ENUM);
        assert.deepEqual(byName["people-profiles"].platform.enum, PEOPLE_PLATFORM_ENUM);
        assert.deepEqual(byName["people-search-tasks"].platform.enum, PEOPLE_PLATFORM_ENUM);
        assert.deepEqual(byName["people-search-tasks"].status.items.enum, PEOPLE_STATUS_ENUM);
        assert.deepEqual(byName["people-profiles"].has.items.enum, PEOPLE_CHANNEL_ENUM);
        assert.deepEqual(byName["people-profiles"].sort.enum, ["score", "recent", "audience"]);
        assert.deepEqual(byName["people-search-export"].platform.enum, PEOPLE_PLATFORM_ENUM);
        assert.deepEqual(byName["people-search-export"].has.items.enum, PEOPLE_CHANNEL_ENUM);
        assert.deepEqual(byName["people-search-export"].sort.enum, ["score", "recent", "audience"]);
        assert.equal(byName["people-search-export"].task_id.format, "uuid");
        assert.equal(byName["people-search-control"], undefined);
        for (const name of ["people-search-pause", "people-search-resume", "people-search-cancel"]) {
            assert.deepEqual(Object.keys(byName[name]), ["task_id"], name);
        }

        // Every platform filter is an argument, and every filter argument belongs to a platform.
        const filterArgs = new Set(Object.values(PEOPLE_SEARCH_FILTERS).flat());
        for (const name of filterArgs) {
            assert.equal(typeof byName["people-search"][name], "object", name);
        }
        const common = ["platform", "query", "count", "min_score", "exclude", "metadata", "idempotency_key"];
        assert.deepEqual(
            Object.keys(byName["people-search"]).filter((name) => !common.includes(name)).sort(),
            [...filterArgs].sort()
        );

        for (const platform of ["instagram", "twitter", "X"]) {
            const rejected = await client.callTool({
                name: "people-search",
                arguments: { platform, query: "skincare creators" },
            });
            assert.equal(rejected.isError, true, platform);
            assert.match(rejected.content[0].text, /Input validation error/, platform);
        }
    });
});
