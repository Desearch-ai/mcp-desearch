import { z } from "zod";

/**
 * Short source ids shared by ai-search and web-links-search.
 *
 * Wire values are the short ids from live OpenAPI
 * (https://api.desearch.ai/openapi.json, checked 2026-10-01) and from
 * desearch-js `ToolEnum` / `WebToolEnum`. Display labels such as "Web Search"
 * are the previous ai-search schema. They are accepted here and rewritten to
 * the short id before the Desearch call.
 *
 * Live OpenAPI names a narrower set than desearch-js 1.5:
 * - `ToolEnum` (`POST /desearch/ai/search`): `web`, `twitter`. Items are
 *   `ToolEnum | string`, and the previous MCP tool already offered the other
 *   desearch-js sources under display labels. Those stay, spelled as short ids.
 *   PR #13 did not see a 422 for this route.
 * - `WebToolEnum` (`POST /desearch/ai/search/links/web`): `web` only. The other
 *   short ids 422 (`supported tools are Web Search`). Open PR #13 narrows
 *   `WEB_LINK_TOOLS` to `["web"]`. This list stays the current main membership
 *   so that narrowing stays in #13.
 */
export const AI_SEARCH_TOOLS = [
    "web",
    "twitter",
    "arxiv",
    "wikipedia",
    "youtube",
    "hackernews",
    "reddit",
] as const;

export const WEB_LINK_TOOLS = [
    "web",
    "hackernews",
    "reddit",
    "wikipedia",
    "youtube",
    "arxiv",
] as const;

/** Previous ai-search labels. Not advertised in the JSON Schema enum. */
export const LEGACY_DISPLAY_TO_ID: Readonly<Record<string, string>> = {
    "Web Search": "web",
    "Twitter Search": "twitter",
    "ArXiv Search": "arxiv",
    "Wikipedia Search": "wikipedia",
    "Youtube Search": "youtube",
    "Hacker News Search": "hackernews",
    "Reddit Search": "reddit",
};

export function canonicalToolId(value: string): string {
    return LEGACY_DISPLAY_TO_ID[value] ?? value;
}

type NonEmptyIds = readonly [string, ...string[]];

/**
 * JSON Schema enum is the short ids. Zod still accepts a legacy display label
 * and replaces it with the short id the API examples and SDKs send.
 */
export function toolIdSchema<T extends NonEmptyIds>(ids: T) {
    return z.preprocess(
        (value) => (typeof value === "string" ? canonicalToolId(value) : value),
        z.enum(ids as unknown as [string, ...string[]])
    );
}
