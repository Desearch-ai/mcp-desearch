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
import {
    COMPANY_REQUIREMENTS,
    COMPANY_ROLES,
    COMPANY_TASK_STATUSES,
    COMPANY_TASK_TYPES,
} from "../build/companies.js";
import {
    MONITOR_EVENTS,
    MONITOR_INTERVALS,
    MONITOR_META_ADS_COUNTS,
    MONITOR_SOURCES,
    MONITOR_STATUSES,
    MONITOR_TIKTOK_COUNTS,
    MONITOR_WEB_COUNTS,
} from "../build/monitors.js";

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

// Values from desearch-public-api: model/companies.py (Role, Requirement, TaskStatus reused
// from model/people.py) and routers/companies.py (TYPE_SERVICES).
const COMPANY_ROLE_ENUM = ["ceo", "founder", "cto", "cfo", "coo", "cmo", "president", "owner", "managing_director"];
const COMPANY_REQUIRE_ENUM = ["email", "phone", "linkedin", "leader", "leader_email"];

test("company tools advertise the Company Search API enums", async () => {
    assert.deepEqual([...COMPANY_ROLES], COMPANY_ROLE_ENUM);
    assert.deepEqual([...COMPANY_REQUIREMENTS], COMPANY_REQUIRE_ENUM);
    assert.deepEqual([...COMPANY_TASK_TYPES], ["search", "enrich"]);
    assert.deepEqual([...COMPANY_TASK_STATUSES], PEOPLE_STATUS_ENUM);

    await withFakeClient({}, async (client) => {
        const { tools } = await client.listTools();
        const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema.properties]));

        for (const name of ["company-search", "company-enrich"]) {
            assert.deepEqual(byName[name].roles.items.enum, COMPANY_ROLE_ENUM, name);
            assert.equal(byName[name].roles.minItems, 1, name);
            assert.equal(byName[name].infer_emails.type, "boolean", name);
            assert.equal(byName[name].verify_emails.type, "boolean", name);
            assert.equal(byName[name].idempotency_key.maxLength, 200, name);
            assert.equal(byName[name].metadata.type, "object", name);
        }
        assert.deepEqual(byName["company-search"].require.items.enum, COMPANY_REQUIRE_ENUM);
        assert.equal(byName["company-search"].countries.maxItems, 20);
        assert.equal(byName["company-search"].exclude.maxItems, 1000);
        assert.deepEqual(
            Object.keys(byName["company-search"]).sort(),
            [
                "count",
                "countries",
                "exclude",
                "idempotency_key",
                "infer_emails",
                "metadata",
                "min_score",
                "query",
                "require",
                "roles",
                "verify_emails",
            ]
        );
        assert.deepEqual(
            Object.keys(byName["company-enrich"]).sort(),
            ["domains", "idempotency_key", "infer_emails", "metadata", "roles", "verify_emails"]
        );
        assert.deepEqual(byName["company-search-tasks"].type.enum, ["search", "enrich"]);
        assert.deepEqual(byName["company-search-tasks"].status.items.enum, PEOPLE_STATUS_ENUM);
        assert.deepEqual(
            Object.keys(byName["company-search-status"]),
            ["task_id", "cursor", "limit", "include_companies"]
        );
        for (const name of ["company-search-pause", "company-search-resume", "company-search-cancel"]) {
            assert.deepEqual(Object.keys(byName[name]), ["task_id"], name);
        }

        for (const role of ["CEO", "vp", "chairman"]) {
            const rejected = await client.callTool({
                name: "company-search",
                arguments: { query: "fintech startups", roles: [role] },
            });
            assert.equal(rejected.isError, true, role);
            assert.match(rejected.content[0].text, /Input validation error/, role);
        }
    });
});

// Values from desearch-public-api model/monitors.py (MonitorSource, MONITOR_INTERVALS,
// MonitorEvent, WebOptions.count, MetaAdsOptions.count) and routers/monitors.py (the list status filter).
const MONITOR_SOURCE_ENUM = ["web", "x", "reddit", "youtube", "threads", "tiktok", "instagram", "facebook", "meta_ads"];
const MONITOR_INTERVAL_ENUM = ["1h", "3h", "6h", "12h", "1d", "7d"];
const MONITOR_EVENT_ENUM = ["monitor.items.found", "monitor.run.completed", "monitor.run.failed"];

test("monitor tools advertise the Monitors API enums and argument names", async () => {
    assert.deepEqual([...MONITOR_SOURCES], MONITOR_SOURCE_ENUM);
    assert.deepEqual([...MONITOR_INTERVALS], MONITOR_INTERVAL_ENUM);
    assert.deepEqual([...MONITOR_EVENTS], MONITOR_EVENT_ENUM);
    assert.deepEqual([...MONITOR_STATUSES], ["active", "paused"]);
    assert.deepEqual([...MONITOR_WEB_COUNTS], [10, 15, 20]);
    assert.deepEqual([...MONITOR_TIKTOK_COUNTS], [10, 20, 30]);
    assert.deepEqual([...MONITOR_META_ADS_COUNTS], [10, 20, 30]);

    await withFakeClient({}, async (client) => {
        const { tools } = await client.listTools();
        const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema.properties]));

        const settings = [
            "criteria",
            "facebook_pages",
            "instagram_accounts",
            "interval",
            "meta_ads_count",
            "metadata",
            "min_score",
            "name",
            "reddit_subreddits",
            "sources",
            "summary",
            "instagram_hashtags",
            "threads_accounts",
            "tiktok_accounts",
            "tiktok_count",
            "tiktok_hashtags",
            "web_count",
            "webhook_events",
            "webhook_url",
            "x_accounts",
            "x_count",
            "x_lang",
            "x_min_likes",
            "youtube_channels",
        ];
        assert.deepEqual(Object.keys(byName["monitor-create"]).sort(), [...settings, "query", "run_now"].sort());
        assert.deepEqual(
            Object.keys(byName["monitor-update"]).sort(),
            [...settings, "monitor_id", "query", "remove_webhook", "status"].sort()
        );
        for (const name of ["monitor-create", "monitor-update"]) {
            assert.deepEqual(byName[name].sources.items.enum, MONITOR_SOURCE_ENUM, name);
            assert.equal(byName[name].sources.minItems, 1, name);
            assert.deepEqual(byName[name].interval.enum, MONITOR_INTERVAL_ENUM, name);
            assert.deepEqual(byName[name].webhook_events.items.enum, MONITOR_EVENT_ENUM, name);
            assert.deepEqual(byName[name].web_count.enum, [10, 15, 20], name);
            assert.equal(byName[name].x_count.maximum, 100, name);
            assert.equal(byName[name].criteria.maxItems, 5, name);
            assert.equal(byName[name].metadata.type, "object", name);
            assert.deepEqual(byName[name].tiktok_count.enum, [10, 20, 30], name);
            assert.deepEqual(byName[name].meta_ads_count.enum, [10, 20, 30], name);
            for (const list of [
                "x_accounts",
                "reddit_subreddits",
                "youtube_channels",
                "tiktok_accounts",
                "tiktok_hashtags",
                "threads_accounts",
                "instagram_accounts",
                "instagram_hashtags",
                "facebook_pages",
            ]) {
                assert.equal(byName[name][list].type, "array", `${name} ${list}`);
                assert.equal(byName[name][list].maxItems, 10, `${name} ${list}`);
                assert.equal(byName[name][list].items.type, "string", `${name} ${list}`);
            }
        }
        assert.deepEqual(byName["monitor-update"].status.enum, ["active", "paused"]);
        assert.deepEqual(Object.keys(byName["monitor-estimate"]).sort(), [
            "facebook_pages",
            "instagram_accounts",
            "instagram_hashtags",
            "interval",
            "meta_ads_count",
            "reddit_subreddits",
            "sources",
            "summary",
            "threads_accounts",
            "tiktok_accounts",
            "tiktok_count",
            "tiktok_hashtags",
            "web_count",
            "x_accounts",
            "x_count",
            "youtube_channels",
        ]);
        assert.deepEqual(byName["monitor-estimate"].sources.items.enum, MONITOR_SOURCE_ENUM);
        assert.deepEqual(byName["monitor-list"].status.items.enum, ["active", "paused"]);
        assert.deepEqual(byName["monitor-items"].source.enum, MONITOR_SOURCE_ENUM);
        assert.equal(byName["monitor-items"].limit.maximum, 200);
        assert.equal(byName["monitor-runs"].limit.maximum, 100);
        assert.deepEqual(Object.keys(byName["monitor-run"]), ["monitor_id", "run_id"]);
        for (const name of [
            "monitor-get",
            "monitor-delete",
            "monitor-trigger",
            "monitor-webhook-test",
            "monitor-webhook-rotate-secret",
        ]) {
            assert.deepEqual(Object.keys(byName[name]), ["monitor_id"], name);
            assert.equal(byName[name].monitor_id.format, "uuid", name);
        }
    });
});
