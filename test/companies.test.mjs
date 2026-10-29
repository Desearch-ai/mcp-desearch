import assert from "node:assert/strict";
import test from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDesearchMcpServer } from "../build/server.js";
import {
    companyEnrichBody,
    companyNextStep,
    companySearchBody,
    compactCompany,
} from "../build/companies.js";

const API = "https://api.desearch.ai";
const TASK_ID = "5b33f3ee-168b-4780-9c8e-63a626781872";
const TASK_PATH = `/desearch/companies/tasks/${TASK_ID}`;
const JSON_HEADERS = { headers: { "content-type": "application/json" } };

// Shapes follow desearch-public-api src/model/companies.py (CompanyTask, Company) and
// docs/company-search.md.
const TASK = {
    task_id: TASK_ID,
    search_type: "company_search",
    platform: "company",
    status: "running",
    stage: "processing",
    query: "Series A fintech startups in Berlin building payment infrastructure",
    count: 25,
    result_count: 2,
    request: {
        query: "Series A fintech startups in Berlin building payment infrastructure",
        count: 25,
        min_score: 60,
        exclude: ["stripe.com"],
        roles: ["ceo", "founder", "cto", "cfo"],
        infer_emails: true,
        verify_emails: true,
        filters: { countries: ["DE"], require: ["email"] },
    },
    metadata: {},
    interpreted: { criteria: ["Series A fintech"], queries: ["fintech payment infrastructure startup Berlin"] },
    progress: {
        candidates_found: 140,
        candidates_processed: 60,
        qualified: 2,
        filtered: { unreachable: 4, not_a_company: 9, below_min_score: 3, no_email: 5 },
        enrichment: { published: 2, complete: 1, pending: 1, failed: 0 },
        email_checks: { checked: 6, valid: 3, invalid: 1, risky: 1, unknown: 1 },
        warnings: [],
    },
    errors: [],
    completion_reason: null,
    coverage_limited: false,
    warnings: [],
    reserved_cost_usd: 2.25,
    final_cost_usd: null,
    refunded_usd: null,
    created_by: { user_id: null, api_key_id: "5b0c7f6e-1d2a-4b3c-8d9e-0f1a2b3c4d5e", via: "api_key" },
    created_at: "2026-10-28T10:00:00Z",
    started_at: "2026-10-28T10:00:02Z",
    paused_at: null,
    finished_at: null,
    results_expire_at: null,
    links: { self: TASK_PATH, results: `${TASK_PATH}/results`, export: `${TASK_PATH}/export` },
};

const ENRICH_TASK = {
    ...TASK,
    search_type: "company_enrich",
    platform: "company_enrich",
    query: "acme.com, beta.io",
    count: 2,
    request: { domains: ["acme.com", "beta.io"], roles: ["ceo", "cto"], infer_emails: true, verify_emails: true },
    interpreted: null,
    reserved_cost_usd: 0.15,
};

const VERIFIED = (status, smtp = "skipped") => ({
    status,
    checks: { syntax: true, mx: "ok", smtp, web: "skipped" },
    checked_at: "2026-10-28T10:00:00Z",
});

// The result example of docs/company-search.md.
const ACME = {
    id: "company:acme.com",
    platform: "company",
    handle: "acme.com",
    domain: "acme.com",
    url: "https://acme.com/",
    name: "Acme",
    description: "Payment infrastructure for marketplaces.",
    logo_url: "https://acme.com/logo.png",
    location: { country: "DE", city: "Berlin", address: "Torstraße 1, 10119 Berlin" },
    industry: "Fintech",
    emails: [
        {
            value: "hello@acme.com",
            type: "general",
            source: "website",
            source_url: "https://acme.com/impressum",
            on_domain: true,
            person: null,
            confidence: null,
            pattern: null,
            verification: VERIFIED("valid"),
        },
        {
            value: "anna@acme.com",
            type: "personal",
            source: "website",
            source_url: "https://acme.com/team",
            on_domain: true,
            person: "Anna Schmidt",
            confidence: null,
            pattern: null,
            verification: null,
        },
        { value: "", type: "other", source: "website" },
    ],
    phones: [
        {
            value: "+493012345678",
            type: "main",
            source: "website",
            source_url: "https://acme.com/impressum",
            raw: "+49 30 1234 5678",
        },
    ],
    socials: [
        {
            type: "linkedin",
            url: "https://www.linkedin.com/company/acme",
            handle: "acme",
            source: "website",
            source_url: "https://acme.com/",
        },
        { type: "x", url: "", source: "website" },
    ],
    pages: [
        { type: "home", url: "https://acme.com/" },
        { type: "imprint", url: "https://acme.com/impressum" },
    ],
    people: [
        {
            name: "Anna Schmidt",
            title: "Co-founder & CEO",
            roles: ["ceo", "founder"],
            linkedin_url: "https://www.linkedin.com/in/annaschmidt",
            x_url: null,
            github_url: null,
            emails: [
                {
                    value: "anna.schmidt@acme.com",
                    type: "personal",
                    source: "inferred",
                    source_url: null,
                    on_domain: true,
                    person: "Anna Schmidt",
                    confidence: "high",
                    pattern: "first.last",
                    verification: VERIFIED("valid", "accepted"),
                },
            ],
            phones: [],
            evidence: {
                quote: "Anna Schmidt, Geschäftsführerin",
                source_url: "https://acme.com/impressum",
                source: "website",
            },
            verified: true,
        },
    ],
    primary_email: {
        value: "anna.schmidt@acme.com",
        type: "personal",
        source: "inferred",
        source_url: null,
        on_domain: true,
        person: "Anna Schmidt",
        confidence: "high",
        pattern: "first.last",
        verification: VERIFIED("valid", "accepted"),
    },
    primary_contact: {
        name: "Anna Schmidt",
        title: "Co-founder & CEO",
        email: "anna.schmidt@acme.com",
        linkedin_url: "https://www.linkedin.com/in/annaschmidt",
        reason: "CEO, email inferred from the company's pattern and verified",
    },
    contact_coverage: { email: true, phone: true, linkedin: true, leader: true, leader_email: true },
    enrichment: {
        status: "complete",
        stages: { profile: "done", contacts: "done", people: "done", email_patterns: "done", email_check: "done" },
        errors: [],
    },
    score: {
        value: 86,
        qualified: true,
        relevance: "high",
        summary: "Berlin payments infrastructure startup, Series A in 2025.",
        matched_signals: ["payments"],
        reasons: ["Payments infrastructure", "Based in Berlin", "Series A in 2025", "Hiring engineers"],
        concerns: [],
        criteria_checks: [
            {
                criterion: "Industry: payment infrastructure",
                verdict: "met",
                quote: "Payment infrastructure for marketplaces",
                source_url: "https://acme.com/",
                reason: "",
                is_disqualifier: false,
            },
            {
                criterion: "Stage: Series A",
                verdict: "unknown",
                quote: null,
                source_url: null,
                reason: "",
                is_disqualifier: false,
            },
        ],
        fully_verified: false,
    },
    found_by: [
        {
            query: "fintech payment infrastructure startup Berlin",
            url: "https://acme.com/",
            title: "Acme — Payments",
            kind: "direct",
        },
    ],
};

const ACME_COMPACT = {
    domain: "acme.com",
    name: "Acme",
    url: "https://acme.com/",
    industry: "Fintech",
    location: { country: "DE", city: "Berlin", address: "Torstraße 1, 10119 Berlin" },
    description: "Payment infrastructure for marketplaces.",
    score: 86,
    why: "Berlin payments infrastructure startup, Series A in 2025.",
    reasons: ["Payments infrastructure", "Based in Berlin", "Series A in 2025"],
    fully_verified: false,
    unverified_criteria: ["Stage: Series A (unknown)"],
    primary_email: {
        value: "anna.schmidt@acme.com",
        type: "personal",
        source: "inferred",
        person: "Anna Schmidt",
        confidence: "high",
        pattern: "first.last",
        verification: "valid",
    },
    primary_contact: {
        name: "Anna Schmidt",
        title: "Co-founder & CEO",
        email: "anna.schmidt@acme.com",
        linkedin_url: "https://www.linkedin.com/in/annaschmidt",
        reason: "CEO, email inferred from the company's pattern and verified",
    },
    contact_coverage: { email: true, phone: true, linkedin: true, leader: true, leader_email: true },
    emails: [
        {
            value: "hello@acme.com",
            type: "general",
            source: "website",
            source_url: "https://acme.com/impressum",
            verification: "valid",
        },
        {
            value: "anna@acme.com",
            type: "personal",
            source: "website",
            source_url: "https://acme.com/team",
            person: "Anna Schmidt",
        },
    ],
    phones: [{ value: "+493012345678", type: "main", source_url: "https://acme.com/impressum" }],
    socials: [{ type: "linkedin", url: "https://www.linkedin.com/company/acme", source_url: "https://acme.com/" }],
    leaders: [
        {
            name: "Anna Schmidt",
            title: "Co-founder & CEO",
            roles: ["ceo", "founder"],
            verified: true,
            linkedin_url: "https://www.linkedin.com/in/annaschmidt",
            emails: [
                {
                    value: "anna.schmidt@acme.com",
                    type: "personal",
                    source: "inferred",
                    confidence: "high",
                    pattern: "first.last",
                    verification: "valid",
                },
            ],
            evidence_url: "https://acme.com/impressum",
        },
    ],
    enrichment: {
        status: "complete",
        stages: { profile: "done", contacts: "done", people: "done", email_patterns: "done", email_check: "done" },
    },
};

// A Company Enrich result read right after its homepage: no score, later stages pending.
const BETA_PARTIAL = {
    id: "company:beta.io",
    platform: "company",
    handle: "beta.io",
    domain: "beta.io",
    url: "https://beta.io/",
    name: "Beta",
    description: "x".repeat(400),
    location: null,
    industry: null,
    emails: [],
    phones: [],
    socials: [],
    pages: [{ type: "home", url: "https://beta.io/" }],
    people: [],
    primary_email: null,
    primary_contact: null,
    contact_coverage: { email: false, phone: false, linkedin: false, leader: false, leader_email: false },
    enrichment: {
        status: "partial",
        stages: { profile: "done", contacts: "pending", people: "pending", email_patterns: "pending", email_check: "skipped" },
        errors: [{ stage: "contacts", message: "timeout reading https://beta.io/contact" }],
    },
    score: null,
    found_by: [],
};

const BETA_COMPACT = {
    domain: "beta.io",
    name: "Beta",
    url: "https://beta.io/",
    description: `${"x".repeat(297)}...`,
    score: null,
    contact_coverage: { email: false, phone: false, linkedin: false, leader: false, leader_email: false },
    enrichment: {
        status: "partial",
        stages: { profile: "done", contacts: "pending", people: "pending", email_patterns: "pending", email_check: "skipped" },
        errors: [{ stage: "contacts", message: "timeout reading https://beta.io/contact" }],
    },
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

async function withServer(fn) {
    const mock = installMock();
    const server = createDesearchMcpServer("test-key");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "companies", version: "0.0.1" });
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

test("company-search starts a billed task with filters, roles, email options, and metadata", async () => {
    await withServer(async (client, mock) => {
        const metadata = { campaign: "q4" };
        mock.reply("POST", "/desearch/companies/search", 202, {
            ...TASK,
            status: "queued",
            stage: null,
            result_count: 0,
            progress: {},
            started_at: null,
            metadata,
            cost_usd: 2.25,
            usage_count: 25,
            service: "/desearch/companies/search",
            currency: "USD",
        });

        const body = await call(client, "company-search", {
            query: "Series A fintech startups in Berlin building payment infrastructure",
            count: 25,
            min_score: 60,
            exclude: ["stripe.com"],
            roles: ["ceo", "founder", "cto", "cfo"],
            infer_emails: true,
            verify_emails: false,
            countries: ["DE"],
            require: ["email", "leader"],
            metadata,
            idempotency_key: "company-1",
        });
        assert.equal(body.task_id, TASK_ID);
        assert.equal(body.search_type, "company_search");
        assert.equal(body.status, "queued");
        assert.equal(body.done, false);
        assert.equal(body.count, 25);
        assert.equal(body.result_count, 0);
        assert.equal(body.reserved_cost_usd, 2.25);
        assert.equal(body.cost_usd, 2.25);
        assert.equal(body.currency, "USD");
        assert.deepEqual(body.metadata, metadata);
        assert.equal(body.existing_task, undefined);
        assert.match(body.next, /company-search-status/);
        for (const dropped of ["links", "created_by", "interpreted", "request", "platform", "progress", "stage", "final_cost_usd"]) {
            assert.equal(Object.hasOwn(body, dropped), false, dropped);
        }

        assert.equal(mock.seen.length, 1);
        const [sent] = mock.seen;
        assert.equal(sent.method, "POST");
        assert.equal(sent.path, "/desearch/companies/search");
        assert.deepEqual(sent.body, {
            query: "Series A fintech startups in Berlin building payment infrastructure",
            count: 25,
            min_score: 60,
            exclude: ["stripe.com"],
            roles: ["ceo", "founder", "cto", "cfo"],
            infer_emails: true,
            verify_emails: false,
            filters: { countries: ["DE"], require: ["email", "leader"] },
            metadata,
        });
        assert.equal(headerOf(sent.headers, "authorization"), "test-key");
        assert.equal(headerOf(sent.headers, "idempotency-key"), "company-1");
        assert.match(headerOf(sent.headers, "content-type"), /application\/json/);
    });
});

test("company-enrich sends the domains and only the options the caller set", async () => {
    await withServer(async (client, mock) => {
        mock.reply("POST", "/desearch/companies/enrich", 202, { ...ENRICH_TASK, status: "queued", result_count: 0 });
        mock.reply("POST", "/desearch/companies/enrich", 202, { ...ENRICH_TASK, status: "queued", result_count: 0 });

        const body = await call(client, "company-enrich", {
            domains: ["acme.com", "https://www.beta.io/about"],
            roles: ["ceo", "cto"],
            infer_emails: false,
            idempotency_key: "enrich-1",
        });
        assert.equal(body.search_type, "company_enrich");
        assert.equal(body.query, "acme.com, beta.io");
        assert.equal(body.count, 2);
        assert.match(body.next, /company-search-status/);

        await call(client, "company-enrich", { domains: ["acme.com"], metadata: {} });

        assert.deepEqual(
            mock.seen.map((sent) => [sent.path, sent.body, headerOf(sent.headers, "idempotency-key")]),
            [
                [
                    "/desearch/companies/enrich",
                    { domains: ["acme.com", "https://www.beta.io/about"], roles: ["ceo", "cto"], infer_emails: false },
                    "enrich-1",
                ],
                ["/desearch/companies/enrich", { domains: ["acme.com"] }, undefined],
            ]
        );
    });
});

test("company request bodies match the API models", () => {
    assert.deepEqual(companySearchBody({ query: "Fintech startups" }), { query: "Fintech startups" });
    assert.deepEqual(companySearchBody({ query: "Fintech startups", require: ["phone"], metadata: {} }), {
        query: "Fintech startups",
        filters: { require: ["phone"] },
    });
    assert.deepEqual(companySearchBody({ query: "Fintech startups", countries: ["Germany"], verify_emails: true }), {
        query: "Fintech startups",
        verify_emails: true,
        filters: { countries: ["Germany"] },
    });
    assert.deepEqual(companyEnrichBody({ domains: ["acme.com"] }), { domains: ["acme.com"] });
    assert.deepEqual(
        companyEnrichBody({ domains: ["acme.com"], roles: ["cfo"], verify_emails: false, metadata: { team: "a" } }),
        { domains: ["acme.com"], roles: ["cfo"], verify_emails: false, metadata: { team: "a" } }
    );
});

test("company-search and company-enrich mark a repeated idempotency_key as the first task", async () => {
    await withServer(async (client, mock) => {
        mock.reply("POST", "/desearch/companies/search", 200, { ...TASK, cost_usd: 0, currency: "USD" });
        mock.reply("POST", "/desearch/companies/enrich", 200, { ...ENRICH_TASK, cost_usd: 0, currency: "USD" });
        for (const [name, args] of [
            ["company-search", { query: "Fintech startups", idempotency_key: "same" }],
            ["company-enrich", { domains: ["acme.com"], idempotency_key: "same" }],
        ]) {
            const body = await call(client, name, args);
            assert.equal(body.existing_task, true, name);
            assert.equal(body.cost_usd, 0, name);
            assert.match(body.next, /not charged again/, name);
        }
    });
});

test("company-search and company-enrich reject bad input before any request", async () => {
    await withServer(async (client, mock) => {
        const elevenKeys = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, "v"]));
        for (const args of [
            { query: "hi" },
            { query: "x".repeat(1001) },
            { query: "Fintech startups", count: 4 },
            { query: "Fintech startups", count: 201 },
            { query: "Fintech startups", min_score: 101 },
            { query: "Fintech startups", roles: [] },
            { query: "Fintech startups", roles: ["vp_sales"] },
            { query: "Fintech startups", require: ["website"] },
            { query: "Fintech startups", countries: Array.from({ length: 21 }, (_, i) => `C${i}`) },
            { query: "Fintech startups", exclude: Array.from({ length: 1001 }, (_, i) => `d${i}.com`) },
            { query: "Fintech startups", filters: { countries: ["DE"] } },
            { query: "Fintech startups", platform: "company" },
            { query: "Fintech startups", metadata: { Campaign: "q4" } },
            { query: "Fintech startups", metadata: elevenKeys },
            { query: "Fintech startups", idempotency_key: "k".repeat(201) },
            {},
        ]) {
            const rejected = await client.callTool({ name: "company-search", arguments: args });
            assert.equal(rejected.isError, true, JSON.stringify(args).slice(0, 80));
            assert.match(textOf(rejected), /Input validation error/, JSON.stringify(args).slice(0, 80));
        }
        for (const args of [
            {},
            { domains: [] },
            { domains: [""] },
            { domains: Array.from({ length: 201 }, (_, i) => `d${i}.com`) },
            { domains: ["acme.com"], query: "Fintech startups" },
            { domains: ["acme.com"], count: 5 },
            { domains: ["acme.com"], roles: ["cmo", "intern"] },
            { domains: "acme.com" },
        ]) {
            const rejected = await client.callTool({ name: "company-enrich", arguments: args });
            assert.equal(rejected.isError, true, JSON.stringify(args).slice(0, 80));
            assert.match(textOf(rejected), /Input validation error/, JSON.stringify(args).slice(0, 80));
        }
        assert.equal(mock.seen.length, 0);
    });
});

test("company-search and company-enrich report API errors under their own titles", async () => {
    await withServer(async (client, mock) => {
        mock.reply("POST", "/desearch/companies/search", 402, {
            detail: "Company Search needs account credits. Add credits in the Desearch console to run a search.",
        });
        mock.reply("POST", "/desearch/companies/enrich", 422, {
            detail: [{ loc: ["body", "domains"], msg: "Value error, domains[0] '127.0.0.1' is an IP address, not a domain" }],
        });
        mock.reply("POST", "/desearch/companies/enrich", 429, {
            detail: "Too many People Search and Company Search tasks are already queued, running or paused.",
        });
        const noCredits = await client.callTool({ name: "company-search", arguments: { query: "Fintech startups" } });
        assert.equal(noCredits.isError, true);
        assert.equal(
            textOf(noCredits),
            "Company Search error: HTTP 402: Company Search needs account credits. Add credits in the Desearch console to run a search."
        );
        const badDomain = await client.callTool({ name: "company-enrich", arguments: { domains: ["127.0.0.1"] } });
        assert.equal(badDomain.isError, true);
        assert.match(textOf(badDomain), /^Company Enrich error: HTTP 422: .*is an IP address, not a domain/);
        const busy = await client.callTool({ name: "company-enrich", arguments: { domains: ["acme.com"] } });
        assert.match(textOf(busy), /^Company Enrich error: HTTP 429: Too many People Search and Company Search tasks/);
    });
});

test("company-search-status returns the task and a compact page of companies", async () => {
    await withServer(async (client, mock) => {
        mock.reply("GET", TASK_PATH, 200, TASK);
        mock.reply("GET", `${TASK_PATH}/results`, 200, {
            task_id: TASK_ID,
            status: "running",
            results: [ACME, BETA_PARTIAL],
            next_cursor: "2",
            has_more: false,
        });

        const body = await call(client, "company-search-status", { task_id: TASK_ID, cursor: "0", limit: 5 });
        const { warnings: _warnings, ...progress } = TASK.progress;
        assert.deepEqual(body, {
            task_id: TASK_ID,
            search_type: "company_search",
            status: "running",
            stage: "processing",
            done: false,
            query: "Series A fintech startups in Berlin building payment infrastructure",
            count: 25,
            result_count: 2,
            progress,
            reserved_cost_usd: 2.25,
            created_at: "2026-10-28T10:00:00Z",
            companies: [ACME_COMPACT, BETA_COMPACT],
            next_cursor: "2",
            has_more: false,
            next: 'Still running. Wait 15 to 30 seconds, then call company-search-status again with cursor "2" to get only the companies delivered since this call. Companies with enrichment status "partial" are still being filled in; when the task is done, call company-search-status without cursor to read every company in its latest version.',
        });

        assert.deepEqual(
            mock.seen.map((sent) => [sent.method, sent.path.split("?")[0], queryOf(sent.path)]),
            [
                ["GET", TASK_PATH, {}],
                ["GET", `${TASK_PATH}/results`, { cursor: "0", limit: "5" }],
            ]
        );
        assert.equal(headerOf(mock.seen[0].headers, "authorization"), "test-key");
    });
});

test("company-search-status says to read again without cursor while companies are enriching", async () => {
    await withServer(async (client, mock) => {
        mock.reply("GET", TASK_PATH, 200, { ...TASK, stage: "enriching", result_count: 25 });
        mock.reply("GET", `${TASK_PATH}/results`, 200, {
            task_id: TASK_ID,
            status: "running",
            results: [],
            next_cursor: "25",
            has_more: false,
        });
        mock.reply("GET", TASK_PATH, 200, { ...TASK, stage: "enriching", result_count: 25 });
        mock.reply("GET", `${TASK_PATH}/results`, 200, {
            task_id: TASK_ID,
            status: "running",
            results: [BETA_PARTIAL],
            next_cursor: "10",
            has_more: true,
        });

        const caughtUp = await call(client, "company-search-status", { task_id: TASK_ID, cursor: "25" });
        assert.deepEqual(caughtUp.companies, []);
        assert.equal(caughtUp.next_cursor, "25");
        assert.equal(
            caughtUp.next,
            "Every company is delivered; later stages (leaders, inferred emails, email checks) are still filling some in. Wait 15 to 30 seconds, then call company-search-status without cursor to read every company in its latest version."
        );

        const fromStart = await call(client, "company-search-status", { task_id: TASK_ID });
        assert.equal(fromStart.has_more, true);
        assert.equal(fromStart.next, 'More companies are ready now: call company-search-status again with cursor "10".');

        // Default page size is 10; the cursor is omitted on the first read.
        assert.deepEqual(queryOf(mock.seen[1].path), { cursor: "25", limit: "10" });
        assert.deepEqual(queryOf(mock.seen[3].path), { limit: "10" });
    });
});

test("company-search-status says why a task ended and whether to read again for final versions", async () => {
    await withServer(async (client, mock) => {
        const ended = {
            ...TASK,
            status: "completed",
            stage: null,
            result_count: 2,
            final_cost_usd: 0.18,
            refunded_usd: 2.07,
            finished_at: "2026-10-28T10:06:00Z",
            results_expire_at: "2026-11-27T10:06:00Z",
        };
        mock.reply("GET", TASK_PATH, 200, { ...ended, completion_reason: "count_reached" });
        mock.reply("GET", `${TASK_PATH}/results`, 200, {
            task_id: TASK_ID,
            status: "completed",
            results: [ACME],
            next_cursor: "2",
            has_more: false,
        });
        mock.reply("GET", TASK_PATH, 200, {
            ...ended,
            completion_reason: "time_limit",
            coverage_limited: true,
            warnings: [
                { code: "enrichment_time_limit", message: "Some companies were not fully enriched before the search's time limit." },
            ],
        });
        mock.reply("GET", `${TASK_PATH}/results`, 200, {
            task_id: TASK_ID,
            status: "completed",
            results: [ACME, BETA_PARTIAL],
            next_cursor: "2",
            has_more: false,
        });

        const done = await call(client, "company-search-status", { task_id: TASK_ID, cursor: "1" });
        assert.equal(done.done, true);
        assert.equal(done.completion_reason, "count_reached");
        assert.equal("coverage_limited" in done, false);
        assert.equal(done.final_cost_usd, 0.18);
        assert.equal(done.refunded_usd, 2.07);
        assert.equal(done.results_expire_at, "2026-11-27T10:06:00Z");
        assert.equal(
            done.next,
            "Finished. You have every company this task delivered. If you read companies while it ran, call company-search-status without cursor to read every company in its final version."
        );

        const limited = await call(client, "company-search-status", { task_id: TASK_ID });
        assert.equal(limited.coverage_limited, true);
        assert.deepEqual(limited.warnings, [
            { code: "enrichment_time_limit", message: "Some companies were not fully enriched before the search's time limit." },
        ]);
        assert.equal(
            limited.next,
            "Finished early: a budget stopped it (time_limit) before it delivered 25 companies, so more companies may match. You have every company it delivered. 1 company on this page stayed partial: the task ended before every stage ran for it."
        );
    });
});

test("company-search-status reads a Company Enrich task with no score and all_domains_processed", async () => {
    await withServer(async (client, mock) => {
        mock.reply("GET", TASK_PATH, 200, {
            ...ENRICH_TASK,
            status: "completed",
            stage: null,
            completion_reason: "all_domains_processed",
        });
        mock.reply("GET", `${TASK_PATH}/results`, 200, {
            task_id: TASK_ID,
            status: "completed",
            results: [{ ...ACME, score: null }],
            next_cursor: "1",
            has_more: false,
        });
        const body = await call(client, "company-search-status", { task_id: TASK_ID });
        assert.equal(body.search_type, "company_enrich");
        assert.equal(body.completion_reason, "all_domains_processed");
        const [acme] = body.companies;
        assert.equal(acme.score, null);
        for (const field of ["why", "reasons", "fully_verified", "unverified_criteria"]) {
            assert.equal(field in acme, false, field);
        }
        assert.equal(acme.leaders[0].emails[0].verification, "valid");
        assert.equal(body.next, "Finished: it read every domain. You have every company it delivered.");
    });
});

test("company-search-status skips the results call when there is nothing to read", async () => {
    await withServer(async (client, mock) => {
        mock.reply("GET", TASK_PATH, 200, { ...TASK, status: "queued", stage: null, result_count: 0, progress: {} });
        mock.reply("GET", TASK_PATH, 200, { ...TASK, status: "expired", result_count: 12 });
        mock.reply("GET", TASK_PATH, 200, { ...TASK, status: "paused" });
        mock.reply("GET", TASK_PATH, 200, {
            ...TASK,
            status: "failed",
            result_count: 0,
            errors: [{ code: "search_unavailable", message: "Every search failed, so no companies could be found. You were not charged.", at: "2026-10-28T10:01:00Z" }],
        });

        const queued = await call(client, "company-search-status", { task_id: TASK_ID });
        assert.deepEqual(queued.companies, []);
        assert.equal(queued.next_cursor, "0");
        assert.equal(queued.has_more, false);
        assert.equal(Object.hasOwn(queued, "progress"), false);
        assert.equal(queued.next, "Still running. Wait 15 to 30 seconds, then call company-search-status again with cursor \"0\" to get only the companies delivered since this call.");

        const expired = await call(client, "company-search-status", { task_id: TASK_ID, cursor: "7" });
        assert.equal(expired.done, true);
        assert.deepEqual(expired.companies, []);
        assert.equal(expired.next_cursor, "7");
        assert.equal(expired.next, "Results expired 30 days after the task ended.");

        const statusOnly = await call(client, "company-search-status", { task_id: TASK_ID, include_companies: false });
        assert.equal(statusOnly.status, "paused");
        assert.equal(Object.hasOwn(statusOnly, "companies"), false);
        assert.equal(Object.hasOwn(statusOnly, "next_cursor"), false);
        assert.equal(statusOnly.next, "Paused. Resume it with company-search-resume, or cancel it with company-search-cancel.");

        const failed = await call(client, "company-search-status", { task_id: TASK_ID });
        assert.equal(failed.errors[0].code, "search_unavailable");
        assert.match(failed.next, /not charged/);

        assert.deepEqual(
            mock.seen.map((sent) => sent.path),
            [TASK_PATH, TASK_PATH, TASK_PATH, TASK_PATH]
        );
    });
});

test("company-search-status reports a People Search task_id as not found and rejects bad arguments", async () => {
    await withServer(async (client, mock) => {
        mock.reply("GET", TASK_PATH, 404, { detail: "Task not found" });
        const missing = await client.callTool({ name: "company-search-status", arguments: { task_id: TASK_ID } });
        assert.equal(missing.isError, true);
        assert.equal(textOf(missing), "Company Search Status error: HTTP 404: Task not found");

        for (const args of [
            { task_id: "../search" },
            { task_id: TASK_ID, limit: 101 },
            { task_id: TASK_ID, limit: 0 },
            { task_id: TASK_ID, include_people: true },
            {},
        ]) {
            const rejected = await client.callTool({ name: "company-search-status", arguments: args });
            assert.equal(rejected.isError, true, JSON.stringify(args));
            assert.match(textOf(rejected), /Input validation error/, JSON.stringify(args));
        }
        assert.equal(mock.seen.length, 1);
    });
});

test("company-search-pause, company-search-resume, and company-search-cancel change a task", async () => {
    await withServer(async (client, mock) => {
        mock.reply("POST", `${TASK_PATH}/pause`, 200, { ...TASK, status: "pausing" });
        mock.reply("POST", `${TASK_PATH}/resume`, 200, { ...TASK, status: "queued", stage: null });
        mock.reply("POST", `${TASK_PATH}/cancel`, 200, { ...TASK, status: "cancelling" });
        mock.reply("POST", `${TASK_PATH}/resume`, 409, {
            detail: "Only paused tasks can be resumed.",
            task: { ...TASK, status: "running" },
        });
        mock.reply("POST", `${TASK_PATH}/cancel`, 409, {
            detail: "This task has already ended.",
            task: { ...TASK, status: "completed" },
        });

        const paused = await call(client, "company-search-pause", { task_id: TASK_ID });
        assert.equal(paused.status, "pausing");
        assert.equal(paused.done, false);
        assert.equal(paused.next, "Pausing after the current batch. Resume it with company-search-resume.");

        const resumed = await call(client, "company-search-resume", { task_id: TASK_ID });
        assert.equal(resumed.status, "queued");
        assert.equal(resumed.next, "Still running. Wait 15 to 30 seconds, then call company-search-status again.");

        const cancelled = await call(client, "company-search-cancel", { task_id: TASK_ID });
        assert.equal(cancelled.status, "cancelling");
        assert.equal(Object.hasOwn(cancelled, "progress"), false);
        assert.equal(cancelled.next, "Cancelling. Call company-search-status again to read the final status.");

        const conflict = await client.callTool({ name: "company-search-resume", arguments: { task_id: TASK_ID } });
        assert.equal(conflict.isError, true);
        assert.equal(
            textOf(conflict),
            "Company Search Resume error: HTTP 409: Only paused tasks can be resumed. Task status: running."
        );
        const ended = await client.callTool({ name: "company-search-cancel", arguments: { task_id: TASK_ID } });
        assert.equal(
            textOf(ended),
            "Company Search Cancel error: HTTP 409: This task has already ended. Task status: completed."
        );

        for (const name of ["company-search-pause", "company-search-resume", "company-search-cancel"]) {
            for (const args of [{ task_id: TASK_ID, action: "pause" }, { task_id: TASK_ID, extra: true }, { task_id: "not-a-uuid" }, {}]) {
                const rejected = await client.callTool({ name, arguments: args });
                assert.equal(rejected.isError, true, `${name} ${JSON.stringify(args)}`);
                assert.match(textOf(rejected), /Input validation error/, `${name} ${JSON.stringify(args)}`);
            }
        }

        assert.deepEqual(
            mock.seen.map((sent) => [sent.method, sent.path, sent.body]),
            [
                ["POST", `${TASK_PATH}/pause`, undefined],
                ["POST", `${TASK_PATH}/resume`, undefined],
                ["POST", `${TASK_PATH}/cancel`, undefined],
                ["POST", `${TASK_PATH}/resume`, undefined],
                ["POST", `${TASK_PATH}/cancel`, undefined],
            ]
        );
    });
});

test("company-search-pause reports a pause error under its own title", async () => {
    await withServer(async (client, mock) => {
        mock.reply("POST", `${TASK_PATH}/pause`, 409, {
            detail: "Only queued or running tasks can be paused.",
            task: { ...TASK, status: "paused" },
        });
        const conflict = await client.callTool({ name: "company-search-pause", arguments: { task_id: TASK_ID } });
        assert.equal(conflict.isError, true);
        assert.equal(
            textOf(conflict),
            "Company Search Pause error: HTTP 409: Only queued or running tasks can be paused. Task status: paused."
        );
    });
});

test("company-search-tasks lists tasks with type, status, and metadata filters", async () => {
    await withServer(async (client, mock) => {
        const metadata = { campaign: "q4 outbound & more", "team.id": "t-1" };
        mock.reply("GET", "/desearch/companies/tasks", 200, {
            tasks: [
                { ...ENRICH_TASK, status: "completed", completion_reason: "all_domains_processed", metadata },
                { ...TASK, status: "completed", completion_reason: "candidate_budget", coverage_limited: true },
            ],
            next_cursor: "MjAyNi0xMC0yOHwz",
        });
        mock.reply("GET", "/desearch/companies/tasks", 200, { tasks: [], next_cursor: null });

        const filtered = await call(client, "company-search-tasks", {
            type: "enrich",
            status: ["completed", "cancelled"],
            limit: 5,
            cursor: "abc",
            metadata,
        });
        assert.equal(filtered.next_cursor, "MjAyNi0xMC0yOHwz");
        assert.deepEqual(filtered.tasks[0], {
            task_id: TASK_ID,
            search_type: "company_enrich",
            status: "completed",
            stage: "processing",
            done: true,
            query: "acme.com, beta.io",
            metadata,
            count: 2,
            result_count: 2,
            completion_reason: "all_domains_processed",
            reserved_cost_usd: 0.15,
            created_at: "2026-10-28T10:00:00Z",
        });
        assert.deepEqual(
            filtered.tasks.map((task) => [task.completion_reason, task.coverage_limited]),
            [
                ["all_domains_processed", undefined],
                ["candidate_budget", true],
            ]
        );

        const all = await call(client, "company-search-tasks", {});
        assert.deepEqual(all, { tasks: [], next_cursor: null });

        assert.equal(
            mock.seen[0].path,
            "/desearch/companies/tasks?type=enrich&status=completed%2Ccancelled&limit=5&cursor=abc&metadata.campaign=q4+outbound+%26+more&metadata.team.id=t-1"
        );
        assert.equal(mock.seen[1].path, "/desearch/companies/tasks");

        for (const args of [
            { type: "company" },
            { status: ["done"] },
            { limit: 101 },
            { metadata: { a: "1", b: "2", c: "3", d: "4" } },
            { metadata: { "Bad Key": "x" } },
            { platform: "x" },
        ]) {
            const rejected = await client.callTool({ name: "company-search-tasks", arguments: args });
            assert.equal(rejected.isError, true, JSON.stringify(args));
            assert.match(textOf(rejected), /Input validation error/, JSON.stringify(args));
        }
        assert.equal(mock.seen.length, 2);
    });
});

test("compactCompany keeps who, fit, contacts with their sources, leaders, and enrichment", () => {
    assert.deepEqual(compactCompany(ACME), ACME_COMPACT);
    assert.deepEqual(compactCompany(BETA_PARTIAL), BETA_COMPACT);
    // Never drops `score`: a missing or null score is null.
    assert.deepEqual(compactCompany(null), { score: null });
    assert.deepEqual(compactCompany({ handle: "gamma.dev", people: [{ name: "" }, { title: "CTO" }] }), {
        domain: "gamma.dev",
        score: null,
    });
});

test("companyNextStep covers every status", () => {
    assert.equal(
        companyNextStep("running"),
        "Still running. Wait 15 to 30 seconds, then call company-search-status again."
    );
    assert.equal(
        companyNextStep("running", "4", false, {}, { readAfterStart: true }),
        'Still running. Wait 15 to 30 seconds, then call company-search-status again with cursor "4" to get only the companies delivered since this call. Companies with enrichment status "partial" are still being filled in; when the task is done, call company-search-status without cursor to read every company in its latest version.'
    );
    assert.equal(
        companyNextStep("completed", undefined, false, { completion_reason: "no_candidates" }),
        "Finished: its searches found no company to check. Try a broader description."
    );
    assert.equal(
        companyNextStep("completed", undefined, false, { completion_reason: "zero_qualified" }),
        "Finished: it checked the companies its searches found and none fit. Try a broader description, a lower min_score, or fewer require values."
    );
    assert.equal(
        companyNextStep("partial", "3", false, {}, { partial: 2 }),
        "Finished with partial results: some searches failed. You have every company it delivered. 2 companies on this page stayed partial: the task ended before every stage ran for them."
    );
    assert.equal(
        companyNextStep("cancelled"),
        "Cancelled. You pay only for the companies it delivered; the rest of the reservation is returned."
    );
    assert.equal(companyNextStep("cancelling"), "Cancelling. Call company-search-status again to read the final status.");
    assert.equal(companyNextStep("failed"), "The task failed. See errors. A task that delivers no companies is not charged.");
    assert.equal(companyNextStep(undefined, "9"), 'Call company-search-status again with cursor "9" to check for changes.');
});
