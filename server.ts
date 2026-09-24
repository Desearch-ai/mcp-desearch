import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import DesearchImport from "desearch-js";
import { z } from "zod";

export const SERVER_NAME = "Desearch";
export const SERVER_VERSION = "0.1.2";

interface DesearchClient {
    aiSearch(payload: Record<string, unknown>): Promise<unknown>;
    xSearch(payload: { query: string; sort?: "Top" | "Latest"; count?: number }): Promise<unknown>;
    webSearch(payload: { query: string; start?: number }): Promise<unknown>;
    aiWebLinksSearch(payload: { prompt: string; tools: string[]; count?: number }): Promise<unknown>;
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
        "Search the X (Twitter) using Desearch AI - performs real-time tweet search on X.",
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
        },
        async ({ query, count }) => {
            try {
                return ok(
                    await desearch.xSearch({
                        query,
                        sort: "Top",
                        count,
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

    return server;
}
