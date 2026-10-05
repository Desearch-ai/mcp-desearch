import { z } from "zod";

/**
 * Short source ids for ai-search and web-links-search.
 *
 * Wire values match live OpenAPI ToolEnum / WebToolEnum
 * (https://api.desearch.ai/openapi.json). Display labels such as "Web Search"
 * are the previous ai-search schema. They are accepted here and rewritten to
 * the short id before the Desearch call.
 *
 * - `ToolEnum` (`POST /desearch/ai/search`): `web` and `twitter` only.
 *   `AI_SEARCH_TOOLS` is that set. Other sites are not tool ids; reach them
 *   with `web` plus `include_domains`.
 * - `WebToolEnum` (`POST /desearch/ai/search/links/web`): `web` only.
 *   `WEB_LINK_TOOLS` is `["web"]`. `"Web Search"` still rewrites to `web`.
 */
export const AI_SEARCH_TOOLS = ["web", "twitter"] as const;

export const WEB_LINK_TOOLS = ["web"] as const;

/** Previous ai-search labels that still match ToolEnum. Not advertised in the JSON Schema enum. */
export const LEGACY_DISPLAY_TO_ID: Readonly<Record<string, string>> = {
    "Web Search": "web",
    "Twitter Search": "twitter",
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
