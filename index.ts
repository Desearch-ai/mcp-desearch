#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Desearch from "desearch-js";

const server = new McpServer({
    name: "Desearch",
    version: "0.0.1",
});

const DESEARCH_API_KEY = process.env.DESEARCH_API_KEY;

if (!DESEARCH_API_KEY) {
    throw new Error("DESEARCH_API_KEY environment variable is required");
}

const desearch = new Desearch(DESEARCH_API_KEY);

server.tool(
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
            .describe("Time range for the search, example: 'PAST_WEEK'"),
        model: z
            .enum(["NOVA", "ORBIT"])
            .default("NOVA")
            .describe(
                "Model to use for the search, example: 'NOVA', Nova is 10s model, Orbit is 30s model"
            ),
    },
    async ({ prompt, tools, date_filter, model }) => {
        try {
            const aiResult = await desearch.AISearch({
                prompt,
                tools,
                date_filter,
                model,
                streaming: false,
            });

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(aiResult, null, 2),
                    },
                ],
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `X Search error: ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                    },
                ],
                isError: true,
            };
        }
    }
);

server.tool(
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
            const twitterResult = await desearch.twitterSearch({
                query,
                sort: "Top",
                count,
            });

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(twitterResult, null, 2),
                    },
                ],
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `X Search error: ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                    },
                ],
                isError: true,
            };
        }
    }
);

(async () => {
    try {
        // Start receiving messages on stdin and sending messages on stdout
        const transport = new StdioServerTransport();
        await server.connect(transport);
    } catch (error) {
        console.log(`Server error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
})();
