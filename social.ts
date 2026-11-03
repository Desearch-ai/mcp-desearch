import type { DesearchApi } from "./desearch-api.js";

/**
 * TikTok, Facebook, Instagram, YouTube, Reddit, and Threads on the Desearch API
 * (`/desearch/{platform}/*`).
 *
 * desearch-js 1.5 has no social methods, so the `tiktok`, `facebook`, `instagram`,
 * `youtube`, `reddit`, and `threads` tools call these routes through `desearch-api.ts`.
 * Each tool takes an `action` that picks one route; the table below says which
 * arguments each route needs and accepts, and the request is refused before it is
 * sent when they do not match.
 *
 * Paging (desearch-public-api docs/social-pagination.md): a list route answers with a
 * JSON array and, when there is another page, an `x-desearch-next-cursor` header.
 * The caller sends that value back unchanged as `cursor`, on the same route with the
 * same target. The header is absent on the last page. A cursor is opaque and lasts
 * 24 hours; this module never builds or changes one.
 */

export const SOCIAL_PLATFORMS = ["tiktok", "facebook", "instagram", "youtube", "reddit", "threads"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export const NEXT_CURSOR_HEADER = "x-desearch-next-cursor";

/** `date_posted` on TikTok search (desearch-public-api model/tiktok.py TikTokSearchRequest). */
export const TIKTOK_DATE_POSTED = [
    "yesterday",
    "this-week",
    "this-month",
    "last-3-months",
    "last-6-months",
    "all-time",
] as const;

export interface SocialActionSpec {
    method: "GET" | "POST";
    /** Route, with `{name}` for each path argument. */
    path: string;
    /** Arguments the route needs. */
    required: readonly string[];
    /** Other arguments the route accepts. `cursor` here means the route pages. */
    optional: readonly string[];
    /** The route answers with a list of items. */
    list?: true;
    /** Values an argument may take on this action, when the tool's schema allows more. */
    choices?: Readonly<Record<string, readonly string[]>>;
}

export const SOCIAL_ACTIONS = {
    tiktok: {
        search: {
            method: "POST",
            path: "/desearch/tiktok/search",
            required: ["query"],
            optional: ["count", "sort", "date_posted", "cursor"],
            list: true,
        },
        post: { method: "GET", path: "/desearch/tiktok/post/{id}", required: ["id"], optional: [] },
        profile: { method: "GET", path: "/desearch/tiktok/profile/{username}", required: ["username"], optional: [] },
        profile_posts: {
            method: "GET",
            path: "/desearch/tiktok/profile/{username}/posts",
            required: ["username"],
            optional: ["count", "cursor"],
            list: true,
        },
        comments: {
            method: "GET",
            path: "/desearch/tiktok/comments/{video_id}",
            required: ["video_id"],
            optional: ["count", "cursor"],
            list: true,
        },
        hashtag: {
            method: "GET",
            path: "/desearch/tiktok/hashtag/{tag}",
            required: ["tag"],
            optional: ["count", "cursor"],
            list: true,
        },
        trending: {
            method: "GET",
            path: "/desearch/tiktok/trending",
            required: [],
            optional: ["region", "count"],
            list: true,
        },
    },
    facebook: {
        search: {
            method: "POST",
            path: "/desearch/facebook/search",
            required: ["query"],
            optional: ["count", "cursor"],
            list: true,
        },
        post: { method: "GET", path: "/desearch/facebook/post/{id}", required: ["id"], optional: [] },
        profile: {
            method: "GET",
            path: "/desearch/facebook/profile/{profile_id}",
            required: ["profile_id"],
            optional: [],
        },
        profile_posts: {
            method: "GET",
            path: "/desearch/facebook/profile/{profile_id}/posts",
            required: ["profile_id"],
            optional: ["count", "cursor"],
            list: true,
        },
        comments: {
            method: "GET",
            path: "/desearch/facebook/comments/{post_id}",
            required: ["post_id"],
            optional: ["count", "cursor"],
            list: true,
        },
        hashtag: {
            method: "GET",
            path: "/desearch/facebook/hashtag/{tag}",
            required: ["tag"],
            optional: ["count", "cursor"],
            list: true,
        },
    },
    instagram: {
        // Instagram search returns one page; the API answers 422 to any cursor.
        search: {
            method: "POST",
            path: "/desearch/instagram/search",
            required: ["query"],
            optional: ["count"],
            list: true,
        },
        media: { method: "GET", path: "/desearch/instagram/media/{id}", required: ["id"], optional: [] },
        profile: {
            method: "GET",
            path: "/desearch/instagram/profile/{username}",
            required: ["username"],
            optional: [],
        },
        profile_posts: {
            method: "GET",
            path: "/desearch/instagram/profile/{username}/posts",
            required: ["username"],
            optional: ["count", "cursor"],
            list: true,
        },
        comments: {
            method: "GET",
            path: "/desearch/instagram/comments/{shortcode}",
            required: ["shortcode"],
            optional: ["count", "cursor"],
            list: true,
        },
        hashtag: {
            method: "GET",
            path: "/desearch/instagram/hashtag/{tag}",
            required: ["tag"],
            optional: ["count", "cursor"],
            list: true,
        },
    },
    youtube: {
        search: {
            method: "POST",
            path: "/desearch/youtube/search",
            required: ["query"],
            optional: ["type", "upload_date", "sort_by", "duration", "cursor"],
            list: true,
        },
        video: { method: "GET", path: "/desearch/youtube/video/{id}", required: ["id"], optional: [] },
        transcript: {
            method: "GET",
            path: "/desearch/youtube/transcript/{video_id}",
            required: ["video_id"],
            optional: ["language"],
        },
        comments: {
            method: "GET",
            path: "/desearch/youtube/comments/{video_id}",
            required: ["video_id"],
            optional: ["order", "cursor"],
            list: true,
        },
        channel: { method: "GET", path: "/desearch/youtube/channel/{handle}", required: ["handle"], optional: [] },
        channel_videos: {
            method: "GET",
            path: "/desearch/youtube/channel/{handle}/videos",
            required: ["handle"],
            optional: ["sort", "cursor"],
            list: true,
        },
    },
    reddit: {
        search: {
            method: "POST",
            path: "/desearch/reddit/search",
            required: ["query"],
            optional: ["sort", "timeframe", "cursor"],
            list: true,
            choices: { sort: ["relevance", "new", "top", "comment_count"] },
        },
        subreddit: { method: "GET", path: "/desearch/reddit/subreddit/{name}", required: ["name"], optional: [] },
        subreddit_posts: {
            method: "GET",
            path: "/desearch/reddit/subreddit/{name}/posts",
            required: ["name"],
            optional: ["sort", "timeframe", "cursor"],
            list: true,
            choices: { sort: ["best", "hot", "new", "top", "rising"] },
        },
        post: { method: "GET", path: "/desearch/reddit/post/{id}", required: ["id"], optional: [] },
        comments: {
            method: "GET",
            path: "/desearch/reddit/comments/{post_id}",
            required: ["post_id"],
            optional: ["cursor"],
            list: true,
        },
    },
    // Threads shows one page of results everywhere: no action takes a cursor.
    threads: {
        search: {
            method: "POST",
            path: "/desearch/threads/search",
            required: ["query"],
            optional: ["start_date", "end_date"],
            list: true,
        },
        search_users: {
            method: "POST",
            path: "/desearch/threads/search/users",
            required: ["query"],
            optional: [],
            list: true,
        },
        profile: { method: "GET", path: "/desearch/threads/profile/{username}", required: ["username"], optional: [] },
        profile_posts: {
            method: "GET",
            path: "/desearch/threads/profile/{username}/posts",
            required: ["username"],
            optional: [],
            list: true,
        },
        post: { method: "GET", path: "/desearch/threads/post/{id}", required: ["id"], optional: [] },
    },
} as const satisfies Record<SocialPlatform, Record<string, SocialActionSpec>>;

export type SocialAction<P extends SocialPlatform> = keyof (typeof SOCIAL_ACTIONS)[P] & string;

/** Action names in table order, for the tool's `action` enum. */
export function socialActionNames<P extends SocialPlatform>(platform: P): [SocialAction<P>, ...SocialAction<P>[]] {
    return Object.keys(SOCIAL_ACTIONS[platform]) as [SocialAction<P>, ...SocialAction<P>[]];
}

function specFor(platform: SocialPlatform, action: string): SocialActionSpec | undefined {
    const actions: Record<string, SocialActionSpec> = SOCIAL_ACTIONS[platform];
    return Object.hasOwn(actions, action) ? actions[action] : undefined;
}

/** "video_id (required), count, cursor" */
export function socialActionUsage(platform: SocialPlatform, action: string): string {
    const spec = specFor(platform, action);
    if (!spec) {
        return "";
    }
    const parts = [...spec.required.map((name) => `${name} (required)`), ...spec.optional];
    return parts.length > 0 ? parts.join(", ") : "no other arguments";
}

/**
 * Light clean-up of a target: trim it, and drop a leading "@" from a username,
 * "#" from a tag, or "r/" from a subreddit name, which the API takes without them.
 * Cursors are never touched.
 */
function cleanTarget(name: string, value: string): string {
    const trimmed = value.trim();
    if (name === "username") {
        return trimmed.replace(/^@+/, "");
    }
    if (name === "tag") {
        return trimmed.replace(/^#+/, "");
    }
    if (name === "name") {
        return trimmed.replace(/^\/?r\//i, "");
    }
    return trimmed;
}

const ARGUMENT_NAMES = [
    "query",
    "type",
    "sort",
    "sort_by",
    "upload_date",
    "date_posted",
    "duration",
    "timeframe",
    "start_date",
    "end_date",
    "id",
    "username",
    "handle",
    "name",
    "profile_id",
    "post_id",
    "video_id",
    "shortcode",
    "tag",
    "language",
    "order",
    "region",
    "count",
    "cursor",
] as const;

/**
 * The route and arguments for one call. Throws before any request when a needed
 * argument is missing or an argument does not apply to the action.
 */
export function socialRequest(
    platform: SocialPlatform,
    args: Record<string, unknown>
): { spec: SocialActionSpec; path: string; values: Record<string, string | number> } {
    const action = String(args.action);
    const spec = specFor(platform, action);
    if (!spec) {
        throw new Error(
            `Unknown ${platform} action "${action}". Actions: ${Object.keys(SOCIAL_ACTIONS[platform]).join(", ")}.`
        );
    }
    const accepted = new Set<string>([...spec.required, ...spec.optional]);
    const values: Record<string, string | number> = {};
    const extra: string[] = [];
    for (const name of ARGUMENT_NAMES) {
        const raw = args[name];
        if (raw === undefined) {
            continue;
        }
        if (!accepted.has(name)) {
            extra.push(name);
            continue;
        }
        values[name] =
            typeof raw === "string" && spec.required.includes(name) ? cleanTarget(name, raw) : (raw as string | number);
    }
    const missing = spec.required.filter((name) => values[name] === undefined || values[name] === "");
    const choices: Readonly<Record<string, readonly string[]>> = spec.choices ?? {};
    const wrong = Object.keys(choices).filter(
        (name) => values[name] !== undefined && !choices[name].includes(String(values[name]))
    );
    if (missing.length > 0 || extra.length > 0 || wrong.length > 0) {
        const problems: string[] = [];
        if (missing.length > 0) {
            problems.push(`${platform} action "${action}" needs ${missing.join(" and ")}.`);
        }
        if (extra.length > 0) {
            problems.push(`${platform} action "${action}" does not take ${extra.join(", ")}.`);
        }
        for (const name of wrong) {
            problems.push(
                `${platform} action "${action}" takes ${name} ${choices[name].join(", ")}, not "${String(values[name])}".`
            );
        }
        throw new Error(
            `${problems.join(" ")} ${action} takes: ${socialActionUsage(platform, action)}. No request was sent.`
        );
    }
    const inPath = new Set<string>();
    const path = spec.path.replace(/\{(\w+)\}/g, (_, name: string) => {
        inPath.add(name);
        // {id:path} routes accept a "/" in the value; encoded, it still reaches the route as one value.
        return encodeURIComponent(String(values[name]));
    });
    const rest: Record<string, string | number> = {};
    for (const [name, value] of Object.entries(values)) {
        if (!inPath.has(name)) {
            rest[name] = value;
        }
    }
    return { spec, path, values: rest };
}

/** One sentence on how to get the next page. */
export function socialNextStep(
    platform: SocialPlatform,
    action: string,
    spec: SocialActionSpec,
    nextCursor: string | null
): string {
    if (!spec.optional.includes("cursor")) {
        return "This action returns one page and takes no cursor.";
    }
    if (nextCursor === null) {
        return "Last page: there are no more results.";
    }
    const same = spec.required.length > 0 ? `, the same ${spec.required.join(" and ")},` : "";
    return `More results: call ${platform} again with action "${action}"${same} and cursor set to next_cursor, unchanged. A cursor works for 24 hours.`;
}

/**
 * Run one social action. A single post, profile, media item, video, transcript,
 * channel, or subreddit comes back as the API sent it. A list comes back as
 * `{ results, next_cursor, next }`: `next_cursor` is the `x-desearch-next-cursor`
 * header (null on the last page) and `next` says how to ask for the next page.
 */
export async function runSocialAction(
    call: DesearchApi,
    platform: SocialPlatform,
    args: Record<string, unknown>
): Promise<unknown> {
    const { spec, path, values } = socialRequest(platform, args);
    const response =
        spec.method === "POST" ? await call("POST", path, { body: values }) : await call("GET", path, { query: values });
    if (!spec.list) {
        return response.data;
    }
    const header = response.headers.get(NEXT_CURSOR_HEADER);
    const nextCursor = header ? header : null;
    return {
        results: response.data,
        next_cursor: nextCursor,
        next: socialNextStep(platform, String(args.action), spec, nextCursor),
    };
}
