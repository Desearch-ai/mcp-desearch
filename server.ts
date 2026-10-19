import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
    ListPromptsRequestSchema,
    ListResourcesRequestSchema,
    ListResourceTemplatesRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import DesearchImport from "desearch-js";
import { z } from "zod";
import {
    PEOPLE_CONTROL_ACTIONS,
    PEOPLE_FILTER_CHANNELS,
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
import { AI_SEARCH_TOOLS, WEB_LINK_TOOLS, toolIdSchema } from "./tool-sources.js";

export const SERVER_NAME = "Desearch";
export const SERVER_VERSION = "0.2.1";

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
    min_retweets?: number | string;
    min_replies?: number | string;
    min_likes?: number | string;
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
 * `people-search` creates a billed background task. Calling it again starts
 * (and reserves) another search unless the same idempotency_key is sent.
 */
const BILLED_TASK: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
};

/**
 * `people-search-control` changes a task's state. `cancel` cannot be undone.
 * Repeating the same action has no further effect (the API answers 409).
 */
const TASK_CONTROL: ToolAnnotations = {
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

// A new schema per field: one shared instance would serialize as a JSON Schema $ref.
function peopleKeywordList() {
    return z.array(z.string().min(1).max(120)).max(20);
}

function platformFilterList(): string {
    return Object.entries(PEOPLE_SEARCH_FILTERS)
        .map(([platform, filters]) => `${platform}: ${filters.join(", ")}`)
        .join(". ");
}

const engagementThreshold = z
    .union([z.number().int().min(0), z.string()])
    .optional();

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
            inputSchema,
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
 */
export function createDesearchMcpServer(
    apiKey: string,
    client?: DesearchClient,
    peopleClient?: PeopleClient
): McpServer {
    const desearch = client ?? new Desearch(apiKey);
    const people = peopleClient ?? createPeopleClient(apiKey);
    const server = new McpServer(
        {
            name: SERVER_NAME,
            version: SERVER_VERSION,
        },
        {
            instructions:
                "Search the public web and X with Desearch. Use search for titles and links, then fetch with a result URL to read the page. Other tools cover AI search, X posts, and page extraction. People Search finds people and creators on X, YouTube, LinkedIn, and TikTok: people-search starts a billed search, people-search-status reads progress, and people-search-control can pause, resume, or cancel it. Calls need a Desearch API key.",
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
            min_retweets: engagementThreshold.describe("Minimum number of retweets."),
            min_replies: engagementThreshold.describe("Minimum number of replies."),
            min_likes: engagementThreshold.describe("Minimum number of likes."),
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
        "Extract a public URL and return its content as plain text or HTML using Desearch. Preferred over web-crawl for new integrations.",
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
        "Crawl a public URL and return its content as plain text or HTML on the legacy Desearch /web/crawl route. The SDK marks webCrawl deprecated in favor of extract; this tool stays for parity with that route. Prefer extract for new integrations.",
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
        "Start a People Search: find people on X, YouTube, LinkedIn, or TikTok who match a plain-language description. Each person comes back with a fit score, why they matched, their audience, and public contacts and links. Billed and asynchronous: this call reserves count times the platform's per-person price (reserved_cost_usd) and returns a task_id at once. When the search ends you pay only for the people it delivered (a per-search minimum applies when it finds anyone; a search that finds no one is free) and the rest of the reservation is returned. The search runs in the background, usually for 1 to 5 minutes: poll people-search-status with the task_id to read progress and the people found so far, and use people-search-control to pause, resume, or cancel it. Do not start the same search twice; send idempotency_key so a retry returns the first task instead of charging again. Filters depend on the platform. " +
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
        "Status, progress, and cost of one People Search task, plus a page of the people found so far: name, handle, url, platform, audience, location, fit score, why they matched, contacts, and links. Free. People arrive while the search runs: pass the returned next_cursor as cursor on the next call to get only the people found since then. When done is true and has_more is false you have everyone the search found.",
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
        }
    );

    registerTool(
        server,
        apiKey,
        "people-search-control",
        "Control People Search",
        "Pause, resume, or cancel a People Search task. Free. pause: a queued search pauses at once; a running one finishes its current batch first (status pausing, then paused). A search paused for more than 7 days is cancelled. resume: continues a paused search where it stopped, with no new charge. cancel: stops the search for good; you pay only for the people it already delivered and the rest of the reservation is returned. People found so far stay readable for 30 days.",
        strictArgs({
            task_id: peopleTaskId,
            action: z
                .enum(PEOPLE_CONTROL_ACTIONS)
                .describe("'pause', 'resume', or 'cancel'. cancel cannot be undone."),
        }),
        async (args) => {
            try {
                return ok(await controlPeopleTask(people, args));
            } catch (error) {
                return fail("People Search Control error", error);
            }
        },
        undefined,
        TASK_CONTROL
    );

    registerTool(
        server,
        apiKey,
        "people-search-tasks",
        "List People Search Tasks",
        "Your People Search tasks, newest first, with status, counts, and cost. Free. Use it to find a task_id, or to see which searches are still queued, running, or paused: a new search is refused while too many are active.",
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
            cursor: z.string().optional().describe("next_cursor from the previous page."),
        }),
        async (args) => {
            try {
                return ok(await listPeopleTasks(people, args));
            } catch (error) {
                return fail("People Search Tasks error", error);
            }
        }
    );

    registerTool(
        server,
        apiKey,
        "people-profiles",
        "List People Found",
        "Everyone your People Searches found on one platform, one entry per person: their best-scoring result and the search that found them (found_by). Free; it does not run a new search. Search by name, handle, bio, or location with q, filter by contact channels (has), audience, fit score, location, or verification, and sort by score, recent, or audience. People from searches that ended more than 30 days ago are left out.",
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
        }
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
