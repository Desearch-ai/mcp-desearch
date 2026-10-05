import { z } from "zod";

/**
 * Short source ids for ai-search and web-links-search.
 *
 * Display labels such as "Web Search" are the previous ai-search schema.
 * They are accepted here and rewritten to the short id before the Desearch call.
 * "Youtube Search" is not rewritten; `youtube` is not an ai-search tool id.
 *
 * - `AI_SEARCH_TOOLS` (`POST /desearch/ai/search`): `web`, `twitter`, `arxiv`,
 *   `wikipedia`, `hackernews`, `reddit`. Same order as before, without `youtube`.
 * - `WEB_LINK_TOOLS` (`POST /desearch/ai/search/links/web`): `web` only.
 *   `"Web Search"` still rewrites to `web`.
 */
export const AI_SEARCH_TOOLS = [
    "web",
    "twitter",
    "arxiv",
    "wikipedia",
    "hackernews",
    "reddit",
] as const;

export const WEB_LINK_TOOLS = ["web"] as const;

/** Previous ai-search labels. Not advertised in the JSON Schema enum. */
export const LEGACY_DISPLAY_TO_ID: Readonly<Record<string, string>> = {
    "Web Search": "web",
    "Twitter Search": "twitter",
    "ArXiv Search": "arxiv",
    "Wikipedia Search": "wikipedia",
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
