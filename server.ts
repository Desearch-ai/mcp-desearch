import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
    ListPromptsRequestSchema,
    ListResourcesRequestSchema,
    ListResourceTemplatesRequestSchema,
    ListToolsRequestSchema,
    type Icon,
    type Implementation,
} from "@modelcontextprotocol/sdk/types.js";
import DesearchImport from "desearch-js";
import { z } from "zod";
import {
    PEOPLE_FILTER_CHANNELS,
    PEOPLE_METADATA_KEY_PATTERN,
    PEOPLE_METADATA_MAX_FILTERS,
    PEOPLE_METADATA_MAX_KEYS,
    PEOPLE_METADATA_VALUE_MAX,
    PEOPLE_PLATFORMS,
    PEOPLE_PROFILE_SORTS,
    PEOPLE_SEARCH_FILTERS,
    PEOPLE_TASK_STATUSES,
    controlPeopleTask,
    createPeopleClient,
    listPeopleProfiles,
    listPeopleTasks,
    readPeopleStatus,
    startPeopleSearch,
    type PeopleClient,
} from "./people.js";
import {
    COMPANY_COUNTRIES_MAX,
    COMPANY_DOMAINS_MAX,
    COMPANY_EXCLUDE_MAX,
    COMPANY_REQUIREMENTS,
    COMPANY_ROLES,
    COMPANY_TASK_STATUSES,
    COMPANY_TASK_TYPES,
    controlCompanyTask,
    createCompanyClient,
    listCompanyTasks,
    readCompanyStatus,
    startCompanyEnrich,
    startCompanySearch,
    type CompanyClient,
} from "./companies.js";
import { AI_SEARCH_TOOLS, WEB_LINK_TOOLS, toolIdSchema } from "./tool-sources.js";

export const SERVER_NAME = "Desearch";
export const SERVER_VERSION = "0.6.0";
export const SERVER_TITLE = "Desearch";
export const SERVER_WEBSITE_URL = "https://www.desearch.ai";

// Public origin of the hosted server, which serves the icons below.
export const MCP_PUBLIC_BASE_URL = (process.env.MCP_PUBLIC_BASE_URL?.trim() || "https://mcp.desearch.ai").replace(/\/+$/, "");

export const SERVER_ICONS: Icon[] = [
    { src: `${MCP_PUBLIC_BASE_URL}/icon-512.png`, mimeType: "image/png", sizes: ["512x512"] },
    { src: `${MCP_PUBLIC_BASE_URL}/icon-64.png`, mimeType: "image/png", sizes: ["64x64"] },
];

interface XSearchPayload {
    query: string;
    sort?: "Top" | "Latest";
    count?: number;
    user?: string;
    start_date?: string;
    end_date?: string;
    lang?: string;
    verified?: boolean;
    blue_verified?: boolean;
    is_quote?: boolean;
    is_video?: boolean;
    is_image?: boolean;
    min_retweets?: number;
    min_replies?: number;
    min_likes?: number;
}

interface PageContentPayload {
    url: string;
    format?: "html" | "text" | "markdown";
    js?: boolean;
    wait?: number;
    full_page?: boolean;
}

interface DesearchClient {
    aiSearch(payload: Record<string, unknown>): Promise<unknown>;
    xSearch(payload: XSearchPayload): Promise<unknown>;
    webSearch(payload: { query: string; start?: number }): Promise<unknown>;
    aiWebLinksSearch(payload: { prompt: string; tools: string[]; count?: number }): Promise<unknown>;
    aiXLinksSearch(payload: { prompt: string; count?: number }): Promise<unknown>;
    xPostsByUrls(payload: { urls: string[] }): Promise<unknown>;
    xPostById(payload: { id: string }): Promise<unknown>;
    xPostsByUser(payload: { user: string; query?: string; count?: number }): Promise<unknown>;
    xPostRetweeters(payload: { id: string; cursor?: string }): Promise<unknown>;
    xUserPosts(payload: { username: string; cursor?: string }): Promise<unknown>;
    xUserReplies(payload: { user: string; count?: number; query?: string }): Promise<unknown>;
    xPostReplies(payload: { post_id: string; count?: number; query?: string }): Promise<unknown>;
    xTrends(payload: { woeid: number; count?: number }): Promise<unknown>;
    extract(payload: PageContentPayload): Promise<unknown>;
    webCrawl(payload: PageContentPayload): Promise<unknown>;
}

// desearch-js 1.5 publishes a default class. Node16 resolution types that package
// as a module namespace, so the constructor is applied through a cast.
const Desearch = DesearchImport as unknown as new (apiKey: string) => DesearchClient;

type ToolResult = {
    content: [{ type: "text"; text: string }];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
};

type ToolHandler = (args: any) => Promise<ToolResult>;

interface ToolAnnotations {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint?: boolean;
    openWorldHint: boolean;
}

/**
 * The search and X/web tools read live Desearch, web, or X data and return it.
 * They do not write caller state. Hints only: clients must not treat them as a safety check.
 * destructiveHint is false so a client that ignores the readOnlyHint gate does
 * not treat a search as a destructive update (the MCP default for that hint is true).
 */
const READ_ONLY_OPEN_WORLD: ToolAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
};

/**
 * `people-search`, `company-search`, and `company-enrich` start a paid job billed to the
 * user's Desearch balance. Each creates a new task and reserves balance, but it does not
 * delete or overwrite anything the caller already has, so destructiveHint is false. The
 * unused part of the reservation is returned when the task ends.
 * Calling it again starts (and reserves) another task unless the same idempotency_key is sent.
 */
const BILLED_TASK: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
};

/**
 * `people-search-pause` and `people-search-resume` change a task's state, and each
 * undoes the other, so destructiveHint is false. Pausing loses no data (people found
 * so far stay readable and the search keeps its progress) and changes no billing
 * (nothing is charged or refunded; the reservation stays until the search ends).
 * Resume continues from where the search stopped with no new charge.
 * Caveat: the API cancels a search paused for more than 7 days, and a cancelled
 * search cannot be resumed. Pause is reversible only within those 7 days; the
 * cancel itself bills only the people already delivered and returns the rest.
 * Repeating the same call has no further effect (the API answers 409).
 * `company-search-pause` and `company-search-resume` work the same way on Company
 * Search and Company Enrich tasks, with companies in place of people.
 */
const TASK_STATE_CHANGE: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
};

/**
 * `people-search-cancel` and `company-search-cancel` stop a task for good. It cannot be
 * undone, so destructiveHint is true. Repeating it has no further effect (the API answers 409).
 */
const TASK_CANCEL: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
};

const optionalPostCount = z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Number of posts to retrieve (1-100).");

const optionalLinksCount = z
    .number()
    .int()
    .min(10)
    .max(200)
    .optional()
    .describe("Results to return. Min 10. Max 200.");

function pageContentFields(): Record<string, z.ZodTypeAny> {
    return {
        url: z.string().describe("Public URL to read, example: 'https://desearch.ai'"),
        format: z
            .enum(["html", "text", "markdown"])
            .optional()
            .describe("Content format to return: 'text' (default), 'markdown' (headings, lists, tables and code) or 'html'."),
        js: z.boolean().optional().describe("Render JavaScript before reading the page."),
        wait: z
            .number()
            .optional()
            .describe("Post-load wait in milliseconds when JavaScript rendering is enabled."),
        full_page: z
            .boolean()
            .optional()
            .describe(
                "Only with format 'text': return all visible text of the page (every section, table and notice) instead of only its main content."
            ),
    };
}

const peopleTaskId = z
    .string()
    .uuid()
    .describe("task_id returned by people-search, example: '3f1c2b9e-8d4a-4c1e-9b7a-2e5f6a7b8c9d'");

const peoplePlatform = z
    .enum(PEOPLE_PLATFORMS)
    .describe("Platform: 'x', 'youtube', 'linkedin', or 'tiktok'.");

/**
 * People tools reject unknown arguments instead of dropping them. A dropped
 * filter (for example the API's nested `filters` object) would still run, and
 * bill, a search without it.
 */
function strictArgs(shape: Record<string, z.ZodTypeAny>): z.AnyZodObject {
    return z.object(shape).strict();
}

// A new schema per field: one shared instance would serialize as a JSON Schema $ref.
function peopleKeywordList() {
    return z.array(z.string().min(1).max(120)).max(20);
}

const peopleMetadataKey = new RegExp(PEOPLE_METADATA_KEY_PATTERN);

/**
 * `metadata` labels: string keys of a-z, 0-9, '_', '.', '-' (1-40 characters) to strings of
 * at most 200 characters, and at most `maxKeys` pairs. Checked here so a bad label never
 * reaches the API. The key rule and the key count are checked in a refinement rather than
 * advertised as `propertyNames`/`maxProperties`, which some MCP clients do not accept; the
 * description states them. A new schema per field, like peopleKeywordList.
 */
function peopleMetadata(maxKeys: number) {
    return z.record(z.string(), z.string().max(PEOPLE_METADATA_VALUE_MAX)).superRefine((value, ctx) => {
        const keys = Object.keys(value);
        if (keys.length > maxKeys) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `At most ${maxKeys} metadata keys` });
        }
        for (const key of keys) {
            if (!peopleMetadataKey.test(key)) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: [key],
                    message: "metadata keys are 1-40 characters of a-z, 0-9, '_', '.' or '-'",
                });
            }
        }
    });
}

const companyTaskId = z
    .string()
    .uuid()
    .describe(
        "task_id returned by company-search or company-enrich, example: '5b33f3ee-168b-4780-9c8e-63a626781872'. A People Search task_id is not found here."
    );

// Fields company-search and company-enrich share. A new schema per field, like peopleKeywordList.
function companyTaskFields(): Record<string, z.ZodTypeAny> {
    return {
        roles: z
            .array(z.enum(COMPANY_ROLES))
            .min(1)
            .optional()
            .describe(
                "The leaders to look for: any of 'ceo', 'founder', 'cto', 'cfo', 'coo', 'cmo', 'president', 'owner', 'managing_director' (API default ['ceo', 'founder', 'cto', 'cfo']). A managing director (Geschäftsführer) counts as 'ceo' when 'ceo' is asked for."
            ),
        infer_emails: z
            .boolean()
            .optional()
            .describe(
                "Guess leaders' emails from the company's address pattern (for example first.last), learned from the addresses found on its site (API default true). Inferred emails say source: inferred and carry a confidence: high when the pattern was learned from this company's own addresses, low for a common pattern."
            ),
        verify_emails: z
            .boolean()
            .optional()
            .describe(
                "Check every email: syntax, mail server (MX) and, for inferred ones, a web search (API default true). Each email then has a verification: valid, invalid, risky, or unknown. Set false to finish sooner without it."
            ),
        idempotency_key: z
            .string()
            .min(1)
            .max(200)
            .optional()
            .describe(
                "Any unique string for this task, for example a UUID. Sending the same key again returns the first task and is not charged again."
            ),
        metadata: peopleMetadata(PEOPLE_METADATA_MAX_KEYS)
            .optional()
            .describe(
                `Your own labels for this task, example: {"campaign": "q4-outbound"}. Up to ${PEOPLE_METADATA_MAX_KEYS} keys; keys are 1-40 characters of a-z, 0-9, '_', '.', '-'; values are strings of up to ${PEOPLE_METADATA_VALUE_MAX} characters. Returned on the task; filter company-search-tasks by it. The task does not use it.`
            ),
    };
}

const COMPANY_DATA =
    "Data: Desearch reads public data only: each company's own website (its homepage and its contact, about, team, and imprint pages), public web search results, and public LinkedIn profiles of its leaders. Each company comes back with its location, public emails, phones, and social profiles, and its leaders (roles) with their title, LinkedIn profile, and emails. Every contact keeps the page it came from (source_url). Leader emails can be inferred from the company's address pattern (source: inferred, with a confidence), and every email is checked (verification: valid, invalid, risky, or unknown). Companies stay readable for 30 days after the task ends. ";

const COMPANY_RUNS =
    "The task runs in the background: poll company-search-status with the task_id to read progress and the companies delivered so far. Each company is delivered first with enrichment status partial, and the later stages (contact pages, leaders, inferred emails, email checks) fill it in until it is complete. Use company-search-pause, company-search-resume, or company-search-cancel to pause, resume, or cancel it. Do not start the same task twice; send idempotency_key so a retry returns the first task instead of charging again.";

function platformFilterList(): string {
    return Object.entries(PEOPLE_SEARCH_FILTERS)
        .map(([platform, filters]) => `${platform}: ${filters.join(", ")}`)
        .join(". ");
}

// A new schema per field. One shared instance serializes as a JSON Schema $ref,
// and a number|string union serializes as anyOf with no type. The API uses these
// counts as integers.
function engagementThreshold(description: string) {
    return z.number().int().min(0).optional().describe(description);
}

function definedFields<T extends Record<string, unknown>>(fields: T): Partial<T> {
    const out: Partial<T> = {};
    for (const key of Object.keys(fields) as (keyof T)[]) {
        if (fields[key] !== undefined) {
            out[key] = fields[key];
        }
    }
    return out;
}

/**
 * CrewAI's MCPServerAdapter (mcpadapt) sends an omitted optional argument as null.
 * `.optional()` accepts a missing value and rejects null, which becomes
 * "Expected number, received null". Null is the same as omitting the argument:
 * defaults still apply, and a null is not forwarded to Desearch.
 *
 * `web-search` `start` has no schema default. The first page is offset 0, so
 * `start: null` resolves to 0. An omitted `start` stays omitted.
 */
function relaxOptional(key: string, field: z.ZodTypeAny): z.ZodTypeAny {
    if (!field.isOptional()) {
        return field;
    }
    const whenNull = key === "start" ? 0 : undefined;
    return z.preprocess((value) => (value === null ? whenNull : value), field);
}

function relaxShape(shape: Record<string, z.ZodTypeAny>): Record<string, z.ZodTypeAny> {
    const next: Record<string, z.ZodTypeAny> = {};
    for (const [key, field] of Object.entries(shape)) {
        next[key] = relaxOptional(key, field);
    }
    return next;
}

function relaxInputSchema(
    inputSchema: Record<string, z.ZodTypeAny> | z.AnyZodObject
): Record<string, z.ZodTypeAny> | z.AnyZodObject {
    if (!(inputSchema instanceof z.ZodObject)) {
        return relaxShape(inputSchema);
    }
    const shape = relaxShape(inputSchema.shape as Record<string, z.ZodTypeAny>);
    const object = z.object(shape);
    const unknownKeys = (inputSchema._def as { unknownKeys?: string }).unknownKeys;
    if (unknownKeys === "strict") {
        return object.strict();
    }
    if (unknownKeys === "passthrough") {
        return object.passthrough();
    }
    return object;
}

/**
 * Payload note when a link search body has no link list.
 * Does not name web vs AI search, and does not say the query had "results".
 * A missing list (the cost-only API bug) and an empty list are the same note:
 * this response body does not contain links.
 */
export const NO_LINKS_MESSAGE = "no links in response";

/**
 * Keys that have carried link lists. `/links/web` uses `search_results`.
 * AI search has used `search`, `results`, and `data`.
 */
const LINK_COLLECTION_KEYS = [
    "search_results",
    "results",
    "links",
    "search",
    "data",
    "youtube_search_results",
    "hacker_news_search_results",
    "reddit_search_results",
    "arxiv_search_results",
    "wikipedia_search_results",
    "hacker_news_search",
    "reddit_search",
    "youtube_search",
    "tweets",
    "miner_tweets",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function linkLists(value: Record<string, unknown>): unknown[][] {
    const lists: unknown[][] = [];
    for (const key of LINK_COLLECTION_KEYS) {
        const entry = value[key];
        if (Array.isArray(entry)) {
            lists.push(entry);
        }
    }
    return lists;
}

/**
 * Pass a link payload through when it contains at least one link.
 * A cost-only body (billing fields, no link list) and an empty link list
 * both get `message: "no links in response"` plus the original fields,
 * including billing. The note does not claim the search returned results
 * and does not name which search tool produced the body.
 */
export function presentSearchBody(value: unknown): unknown {
    if (!isPlainObject(value)) {
        return value;
    }
    const lists = linkLists(value);
    if (lists.some((list) => list.length > 0)) {
        return value;
    }
    return {
        ...value,
        message: NO_LINKS_MESSAGE,
    };
}

function ok(value: unknown): ToolResult {
    return {
        content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    };
}

function structured(value: Record<string, unknown>): ToolResult {
    return {
        content: [{ type: "text", text: JSON.stringify(value) }],
        structuredContent: value,
    };
}

const WEB_RESULT_KEYS = ["data", "organic", "results", "search_results", "items", "search"];

function firstString(record: Record<string, unknown>, keys: string[]): string {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) {
            return value.trim();
        }
    }
    return "";
}

function searchResultsFrom(value: unknown): { id: string; title: string; url: string }[] {
    const rows: unknown[] = [];
    if (Array.isArray(value)) {
        rows.push(...value);
    } else if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        for (const key of WEB_RESULT_KEYS) {
            const entry = record[key];
            if (Array.isArray(entry)) {
                rows.push(...entry);
            }
        }
    }
    const out: { id: string; title: string; url: string }[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
        if (!row || typeof row !== "object") {
            continue;
        }
        const record = row as Record<string, unknown>;
        const url = firstString(record, ["link", "url", "href"]);
        if (!/^https?:\/\//i.test(url) || seen.has(url)) {
            continue;
        }
        seen.add(url);
        out.push({
            id: url,
            title: firstString(record, ["title", "name"]) || url,
            url,
        });
    }
    return out;
}

function pageText(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    if (value && typeof value === "object") {
        const text = firstString(value as Record<string, unknown>, ["text", "content", "markdown", "body"]);
        if (text) {
            return text;
        }
    }
    return JSON.stringify(value ?? "");
}

function titleFromUrl(url: string): string {
    try {
        const parsed = new URL(url);
        const last = parsed.pathname.split("/").filter(Boolean).pop();
        return last ? decodeURIComponent(last) : parsed.hostname;
    } catch {
        return url;
    }
}

function fail(label: string, error: unknown): ToolResult {
    return {
        content: [
            {
                type: "text",
                text: `${label}: ${error instanceof Error ? error.message : String(error)}`,
            },
        ],
        isError: true,
    };
}

function registerTool(
    server: McpServer,
    apiKey: string,
    name: string,
    title: string,
    description: string,
    inputSchema: Record<string, z.ZodTypeAny> | z.AnyZodObject,
    handler: ToolHandler,
    outputSchema?: Record<string, z.ZodTypeAny>,
    annotations: ToolAnnotations = READ_ONLY_OPEN_WORLD
): void {
    // SDK 1.30's tool generics blow the TypeScript instantiation limit on these
    // schemas. Runtime registration is the same registerTool call.
    const register = server.registerTool.bind(server) as (
        toolName: string,
        config: {
            title: string;
            description: string;
            inputSchema: Record<string, z.ZodTypeAny> | z.AnyZodObject;
            outputSchema?: Record<string, z.ZodTypeAny>;
            annotations: ToolAnnotations & { title: string };
        },
        callback: ToolHandler
    ) => unknown;
    const guarded: ToolHandler = async (args) => {
        if (!apiKey) {
            return fail(
                "Desearch",
                new Error(
                    "Desearch API key required. Send it in the Authorization: Bearer <key> header or the x-api-key header."
                )
            );
        }
        return handler(args);
    };
    register(
        name,
        {
            title,
            description,
            inputSchema: relaxInputSchema(inputSchema),
            ...(outputSchema ? { outputSchema } : {}),
            annotations: { ...annotations, title },
        },
        guarded
    );
}

/**
 * One MCP server bound to a single Desearch API key.
 * Stdio uses the process env key. Remote HTTP builds a new server per request
 * so each caller spends their own key.
 * `client`, `peopleClient`, and `companyClient` are test seams. Production callers omit
 * them and the server builds a desearch-js client, a People Search client (people.ts), and
 * a Company Search client (companies.ts) from `apiKey`.
 */
export function createDesearchMcpServer(
    apiKey: string,
    client?: DesearchClient,
    peopleClient?: PeopleClient,
    companyClient?: CompanyClient
): McpServer {
    const desearch = client ?? new Desearch(apiKey);
    const people = peopleClient ?? createPeopleClient(apiKey);
    const companies = companyClient ?? createCompanyClient(apiKey);
    const serverInfo: Implementation = {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        title: SERVER_TITLE,
        websiteUrl: SERVER_WEBSITE_URL,
        icons: SERVER_ICONS,
    };
    const server = new McpServer(
        serverInfo,
        {
            instructions:
                "Search the public web and X with Desearch. Use search for titles and links, then fetch with a result URL to read the page. Other tools cover AI search, X posts, and page extraction. People Search finds people and creators on X, YouTube, LinkedIn, and TikTok: people-search starts a paid job billed to the user's Desearch balance, people-search-status reads progress, and people-search-pause, people-search-resume, and people-search-cancel pause, resume, or cancel it. Company Search finds companies on the web from a description and Company Enrich reads the domains you send; both collect public emails, phones, social profiles, and leaders (CEO, founders, CTO, CFO): company-search and company-enrich start paid jobs billed to the user's Desearch balance, company-search-status reads progress and the companies, and company-search-pause, company-search-resume, and company-search-cancel pause, resume, or cancel a task. Calls need a Desearch API key.",
        }
    );

    registerTool(
        server,
        apiKey,
        "ai-search",
        "AI Search",
        "AI search and analysis on web using Desearch AI",
        {
            prompt: z.string().describe("Question, example: 'What is the latest news on AI?'"),
            tools: z
                .array(toolIdSchema(AI_SEARCH_TOOLS))
                .optional()
                .default(["web", "twitter"])
                .describe(
                    "Source ids sent to POST /desearch/ai/search. Short ids: 'web', 'twitter', 'arxiv', 'wikipedia', 'hackernews', 'reddit'. Legacy labels such as 'Web Search', 'ArXiv Search', 'Wikipedia Search', 'Hacker News Search', and 'Reddit Search' are rewritten to those ids. Example: ['web', 'twitter']."
                ),
            date_filter: z
                .enum([
                    "PAST_24_HOURS",
                    "PAST_2_DAYS",
                    "PAST_WEEK",
                    "PAST_2_WEEKS",
                    "PAST_MONTH",
                    "PAST_2_MONTHS",
                    "PAST_YEAR",
                    "PAST_2_YEARS",
                ])
                .optional()
                .describe("Deprecated relative window; prefer start_date/end_date. Example: 'PAST_WEEK'"),
            start_date: z
                .string()
                .optional()
                .describe("Start of the date range in UTC (YYYY-MM-DDTHH:MM:SSZ). Use with end_date."),
            end_date: z
                .string()
                .optional()
                .describe("End of the date range in UTC (YYYY-MM-DDTHH:MM:SSZ). Use with start_date."),
            result_type: z
                .enum(["ONLY_LINKS", "LINKS_WITH_FINAL_SUMMARY"])
                .optional()
                .describe(
                    "ONLY_LINKS returns links only; LINKS_WITH_FINAL_SUMMARY adds an AI summary. Link arrays are kept under whichever key the API uses, along with billing fields. ONLY_LINKS still depends on the API to include those links."
                ),
            include_domains: z
                .array(z.string())
                .optional()
                .describe("Restrict Web Search results to these domains, example: ['bbc.com', 'reuters.com']"),
            exclude_domains: z
                .array(z.string())
                .optional()
                .describe("Drop Web Search results from these domains, example: ['pinterest.com']"),
            model: z
                .enum(["NOVA", "ORBIT"])
                .default("NOVA")
                .describe(
                    "Model to use for the search: NOVA (default) or ORBIT."
                ),
        },
        async ({ prompt, tools, date_filter, start_date, end_date, result_type, include_domains, exclude_domains, model }) => {
            try {
                const payload = {
                    prompt,
                    tools,
                    date_filter,
                    start_date,
                    end_date,
                    result_type,
                    include_domains,
                    exclude_domains,
                    model,
                    streaming: false,
                };
                return ok(presentSearchBody(await desearch.aiSearch(payload)));
            } catch (error) {
                return fail("AI Search error", error);
            }
        }
    );

    registerTool(
        server,
        apiKey,
        "x-search",
        "X Search",
        "Search X (Twitter) using Desearch AI. Optional filters narrow by user, date, language, verification, media, and engagement. Sort stays Top.",
        {
            query: z
                .string()
                .describe(
                    "Twitter advanced search query, example: 'from:elonmusk since:2023-01-01 min_replies:10'"
                ),
            count: z
                .number()
                .optional()
                .default(20)
                .describe("Number of search results to return (default: 20), max is 100"),
            user: z.string().optional().describe("User to search for, example: 'elonmusk'"),
            start_date: z
                .string()
                .optional()
                .describe("Start date in UTC (YYYY-MM-DD). Use with end_date."),
            end_date: z
                .string()
                .optional()
                .describe("End date in UTC (YYYY-MM-DD). Use with start_date."),
            lang: z.string().optional().describe("Language code, example: 'en', 'es', 'fr'"),
            verified: z.boolean().optional().describe("Filter for verified users."),
            blue_verified: z.boolean().optional().describe("Filter for blue-checkmark verified users."),
            is_quote: z.boolean().optional().describe("Include only posts that are quotes."),
            is_video: z.boolean().optional().describe("Include only posts with video."),
            is_image: z.boolean().optional().describe("Include only posts with images."),
            min_retweets: engagementThreshold("Minimum number of retweets."),
            min_replies: engagementThreshold("Minimum number of replies."),
            min_likes: engagementThreshold("Minimum number of likes."),
        },
        async ({
            query,
            count,
            user,
            start_date,
            end_date,
            lang,
            verified,
            blue_verified,
            is_quote,
            is_video,
            is_image,
            min_retweets,
            min_replies,
            min_likes,
        }) => {
            try {
                return ok(
                    await desearch.xSearch({
                        query,
                        sort: "Top",
                        count,
                        ...definedFields({
                            user,
                            start_date,
                            end_date,
                            lang,
                            verified,
                            blue_verified,
                            is_quote,
                            is_video,
                            is_image,
                            min_retweets,
                            min_replies,
                            min_likes,
                        }),
                    })
                );
            } catch (error) {
                return fail("X Search error", error);
            }
        }
    );

    registerTool(
        server,
        apiKey,
        "web-search",
        "Web Search",
        "SERP-style web search using Desearch. Returns ranked titles, links, and snippets.",
        {
            query: z.string().describe("Search query, example: 'latest news on AI'"),
            start: z
                .number()
                .int()
                .min(0)
                .optional()
                .describe(
                    "How many results to skip for pagination (0, 10, 20, ...). Omit for the first page."
                ),
        },
        async ({ query, start }) => {
            try {
                return ok(await desearch.webSearch({ query, start }));
            } catch (error) {
                return fail("Web Search error", error);
            }
        }
    );

    registerTool(
        server,
        apiKey,
        "web-links-search",
        "Web Links Search",
        "Search the web for links using Desearch. Only the web source is accepted.",
        {
            prompt: z
                .string()
                .describe("Search query prompt, example: 'open source browser automation tools'"),
            tools: z
                .array(toolIdSchema(WEB_LINK_TOOLS))
                .min(1)
                .default(["web"])
                .describe(
                    "Sources to search. Only 'web' is accepted; other ids are rejected before the API call. 'Web Search' is accepted and rewritten to 'web'. Defaults to ['web']."
                ),
            count: z
                .number()
                .int()
                .min(10)
                .max(200)
                .optional()
                .describe("Results to return per source. Min 10. Max 200."),
        },
        async ({ prompt, tools, count }) => {
            try {
                return ok(
                    presentSearchBody(
                        await desearch.aiWebLinksSearch({
                            prompt,
                            tools,
                            ...definedFields({ count }),
                        })
                    )
                );
            } catch (error) {
                return fail("Web Links Search error", error);
            }
        }
    );

    registerTool(
        server,
        apiKey,
        "x-links-search",
        "X Links Search",
        "AI search for X (Twitter) post links using Desearch. Returns links from posts that match the prompt.",
        {
            prompt: z.string().describe("Search query prompt, example: 'Bittensor subnet updates'"),
            count: optionalLinksCount,
        },
        async ({ prompt, count }) => {
            try {
                return ok(await desearch.aiXLinksSearch({ prompt, count }));
            } catch (error) {
                return fail("X Links Search error", error);
            }
        }
    );

    registerTool(
        server,
        apiKey,
        "x-posts-by-urls",
        "Get X Posts by URLs",
        "Fetch full X (Twitter) posts for a list of post URLs.",
        {
            urls: z
                .array(z.string())
                .min(1)
                .describe("Post URLs to fetch, example: ['https://x.com/user/status/123']"),
        },
        async ({ urls }) => {
            try {
                return ok(await desearch.xPostsByUrls({ urls }));
            } catch (error) {
                return fail("X Posts By URLs error", error);
            }
        }
    );

    registerTool(
        server,
        apiKey,
        "x-post-by-id",
        "Get X Post by ID",
        "Fetch a single X (Twitter) post by its ID.",
        {
            id: z.string().describe("The unique ID of the post, example: '1234567890'"),
        },
        async ({ id }) => {
            try {
                return ok(await desearch.xPostById({ id }));
            } catch (error) {
                return fail("X Post By ID error", error);
            }
        }
    );

    registerTool(
        server,
        apiKey,
        "x-posts-by-user",
        "Search X Posts by User",
        "Search X (Twitter) posts by a specific user, with an optional keyword query.",
        {
            user: z.string().describe("User to search for, example: 'elonmusk'"),
            query: z.string().optional().describe("Advanced search query to filter this user's posts."),
            count: optionalPostCount,
        },
        async ({ user, query, count }) => {
            try {
                return ok(await desearch.xPostsByUser({ user, query, count }));
            } catch (error) {
                return fail("X Posts By User error", error);
            }
        }
    );

    registerTool(
        server,
        apiKey,
        "x-post-retweeters",
        "List X Post Retweeters",
        "List users who retweeted an X (Twitter) post. Pass cursor to page through more users.",
        {
            id: z.string().describe("The ID of the post to get retweeters for."),
            cursor: z.string().optional().describe("Cursor for pagination from a previous response."),
        },
        async ({ id, cursor }) => {
            try {
                return ok(await desearch.xPostRetweeters({ id, cursor }));
            } catch (error) {
                return fail("X Post Retweeters error", error);
            }
        }
    );

    registerTool(
        server,
        apiKey,
        "x-user-posts",
        "Get X User Timeline",
        "Retrieve a user's X (Twitter) timeline posts by username. Pass cursor to page through more posts.",
        {
            username: z.string().describe("Username to fetch posts for, example: 'elonmusk'"),
            cursor: z.string().optional().describe("Cursor for pagination from a previous response."),
        },
        async ({ username, cursor }) => {
            try {
                return ok(await desearch.xUserPosts({ username, cursor }));
            } catch (error) {
                return fail("X User Posts error", error);
            }
        }
    );

    registerTool(
        server,
        apiKey,
        "x-user-replies",
        "Get X User Replies",
        "Fetch posts and replies by an X (Twitter) user, with an optional keyword query.",
        {
            user: z.string().describe("Username of the user to search for, example: 'elonmusk'"),
            count: optionalPostCount,
            query: z.string().optional().describe("Advanced search query to filter this user's posts and replies."),
        },
        async ({ user, count, query }) => {
            try {
                return ok(await desearch.xUserReplies({ user, count, query }));
            } catch (error) {
                return fail("X User Replies error", error);
            }
        }
    );

    registerTool(
        server,
        apiKey,
        "x-post-replies",
        "Get X Post Replies",
        "Fetch replies to an X (Twitter) post, with an optional keyword query.",
        {
            post_id: z.string().describe("The ID of the post to fetch replies for."),
            count: optionalPostCount,
            query: z.string().optional().describe("Advanced search query to filter replies."),
        },
        async ({ post_id, count, query }) => {
            try {
                return ok(await desearch.xPostReplies({ post_id, count, query }));
            } catch (error) {
                return fail("X Post Replies error", error);
            }
        }
    );

    registerTool(
        server,
        apiKey,
        "extract",
        "Extract Page Content",
        "Extract a public URL and return its content as plain text, markdown or HTML using Desearch. Markdown keeps headings, lists and tables. Text is the page's main content; set full_page for every section, such as opening hours or fee tables. A js_required error means the page needs js: true; blocked means the site refused or showed a bot check. Preferred over web-crawl for new integrations. API docs: https://www.desearch.ai/docs/api-reference/get-web-extract",
        pageContentFields(),
        async ({ url, format, js, wait, full_page }) => {
            try {
                return ok(await desearch.extract({ url, format, js, wait, full_page }));
            } catch (error) {
                return fail("Extract error", error);
            }
        }
    );

    registerTool(
        server,
        apiKey,
        "web-crawl",
        "Crawl Web Page (Legacy)",
        "Crawl a public URL and return its content as plain text or HTML on the legacy Desearch /web/crawl route. The SDK marks webCrawl deprecated in favor of extract; this tool stays for parity with that route. Prefer extract for new integrations. API docs: https://www.desearch.ai/docs/guide/apis/extract-api",
        pageContentFields(),
        async ({ url, format, js, wait, full_page }) => {
            try {
                return ok(await desearch.webCrawl({ url, format, js, wait, full_page }));
            } catch (error) {
                return fail("Web Crawl error", error);
            }
        }
    );

    registerTool(
        server,
        apiKey,
        "x-trends",
        "Get X Trends",
        "Retrieve trending topics on X (Twitter) for a location by its WOEID using Desearch.",
        {
            woeid: z
                .number()
                .int()
                .describe("WOEID of the location, example: 23424977 for the United States."),
            count: z
                .number()
                .int()
                .min(30)
                .max(100)
                .optional()
                .describe("Number of trends to return (30-100)."),
        },
        async ({ woeid, count }) => {
            try {
                return ok(await desearch.xTrends({ woeid, count }));
            } catch (error) {
                return fail("X Trends error", error);
            }
        }
    );

    registerTool(
        server,
        apiKey,
        "search",
        "Search",
        "Search the public web and return titles and links. Use fetch with a result URL to read the page.",
        {
            query: z.string().describe("Search query."),
        },
        async ({ query }) => {
            try {
                const results = searchResultsFrom(await desearch.webSearch({ query }));
                return structured({ results });
            } catch (error) {
                return fail("Search error", error);
            }
        },
        {
            results: z.array(
                z.object({
                    id: z.string(),
                    title: z.string(),
                    url: z.string(),
                })
            ),
        }
    );

    registerTool(
        server,
        apiKey,
        "fetch",
        "Fetch Page",
        "Read a public page as text. Pass a URL returned by search.",
        {
            id: z.string().describe("URL of the page to read."),
        },
        async ({ id }) => {
            if (typeof id !== "string" || !/^https?:\/\//i.test(id)) {
                return fail("Fetch error", new Error("id must be an http or https URL from search."));
            }
            try {
                const text = pageText(await desearch.extract({ url: id, format: "text" }));
                return structured({
                    id,
                    title: titleFromUrl(id),
                    text,
                    url: id,
                    metadata: { source: "desearch" },
                });
            } catch (error) {
                return fail("Fetch error", error);
            }
        },
        {
            id: z.string(),
            title: z.string(),
            text: z.string(),
            url: z.string(),
            metadata: z.record(z.string(), z.string()).optional(),
        }
    );


    registerTool(
        server,
        apiKey,
        "people-search",
        "People Search",
        "Start a paid job billed to the user's Desearch balance: find people on X, YouTube, LinkedIn, or TikTok who match a plain-language description. Returns a task_id at once, with the task's status and reserved_cost_usd. " +
            "Cost: the call reserves count times the platform's per-person price at the time of the call (reserved_cost_usd; prices at https://desearch.ai/pricing). When the search ends you pay only for the people it delivered (final_cost_usd; a per-search minimum applies when it finds anyone; a search that finds no one is free) and the rest of the reservation is returned. " +
            "Data: each person comes back with a fit score, why they matched, their audience, and only the contacts and links they list publicly. Desearch reads public data only. X: public posts and public profile fields (bio, followers, website, location). YouTube: public channel pages (About section, subscribers, country, links) and the creator's own website for publicly listed contact details. LinkedIn: public posts and public profiles (headline, company, location, followers, about). TikTok: public videos and public profiles (bio, followers, likes, latest videos, a public email listed in the bio). People found stay readable for 30 days after the search ends. " +
            "The search runs in the background, usually for 1 to 5 minutes: poll people-search-status with the task_id to read progress and the people found so far, and use people-search-pause, people-search-resume, or people-search-cancel to pause, resume, or cancel it. Do not start the same search twice; send idempotency_key so a retry returns the first task instead of charging again. Filters depend on the platform. " +
            platformFilterList() +
            ".",
        strictArgs({
            platform: peoplePlatform.describe(
                "Where to look: 'x' (X profiles), 'youtube' (YouTube creators), 'linkedin' (LinkedIn members), or 'tiktok' (TikTok creators)."
            ),
            query: z
                .string()
                .min(3)
                .max(1000)
                .describe(
                    "Who you are looking for, in plain language, example: 'Skincare creators who review sunscreen'."
                ),
            count: z
                .number()
                .int()
                .min(5)
                .max(200)
                .optional()
                .describe(
                    "How many qualified people to find (5-200, API default 25). The search reserves this many and bills only the people it delivers."
                ),
            min_score: z
                .number()
                .int()
                .min(0)
                .max(100)
                .optional()
                .describe("Only return people with at least this fit score (0-100)."),
            exclude: z
                .array(z.string().min(1))
                .max(1000)
                .optional()
                .describe("Handles to leave out, for example people you already contacted."),
            idempotency_key: z
                .string()
                .min(1)
                .max(200)
                .optional()
                .describe(
                    "Any unique string for this search, for example a UUID. Sending the same key again returns the first task and is not charged again."
                ),
            metadata: peopleMetadata(PEOPLE_METADATA_MAX_KEYS)
                .optional()
                .describe(
                    `Your own labels for this search, example: {"campaign": "q4-outbound"}. Up to ${PEOPLE_METADATA_MAX_KEYS} keys; keys are 1-40 characters of a-z, 0-9, '_', '.', '-'; values are strings of up to ${PEOPLE_METADATA_VALUE_MAX} characters. Returned on the task; filter people-search-tasks by it. The search does not use it.`
                ),
            min_followers: z
                .number()
                .int()
                .min(0)
                .optional()
                .describe("Minimum follower count. x, linkedin, tiktok."),
            max_followers: z
                .number()
                .int()
                .min(0)
                .optional()
                .describe("Maximum follower count. x, linkedin, tiktok."),
            min_subscribers: z
                .number()
                .int()
                .min(0)
                .optional()
                .describe("Minimum subscriber count. youtube only."),
            max_subscribers: z
                .number()
                .int()
                .min(0)
                .optional()
                .describe("Maximum subscriber count. youtube only."),
            verified_only: z
                .boolean()
                .optional()
                .describe("Only verified or X Premium accounts. x only."),
            require_contact: z
                .boolean()
                .optional()
                .describe(
                    "Only creators with a public email (tiktok: in the bio; youtube: an email or contact link). youtube, tiktok."
                ),
            countries: peopleKeywordList()
                .optional()
                .describe("Countries to prefer, example: ['US', 'GB']. x, youtube, linkedin."),
            keywords: peopleKeywordList()
                .optional()
                .describe("Words that should appear in their posts, videos, or bio. All platforms."),
            exclude_keywords: peopleKeywordList()
                .optional()
                .describe("Leave out people who mention these words. All platforms."),
        }),
        async (args) => {
            try {
                return ok(await startPeopleSearch(people, args));
            } catch (error) {
                return fail("People Search error", error);
            }
        },
        undefined,
        BILLED_TASK
    );

    registerTool(
        server,
        apiKey,
        "people-search-status",
        "Get People Search Status",
        "Status, progress, and cost of one People Search task, plus a page of the people found so far: name, handle, url, platform, audience, location, fit score, why they matched, contacts, and links. Free: it reads a search you already started and runs no new search. Cost fields are reserved_cost_usd and, once the search ended, final_cost_usd. People come from public profiles and posts on the search's platform, with only the contacts they list publicly. People arrive while the search runs: pass the returned next_cursor as cursor on the next call to get only the people found since then. When done is true and has_more is false you have everyone the search found. An ended task has completion_reason (why it stopped), coverage_limited: true when a budget stopped it before count (more people may match), and warnings such as partial_enrichment (some profiles could not be read, so those people were scored on the search hit; they show enrichment: failed). Each person has fully_verified (every criterion confirmed by their own profile or posts) and unverified_criteria (criteria that are unknown or not met, or a disqualifier that applies). These are information only: the person still qualified.",
        strictArgs({
            task_id: peopleTaskId,
            cursor: z
                .string()
                .max(64)
                .optional()
                .describe(
                    "next_cursor from the previous people-search-status call. Omit to start from the first person."
                ),
            limit: z
                .number()
                .int()
                .min(1)
                .max(100)
                .default(25)
                .describe("People per page (1-100, default 25)."),
            include_people: z
                .boolean()
                .default(true)
                .describe("Set false to read only the status, progress, and cost."),
        }),
        async (args) => {
            try {
                return ok(await readPeopleStatus(people, args));
            } catch (error) {
                return fail("People Search Status error", error);
            }
        },
        undefined,
        READ_ONLY_OPEN_WORLD
    );

    registerTool(
        server,
        apiKey,
        "people-search-pause",
        "Pause People Search",
        "Pause a People Search task and return its updated status. Free: it charges and refunds nothing. A queued search pauses at once; a running one finishes its current batch first (status pausing, then paused). Pausing loses no data: the people found so far stay readable with people-search-status, and the search keeps its progress. Billing does not change: the reservation made when the search started stays reserved while paused and is settled only when the search ends. Undo it with people-search-resume, which continues from where the search stopped with no new charge. Limit: a search paused for more than 7 days is cancelled by the API and can no longer be resumed; you then pay only for the people already delivered, the rest of the reservation is returned, and the people found stay readable for 30 days.",
        strictArgs({
            task_id: peopleTaskId,
        }),
        async (args) => {
            try {
                return ok(await controlPeopleTask(people, { task_id: args.task_id, action: "pause" }));
            } catch (error) {
                return fail("People Search Pause error", error);
            }
        },
        undefined,
        TASK_STATE_CHANGE
    );

    registerTool(
        server,
        apiKey,
        "people-search-resume",
        "Resume People Search",
        "Resume a paused People Search task and return its updated status. Free. The search continues from where it stopped, keeping the people already found, with no new charge: the cost already spent is carried forward and the original reservation still covers it. Works only on a paused search, within 7 days of pausing; a search in any other state, including one the API cancelled after 7 days paused, returns 409. Poll people-search-status for the new people.",
        strictArgs({
            task_id: peopleTaskId,
        }),
        async (args) => {
            try {
                return ok(await controlPeopleTask(people, { task_id: args.task_id, action: "resume" }));
            } catch (error) {
                return fail("People Search Resume error", error);
            }
        },
        undefined,
        TASK_STATE_CHANGE
    );

    registerTool(
        server,
        apiKey,
        "people-search-cancel",
        "Cancel People Search",
        "Cancel a People Search task. Free. The search stops for good; you pay only for the people it already delivered and the rest of the reservation is returned. People found so far stay readable for 30 days. This cannot be undone.",
        strictArgs({
            task_id: peopleTaskId,
        }),
        async (args) => {
            try {
                return ok(await controlPeopleTask(people, { task_id: args.task_id, action: "cancel" }));
            } catch (error) {
                return fail("People Search Cancel error", error);
            }
        },
        undefined,
        TASK_CANCEL
    );

    registerTool(
        server,
        apiKey,
        "people-search-tasks",
        "List People Search Tasks",
        "Your People Search tasks, newest first, with status, counts, cost, why each ended search stopped (completion_reason, coverage_limited), and the metadata labels set on people-search. Free; it lists your own tasks, not the people they found (read those with people-search-status or people-profiles). Use it to find a task_id (filter by metadata to find the searches of one campaign), or to see which searches are still queued, running, or paused: a new search is refused while too many are active.",
        strictArgs({
            platform: peoplePlatform.optional().describe("Only tasks on this platform: 'x', 'youtube', 'linkedin', or 'tiktok'."),
            status: z
                .array(z.enum(PEOPLE_TASK_STATUSES))
                .optional()
                .describe("Only tasks in these statuses, example: ['running', 'paused']."),
            limit: z
                .number()
                .int()
                .min(1)
                .max(100)
                .optional()
                .describe("Tasks per page (1-100, API default 20)."),
            cursor: z.string().optional().describe("next_cursor from the previous page. Keep the same metadata filter when you page."),
            metadata: peopleMetadata(PEOPLE_METADATA_MAX_FILTERS)
                .optional()
                .describe(
                    `Only tasks whose metadata has all of these key/value pairs (exact match, up to ${PEOPLE_METADATA_MAX_FILTERS}), example: {"campaign": "q4-outbound"}.`
                ),
        }),
        async (args) => {
            try {
                return ok(await listPeopleTasks(people, args));
            } catch (error) {
                return fail("People Search Tasks error", error);
            }
        },
        undefined,
        READ_ONLY_OPEN_WORLD
    );

    registerTool(
        server,
        apiKey,
        "people-profiles",
        "List People Found",
        "Everyone your own People Searches found on one platform, one entry per person: their best-scoring result (name, handle, url, audience, location, fit score, why they matched, public contacts, and links) and the search that found them (found_by). Free: it reads only people your earlier searches found, runs no new search, and queries no outside source. That data came from public profiles and posts, with only the contacts each person lists publicly. Search by name, handle, bio, or location with q, filter by contact channels (has), audience, fit score, location, or verification, and sort by score, recent, or audience. People from searches that ended more than 30 days ago are left out.",
        strictArgs({
            platform: peoplePlatform,
            q: z
                .string()
                .max(200)
                .optional()
                .describe("Text in the name, handle, bio, or location, example: 'skincare'."),
            sort: z
                .enum(PEOPLE_PROFILE_SORTS)
                .optional()
                .describe("'score' (API default), 'recent', or 'audience'."),
            limit: z
                .number()
                .int()
                .min(1)
                .max(200)
                .default(25)
                .describe("People per page (1-200, default 25)."),
            cursor: z.string().optional().describe("next_cursor from the previous page."),
            has: z
                .array(z.enum(PEOPLE_FILTER_CHANNELS))
                .optional()
                .describe(
                    "Channels every person must have, example: ['email', 'instagram']. 'email' is a public email; the others are a link of that type."
                ),
            min_audience: z
                .number()
                .int()
                .min(0)
                .optional()
                .describe("Minimum followers (subscribers on YouTube)."),
            max_audience: z
                .number()
                .int()
                .min(0)
                .optional()
                .describe("Maximum followers (subscribers on YouTube)."),
            min_score: z
                .number()
                .int()
                .min(0)
                .max(100)
                .optional()
                .describe("Minimum fit score (0-100)."),
            location: z
                .string()
                .max(100)
                .optional()
                .describe("Text in the location, example: 'united states'."),
            verified: z
                .boolean()
                .optional()
                .describe("Only verified accounts. Only X and TikTok people carry a verified flag."),
        }),
        async (args) => {
            try {
                return ok(await listPeopleProfiles(people, args));
            } catch (error) {
                return fail("People Profiles error", error);
            }
        },
        undefined,
        READ_ONLY_OPEN_WORLD
    );

    registerTool(
        server,
        apiKey,
        "company-search",
        "Company Search",
        "Start a paid job billed to the user's Desearch balance: find companies on the web that match a plain-language description, and collect each one's public contact data. Returns a task_id at once, with the task's status and reserved_cost_usd. " +
            "Cost: the call reserves count companies at the Company Search per-company price at the time of the call (reserved_cost_usd; prices at https://desearch.ai/pricing). When the task ends you pay only for the companies it delivered (final_cost_usd; a minimum of 2 when it delivers any; a task that delivers none is free) and the rest of the reservation is returned. A company left out by min_score or require is not billed. " +
            "Each company has a fit score (0-100) and why it matched, plus fully_verified and unverified_criteria (what its own pages do and do not confirm). " +
            COMPANY_DATA +
            COMPANY_RUNS +
            " To read companies you already know by domain, use company-enrich instead.",
        strictArgs({
            query: z
                .string()
                .min(3)
                .max(1000)
                .describe(
                    "The companies you are looking for, in plain language: what they do, where, how far along. Example: 'Series A fintech startups in Berlin building payment infrastructure'."
                ),
            count: z
                .number()
                .int()
                .min(5)
                .max(200)
                .optional()
                .describe(
                    "How many companies to deliver (5-200, API default 25). The task reserves this many and bills only the companies it delivers."
                ),
            min_score: z
                .number()
                .int()
                .min(0)
                .max(100)
                .optional()
                .describe("Only deliver companies with at least this fit score (0-100)."),
            exclude: z
                .array(z.string().min(1))
                .max(COMPANY_EXCLUDE_MAX)
                .optional()
                .describe(
                    `Companies to leave out, as domains or URLs, for example ones you already contacted (up to ${COMPANY_EXCLUDE_MAX}). Each is reduced to its host without www.`
                ),
            countries: z
                .array(z.string().min(1).max(120))
                .max(COMPANY_COUNTRIES_MAX)
                .optional()
                .describe(
                    `Where the companies should be: ISO 3166-1 alpha-2 codes or country names, example: ['DE', 'Austria'] (up to ${COMPANY_COUNTRIES_MAX}). Scoring treats them as a location criterion. Sent as filters.countries.`
                ),
            require: z
                .array(z.enum(COMPANY_REQUIREMENTS))
                .optional()
                .describe(
                    "Only deliver companies that have all of these: 'email', 'phone', 'linkedin' (the company's LinkedIn page), 'leader' (one of roles), 'leader_email' (a leader with an email). A company is delivered once the stage that can show them has run (email, phone, linkedin: the contact pages; leader: the leaders; leader_email: the email checks); one that does not have them is not delivered and not billed. Sent as filters.require."
                ),
            ...companyTaskFields(),
        }),
        async (args) => {
            try {
                return ok(await startCompanySearch(companies, args));
            } catch (error) {
                return fail("Company Search error", error);
            }
        },
        undefined,
        BILLED_TASK
    );

    registerTool(
        server,
        apiKey,
        "company-enrich",
        "Company Enrich",
        "Start a paid job billed to the user's Desearch balance: collect public contact data for companies you already know, by domain. Send 1-200 domains or URLs; each is reduced to its host without www., lowercased, and deduplicated, and the task reads every one. Returns a task_id at once, with the task's status and reserved_cost_usd. You get one company per domain with the same fields as company-search but no fit score (score is null). The task's count is the number of domains left after deduplication. " +
            "Cost: the call reserves one company per domain sent at the Company Enrich per-company price at the time of the call (reserved_cost_usd; prices at https://desearch.ai/pricing). When the task ends you pay only for the companies it delivered (final_cost_usd; a minimum of 1; a task that delivers none is free) and the rest of the reservation, including duplicate domains, is returned. " +
            COMPANY_DATA +
            COMPANY_RUNS +
            " To find companies from a description, use company-search instead.",
        strictArgs({
            domains: z
                .array(z.string().min(1))
                .min(1)
                .max(COMPANY_DOMAINS_MAX)
                .describe(
                    `1-${COMPANY_DOMAINS_MAX} company domains or URLs, example: ['acme.com', 'https://www.beta.io/about']. Each is reduced to its host without www. and lowercased; duplicates are removed.`
                ),
            ...companyTaskFields(),
        }),
        async (args) => {
            try {
                return ok(await startCompanyEnrich(companies, args));
            } catch (error) {
                return fail("Company Enrich error", error);
            }
        },
        undefined,
        BILLED_TASK
    );

    registerTool(
        server,
        apiKey,
        "company-search-status",
        "Get Company Search Status",
        "Status, progress, and cost of one Company Search or Company Enrich task, plus a page of the companies delivered so far: domain, name, url, location, fit score (null for Company Enrich) and why it matched, primary_email and primary_contact, public emails, phones, and social profiles with the page each came from (source_url), leaders with their roles, title, LinkedIn profile, and emails (each with its verification status; inferred ones with source: inferred and a confidence), contact_coverage, and enrichment (status partial or complete, and each stage: profile, contacts, people, email_patterns, email_check). Free: it reads a task you already started and runs no new search. Cost fields are reserved_cost_usd and, once the task ended, final_cost_usd. The data came from each company's own website, public web search, and public LinkedIn profiles. " +
            "Companies arrive while the task runs and are filled in place by the later stages: pass the returned next_cursor as cursor to get only the companies delivered since then, and call without cursor to read every company in its latest version. stage enriching means every company is delivered and only later stages of some are left. When done is true and has_more is false you have every company. An ended task has completion_reason (why it stopped; all_domains_processed for Company Enrich), coverage_limited: true when a budget stopped it before count (more companies may match), and warnings. Company Search results have fully_verified (every criterion confirmed by the company's own pages) and unverified_criteria (criteria that are unknown or not met, or a disqualifier that applies). These are information only: the company still qualified.",
        strictArgs({
            task_id: companyTaskId,
            cursor: z
                .string()
                .max(64)
                .optional()
                .describe(
                    "next_cursor from the previous company-search-status call, to get only the companies delivered since then. Omit to read from the first company, each in its latest version."
                ),
            limit: z
                .number()
                .int()
                .min(1)
                .max(100)
                .default(10)
                .describe("Companies per page (1-100, default 10)."),
            include_companies: z
                .boolean()
                .default(true)
                .describe("Set false to read only the status, progress, and cost."),
        }),
        async (args) => {
            try {
                return ok(await readCompanyStatus(companies, args));
            } catch (error) {
                return fail("Company Search Status error", error);
            }
        },
        undefined,
        READ_ONLY_OPEN_WORLD
    );

    registerTool(
        server,
        apiKey,
        "company-search-pause",
        "Pause Company Search",
        "Pause a Company Search or Company Enrich task and return its updated status. Free: it charges and refunds nothing. A queued task pauses at once; a running one finishes its current batch first (status pausing, then paused). Pausing loses no data: the companies delivered so far stay readable with company-search-status, and the task keeps its progress. Billing does not change: the reservation made when the task started stays reserved while paused and is settled only when the task ends. Undo it with company-search-resume, which continues from where the task stopped with no new charge. Limit: a task paused for more than 7 days is cancelled by the API and can no longer be resumed; you then pay only for the companies already delivered, the rest of the reservation is returned, and the companies delivered stay readable for 30 days.",
        strictArgs({
            task_id: companyTaskId,
        }),
        async (args) => {
            try {
                return ok(await controlCompanyTask(companies, { task_id: args.task_id, action: "pause" }));
            } catch (error) {
                return fail("Company Search Pause error", error);
            }
        },
        undefined,
        TASK_STATE_CHANGE
    );

    registerTool(
        server,
        apiKey,
        "company-search-resume",
        "Resume Company Search",
        "Resume a paused Company Search or Company Enrich task and return its updated status. Free. The task continues from where it stopped, keeping the companies already delivered, with no new charge. Works only on a paused task, within 7 days of pausing; a task in any other state, including one the API cancelled after 7 days paused, returns 409. Poll company-search-status for the new companies.",
        strictArgs({
            task_id: companyTaskId,
        }),
        async (args) => {
            try {
                return ok(await controlCompanyTask(companies, { task_id: args.task_id, action: "resume" }));
            } catch (error) {
                return fail("Company Search Resume error", error);
            }
        },
        undefined,
        TASK_STATE_CHANGE
    );

    registerTool(
        server,
        apiKey,
        "company-search-cancel",
        "Cancel Company Search",
        "Cancel a Company Search or Company Enrich task. Free. The task stops for good; you pay only for the companies it already delivered (a task cancelled before it starts costs nothing) and the rest of the reservation is returned. Companies delivered so far stay readable for 30 days. This cannot be undone.",
        strictArgs({
            task_id: companyTaskId,
        }),
        async (args) => {
            try {
                return ok(await controlCompanyTask(companies, { task_id: args.task_id, action: "cancel" }));
            } catch (error) {
                return fail("Company Search Cancel error", error);
            }
        },
        undefined,
        TASK_CANCEL
    );

    registerTool(
        server,
        apiKey,
        "company-search-tasks",
        "List Company Search Tasks",
        "Your Company Search and Company Enrich tasks, newest first, with status, counts, cost, why each ended task stopped (completion_reason, coverage_limited), and the metadata labels set on company-search or company-enrich. Free; it lists your own tasks, not the companies they found (read those with company-search-status). People Search tasks are not listed here (see people-search-tasks). Use it to find a task_id (filter by type, status, or metadata to find the tasks of one campaign), or to see which tasks are still queued, running, or paused: a new task is refused while too many People Search and Company Search tasks are active.",
        strictArgs({
            type: z
                .enum(COMPANY_TASK_TYPES)
                .optional()
                .describe("Only Company Search ('search') or only Company Enrich ('enrich') tasks."),
            status: z
                .array(z.enum(COMPANY_TASK_STATUSES))
                .optional()
                .describe("Only tasks in these statuses, example: ['running', 'paused']."),
            limit: z
                .number()
                .int()
                .min(1)
                .max(100)
                .optional()
                .describe("Tasks per page (1-100, API default 20)."),
            cursor: z
                .string()
                .optional()
                .describe("next_cursor from the previous page. Keep the same type, status, and metadata filters when you page."),
            metadata: peopleMetadata(PEOPLE_METADATA_MAX_FILTERS)
                .optional()
                .describe(
                    `Only tasks whose metadata has all of these key/value pairs (exact match, up to ${PEOPLE_METADATA_MAX_FILTERS}), example: {"campaign": "q4-outbound"}.`
                ),
        }),
        async (args) => {
            try {
                return ok(await listCompanyTasks(companies, args));
            } catch (error) {
                return fail("Company Search Tasks error", error);
            }
        },
        undefined,
        READ_ONLY_OPEN_WORLD
    );

    // Scanners ask for these lists during discovery. There is nothing to return,
    // but an empty list is a successful response. Method-not-found looks like a
    // broken server to some directory crawlers.
    server.server.registerCapabilities({
        prompts: {},
        resources: {},
    });
    server.server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: [] }));
    server.server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [] }));
    server.server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
        resourceTemplates: [],
    }));

    // The installed SDK tool schema has no securitySchemes field. The list
    // handler adds it after the SDK builds the tool list, and copies the same
    // value into `_meta` so clients that drop unknown top-level fields still
    // see it. Connector hosts use it to see that tool calls need OAuth.
    publishToolSecurity(server);

    return server;
}

function publishToolSecurity(server: McpServer): void {
    const low = server.server as unknown as {
        _requestHandlers: Map<
            string,
            (request: unknown, extra: unknown) => Promise<{ tools?: Array<Record<string, unknown>> }>
        >;
        setRequestHandler: (
            schema: typeof ListToolsRequestSchema,
            handler: (request: unknown, extra: unknown) => Promise<unknown>
        ) => void;
    };
    const previous = low._requestHandlers.get("tools/list");
    if (!previous) {
        return;
    }
    low.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
        const result = await previous(request, extra);
        if (Array.isArray(result?.tools)) {
            for (const tool of result.tools) {
                const securitySchemes = [{ type: "oauth2", scopes: ["mcp"] }];
                tool.securitySchemes = securitySchemes;
                const existing = tool._meta;
                const meta =
                    existing !== null && typeof existing === "object" && !Array.isArray(existing)
                        ? { ...(existing as Record<string, unknown>) }
                        : {};
                meta.securitySchemes = [{ type: "oauth2", scopes: ["mcp"] }];
                tool._meta = meta;
            }
        }
        return result;
    });
}
