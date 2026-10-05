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
