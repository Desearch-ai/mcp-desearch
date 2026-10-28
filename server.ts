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
import { createDesearchApi, type DesearchApi } from "./desearch-api.js";
import {
    PEOPLE_EXPORT_DEFAULT_ROWS,
    PEOPLE_EXPORT_FORMATS,
    PEOPLE_EXPORT_MAX_CHARS,
    PEOPLE_EXPORT_MAX_ROWS,
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
    exportPeople,
    listPeopleProfiles,
    listPeopleTasks,
    peopleClientFor,
    readPeopleStatus,
    startPeopleSearch,
    type PeopleClient,
} from "./people.js";
import { runSocialAction, socialActionNames, type SocialPlatform } from "./social.js";
import { AI_SEARCH_TOOLS, WEB_LINK_TOOLS, toolIdSchema } from "./tool-sources.js";

export const SERVER_NAME = "Desearch";
export const SERVER_VERSION = "0.4.0";
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
    format?: "html" | "text";
    js?: boolean;
    wait?: number;
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
    content: { type: "text"; text: string }[];
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
 * `people-search` starts a paid job billed to the user's Desearch balance.
 * It creates a new task and reserves balance, but it does not delete or overwrite
 * anything the caller already has, so destructiveHint is false. The unused part
 * of the reservation is returned when the search ends.
 * Calling it again starts (and reserves) another search unless the same idempotency_key is sent.
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
 */
const TASK_STATE_CHANGE: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
};

/**
 * `people-search-cancel` stops a task for good. It cannot be undone, so destructiveHint is true.
 * Repeating it has no further effect (the API answers 409).
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
            .enum(["html", "text"])
            .optional()
            .describe("Content format to return: 'html' or 'text'."),
        js: z.boolean().optional().describe("Render JavaScript before reading the page."),
        wait: z
            .number()
            .optional()
            .describe("Post-load wait in milliseconds when JavaScript rendering is enabled."),
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

// Social tool arguments. A new schema per field, like peopleKeywordList: one shared
// instance in a tool's schema would serialize as a JSON Schema $ref.
function socialTarget(description: string) {
    return z.string().min(1).max(2048).optional().describe(description);
}

function socialCount() {
    return z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe(
            "Most items to return (1-100). API default: 10 for search, 20 for the other list actions. One page may hold fewer."
        );
}

function socialCursor() {
    return z
        .string()
        .min(1)
        .max(4096)
        .optional()
        .describe(
            "next_cursor from the previous page of the same action and target, sent back unchanged. Omit it for the first page."
        );
}

function socialQuery(example: string) {
    return z
        .string()
        .min(1)
        .max(1000)
        .optional()
        .describe(`search: keyword or phrase, example: '${example}'.`);
}

function socialTag() {
    return socialTarget("hashtag: the hashtag without #, example: 'ai'. A leading # is removed.");
}

function socialAction(platform: SocialPlatform, description: string) {
    return z.enum(socialActionNames(platform)).describe(description);
}

const SOCIAL_PAGING =
    "List actions return { results, next_cursor, next }. For the next page, call again with the same action and target and cursor set to next_cursor, unchanged; next_cursor is null on the last page. A cursor lasts 24 hours.";

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
 * `client` and `peopleClient` are test seams. Production callers omit them and the
 * server builds a desearch-js client and a People Search client (people.ts) from `apiKey`.
 * The routes desearch-js 1.5 does not cover (People Search, TikTok, Facebook, Instagram,
 * `POST /search`) share one direct API caller (desearch-api.ts) for that key.
 */
export function createDesearchMcpServer(
    apiKey: string,
    client?: DesearchClient,
    peopleClient?: PeopleClient
): McpServer {
    const desearch = client ?? new Desearch(apiKey);
    const api: DesearchApi = createDesearchApi(apiKey);
    const people = peopleClient ?? peopleClientFor(api);
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
                "Search the public web and X with Desearch. Use search for titles and links, then fetch with a result URL to read the page. search-api returns ranked pages with the passage that best matches the query. Other tools cover AI search, X posts, and page extraction. tiktok, facebook, and instagram read public posts, profiles, comments, and hashtags; their list actions return next_cursor for the next page. People Search finds people and creators on X, YouTube, LinkedIn, and TikTok: people-search starts a paid job billed to the user's Desearch balance, people-search-status reads progress, people-search-pause, people-search-resume, and people-search-cancel pause, resume, or cancel it, and people-search-export returns the people found as CSV or JSON Lines. Calls need a Desearch API key.",
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
        "Extract a public URL and return its content as plain text or HTML using Desearch. Preferred over web-crawl for new integrations. API docs: https://www.desearch.ai/docs/api-reference/get-web-extract",
        pageContentFields(),
        async ({ url, format, js, wait }) => {
            try {
                return ok(await desearch.extract({ url, format, js, wait }));
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
        async ({ url, format, js, wait }) => {
            try {
                return ok(await desearch.webCrawl({ url, format, js, wait }));
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
        "search-api",
        "Search API",
        "Search the web with the Desearch Search API and return ranked pages, each with its title, URL, publication date when known, and the passage that best matches the query. Set page_text to add each page's full text. Returns { results, cost_usd, usage_count, service, currency }. Use search for titles and links only, and web-search for SERP-style snippets.",
        {
            query: z.string().min(1).max(2000).describe("Search query, example: 'Who won the 2024 Nobel Prize in Physics?'"),
            mode: z
                .enum(["fast", "balanced"])
                .optional()
                .describe("'fast' returns results sooner; 'balanced' (API default) favors relevance."),
            count: z
                .number()
                .int()
                .min(10)
                .max(20)
                .multipleOf(5)
                .optional()
                .describe("Number of results: 10 (API default), 15, or 20."),
            start_date: z
                .string()
                .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
                .optional()
                .describe("Only pages published on or after this date (YYYY-MM-DD)."),
            end_date: z
                .string()
                .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
                .optional()
                .describe("Only pages published on or before this date (YYYY-MM-DD)."),
            highlights: z
                .boolean()
                .optional()
                .describe("Include the passage that best matches the query (API default true)."),
            page_text: z.boolean().optional().describe("Include each page's full text (API default false)."),
        },
        async ({ query, mode, count, start_date, end_date, highlights, page_text }) => {
            try {
                const body = { query, ...definedFields({ mode, count, start_date, end_date, highlights, page_text }) };
                return ok((await api("POST", "/search", { body })).data);
            } catch (error) {
                return fail("Search API error", error);
            }
        }
    );

    registerTool(
        server,
        apiKey,
        "tiktok",
        "TikTok",
        "Read public TikTok data with Desearch. Set action and that action's arguments. search (query; optional count, sort, cursor): videos that match a keyword. post (id): one video by its ID. profile (username): one profile. profile_posts (username; optional count, cursor): a user's videos. comments (video_id; optional count, cursor): a video's comments. hashtag (tag; optional count, cursor): videos with a hashtag. trending (optional region, count): trending videos for a region, one page. A video id from search can be passed to post or comments. post and profile return the item itself. " +
            SOCIAL_PAGING,
        strictArgs({
            action: socialAction(
                "tiktok",
                "What to read: 'search', 'post', 'profile', 'profile_posts', 'comments', 'hashtag', or 'trending'."
            ),
            query: socialQuery("bittensor"),
            sort: socialTarget("search: sort option, when TikTok supports one."),
            id: socialTarget("post: the TikTok video ID, example: '7620891413932166433'."),
            username: socialTarget("profile, profile_posts: TikTok username, example: 'tiktok'. A leading @ is removed."),
            video_id: socialTarget("comments: the TikTok video ID."),
            tag: socialTag(),
            region: z
                .string()
                .length(2)
                .optional()
                .describe("trending: two-letter region code, example: 'US' (API default)."),
            count: socialCount(),
            cursor: socialCursor(),
        }),
        async (args) => {
            try {
                return ok(await runSocialAction(api, "tiktok", args));
            } catch (error) {
                return fail("TikTok error", error);
            }
        }
    );

    registerTool(
        server,
        apiKey,
        "facebook",
        "Facebook",
        "Read public Facebook data with Desearch. Set action and that action's arguments. search (query; optional count, cursor) and hashtag (tag; optional count, cursor) return Meta Ad Library ads that match, not organic posts. post (id): one public post. profile (profile_id): a page or profile by ID or public handle. profile_posts (profile_id; optional count, cursor): its posts. comments (post_id; optional count, cursor): a post's comments, about 10 per page. post and profile return the item itself. " +
            SOCIAL_PAGING,
        strictArgs({
            action: socialAction(
                "facebook",
                "What to read: 'search', 'post', 'profile', 'profile_posts', 'comments', or 'hashtag'."
            ),
            query: socialQuery("running shoes"),
            id: socialTarget("post: the public Facebook post or media ID."),
            profile_id: socialTarget("profile, profile_posts: page or profile ID, or its public handle, example: 'facebook'."),
            post_id: socialTarget("comments: the public Facebook post or media ID."),
            tag: socialTag(),
            count: socialCount(),
            cursor: socialCursor(),
        }),
        async (args) => {
            try {
                return ok(await runSocialAction(api, "facebook", args));
            } catch (error) {
                return fail("Facebook error", error);
            }
        }
    );

    registerTool(
        server,
        apiKey,
        "instagram",
        "Instagram",
        "Read public Instagram data with Desearch. Set action and that action's arguments. search (query; optional count): profiles that match, one page with no cursor. media (id): one post by shortcode, numeric ID, or URL. profile (username): one profile. profile_posts (username; optional count, cursor): a user's posts. comments (shortcode; optional count, cursor): a post's comments. hashtag (tag; optional count, cursor): posts with a hashtag. media and profile return the item itself. " +
            SOCIAL_PAGING,
        strictArgs({
            action: socialAction(
                "instagram",
                "What to read: 'search', 'media', 'profile', 'profile_posts', 'comments', or 'hashtag'."
            ),
            query: socialQuery("desearch"),
            id: socialTarget("media: the post shortcode, numeric media ID, or public URL."),
            username: socialTarget("profile, profile_posts: Instagram username, example: 'instagram'. A leading @ is removed."),
            shortcode: socialTarget(
                "comments: the code in the post URL, such as 'DeuOR-CjKE9' in https://www.instagram.com/p/DeuOR-CjKE9/. Numeric media IDs return 404."
            ),
            tag: socialTag(),
            count: socialCount(),
            cursor: socialCursor(),
        }),
        async (args) => {
            try {
                return ok(await runSocialAction(api, "instagram", args));
            } catch (error) {
                return fail("Instagram error", error);
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
        "people-search-export",
        "Export People Found",
        `The people your own People Searches found, as CSV or JSON Lines text: one search (task_id), or everyone found on one platform (platform, with the same q, sort, and filters as people-profiles). Free: it reads people your earlier searches found and runs no new search. The reply is a note with the row count, then the file text cut at a row boundary to max_rows rows and ${PEOPLE_EXPORT_MAX_CHARS.toLocaleString("en-US")} characters; the note says how many rows were cut and where to get the whole file. CSV keeps its header row. The data came from public profiles and posts, with only the contacts each person lists publicly.`,
        strictArgs({
            task_id: z
                .string()
                .uuid()
                .optional()
                .describe(
                    "Export one search: the task_id returned by people-search. Omit it and set platform to export everyone your searches found on that platform."
                ),
            platform: z
                .enum(PEOPLE_PLATFORMS)
                .optional()
                .describe("Without task_id: export everyone found on 'x', 'youtube', 'linkedin', or 'tiktok'."),
            format: z
                .enum(PEOPLE_EXPORT_FORMATS)
                .default("csv")
                .describe("'csv' (default) or 'jsonl' (one JSON object per line)."),
            q: z
                .string()
                .max(200)
                .optional()
                .describe("Platform export only: text in the name, handle, bio, or location."),
            sort: z
                .enum(PEOPLE_PROFILE_SORTS)
                .optional()
                .describe("Platform export only: 'score' (API default), 'recent', or 'audience'."),
            has: z
                .array(z.enum(PEOPLE_FILTER_CHANNELS))
                .optional()
                .describe("Channels every person must have, example: ['email']. 'email' is a public email; the others are a link of that type."),
            min_audience: z.number().int().min(0).optional().describe("Minimum followers (subscribers on YouTube)."),
            max_audience: z.number().int().min(0).optional().describe("Maximum followers (subscribers on YouTube)."),
            min_score: z.number().int().min(0).max(100).optional().describe("Minimum fit score (0-100)."),
            location: z.string().max(100).optional().describe("Text in the location, example: 'united states'."),
            verified: z.boolean().optional().describe("Only verified accounts. Only X and TikTok people carry a verified flag."),
            max_rows: z
                .number()
                .int()
                .min(1)
                .max(PEOPLE_EXPORT_MAX_ROWS)
                .default(PEOPLE_EXPORT_DEFAULT_ROWS)
                .describe(
                    `Most rows to return (1-${PEOPLE_EXPORT_MAX_ROWS}, default ${PEOPLE_EXPORT_DEFAULT_ROWS}). The reply also stops before ${PEOPLE_EXPORT_MAX_CHARS.toLocaleString("en-US")} characters of file text.`
                ),
        }),
        async (args) => {
            try {
                const exported = await exportPeople(people, args);
                const content: ToolResult["content"] = [{ type: "text", text: exported.note }];
                if (exported.text) {
                    content.push({ type: "text", text: exported.text });
                }
                return { content };
            } catch (error) {
                return fail("People Search Export error", error);
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
