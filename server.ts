import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import DesearchImport from "desearch-js";
import { z } from "zod";

export const SERVER_NAME = "Desearch";
export const SERVER_VERSION = "0.1.2";

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
}

// desearch-js 1.5 publishes a default class. Node16 resolution types that package
// as a module namespace, so the constructor is applied through a cast.
const Desearch = DesearchImport as unknown as new (apiKey: string) => DesearchClient;

type ToolResult = {
    content: [{ type: "text"; text: string }];
    isError?: boolean;
};

type ToolHandler = (args: any) => Promise<ToolResult>;

const WEB_LINK_TOOLS = [
    "web",
    "hackernews",
    "reddit",
    "wikipedia",
    "youtube",
    "arxiv",
] as const;

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

function ok(value: unknown): ToolResult {
    return {
        content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    };
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
    name: string,
    description: string,
    inputSchema: Record<string, z.ZodTypeAny>,
    handler: ToolHandler
): void {
    // SDK 1.30's tool generics blow the TypeScript instantiation limit on these
    // schemas. Runtime registration is the same registerTool call.
    const register = server.registerTool.bind(server) as (
        toolName: string,
        config: { description: string; inputSchema: Record<string, z.ZodTypeAny> },
        callback: ToolHandler
    ) => unknown;
    register(name, { description, inputSchema }, handler);
}

/**
 * One MCP server bound to a single Desearch API key.
 * Stdio uses the process env key. Remote HTTP builds a new server per request
 * so each caller spends their own key.
 * `client` is a test seam. Production callers omit it and the server builds
 * a desearch-js client from `apiKey`.
 */
export function createDesearchMcpServer(apiKey: string, client?: DesearchClient): McpServer {
    const desearch = client ?? new Desearch(apiKey);
    const server = new McpServer({
        name: SERVER_NAME,
        version: SERVER_VERSION,
    });

    registerTool(
        server,
        "ai-search",
        "Real-time AI search and analysis on web using Desearch AI",
        {
            prompt: z.string().describe("Question, example: 'What is the latest news on AI?'"),
            tools: z
                .array(
                    z.enum([
                        "Twitter Search",
                        "Web Search",
                        "ArXiv Search",
                        "Wikipedia Search",
                        "Youtube Search",
                        "Hacker News Search",
                        "Reddit Search",
                    ])
                )
                .optional()
                .default(["Twitter Search", "Web Search"])
                .describe("Tools to use for the search, example: ['Web Search', 'Twitter Search']"),
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
                .describe("ONLY_LINKS returns links only; LINKS_WITH_FINAL_SUMMARY adds an AI summary."),
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
                    "Model to use for the search, example: 'NOVA', Nova is 10s model, Orbit is 30s model"
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
                return ok(await desearch.aiSearch(payload));
            } catch (error) {
                return fail("AI Search error", error);
            }
        }
    );

    registerTool(
        server,
        "x-search",
        "Search the X (Twitter) using Desearch AI - performs real-time tweet search on X. Optional filters narrow by user, date, language, verification, media, and engagement. Sort stays Top.",
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
        "web-search",
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
        "web-links-search",
        "Search for links across web sources (web, Hacker News, Reddit, Wikipedia, YouTube, arXiv) using Desearch. Does not search X.",
        {
            prompt: z
                .string()
                .describe("Search query prompt, example: 'open source browser automation tools'"),
            tools: z
                .array(z.enum(WEB_LINK_TOOLS))
                .min(1)
                .describe(
                    "Sources to search. Example: ['web', 'reddit', 'arxiv']. X is not available on this tool."
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
                return ok(await desearch.aiWebLinksSearch({ prompt, tools, count }));
            } catch (error) {
                return fail("Web Links Search error", error);
            }
        }
    );

    registerTool(
        server,
        "x-links-search",
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
        "x-posts-by-urls",
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
        "x-post-by-id",
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
        "x-posts-by-user",
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
        "x-post-retweeters",
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
        "x-user-posts",
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
        "x-user-replies",
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
        "x-post-replies",
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

    return server;
}
