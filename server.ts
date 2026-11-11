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
import {
    COMPANY_COUNTRIES_MAX,
    COMPANY_DOMAINS_MAX,
    COMPANY_EXCLUDE_MAX,
    COMPANY_REQUIREMENTS,
    COMPANY_ROLES,
    COMPANY_SEARCH_MAX_BUDGET_USD,
    COMPANY_TASK_STATUSES,
    COMPANY_TASK_TYPES,
    companyClientFor,
    controlCompanyTask,
    listCompanyTasks,
    readCompanyStatus,
    startCompanyEnrich,
    startCompanySearch,
    type CompanyClient,
} from "./companies.js";
import {
    MONITOR_ACCOUNTS_MAX,
    MONITOR_CRITERIA_MAX,
    MONITOR_CRITERION_MAX,
    MONITOR_EVENTS,
    MONITOR_INTERVALS,
    MONITOR_META_ADS_COUNTS,
    MONITOR_METADATA_KEY_MAX,
    MONITOR_METADATA_MAX_KEYS,
    MONITOR_METADATA_VALUE_MAX,
    MONITOR_NAME_MAX,
    MONITOR_QUERY_MAX,
    MONITOR_QUERY_MIN,
    MONITOR_SOURCES,
    MONITOR_STATUSES,
    MONITOR_TIKTOK_COUNTS,
    MONITOR_WEB_COUNTS,
    MONITOR_X_COUNT_MAX,
    createMonitor,
    listMonitorItems,
    listMonitorRuns,
    listMonitors,
    monitorClientFor,
    monitorEstimateBody,
    readMonitorRun,
    rotateMonitorSecret,
    triggerMonitor,
    updateMonitor,
    type MonitorClient,
} from "./monitors.js";
import { FACEBOOK_SEARCH_SORTS, runSocialAction, socialActionNames, type SocialPlatform } from "./social.js";
import { AI_SEARCH_TOOLS, WEB_LINK_TOOLS, toolIdSchema } from "./tool-sources.js";

export const SERVER_NAME = "Desearch";
export const SERVER_VERSION = "0.10.0";
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

/**
 * `monitor-create` and `monitor-trigger` use BILLED_TASK: create adds a monitor and, with
 * run_now (the API default), queues its first billed run; trigger queues one billed run.
 * Neither deletes or overwrites anything, and calling either again creates another monitor
 * or queues another run (the API answers 409 while a run is queued or running).
 *
 * `monitor-update` overwrites settings (the old query, criteria, or per-source options are
 * not kept, and remove_webhook drops the webhook) and `monitor-delete` removes a monitor
 * with its runs and items for good, so both are destructive. Repeating either has no further
 * effect (the same settings again; a second delete answers 404).
 */
const MONITOR_OVERWRITE: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
};

/**
 * `monitor-webhook-rotate-secret` replaces the signing secret: the old one stops verifying
 * deliveries and cannot be restored, and each call makes a new secret.
 */
const MONITOR_SECRET_ROTATE: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
};

/**
 * `monitor-webhook-test` sends a signed test event to the caller's webhook. It changes
 * nothing on Desearch, but each call is one more delivery to the caller's endpoint.
 */
const MONITOR_WEBHOOK_TEST: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
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

function socialQuery(example: string, maxLength = 1000, note = "") {
    return z
        .string()
        .min(1)
        .max(maxLength)
        .optional()
        .describe(`search: keyword or phrase, example: '${example}'.${note}`);
}

function socialDate(description: string) {
    return z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe(description);
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

const monitorId = z
    .string()
    .uuid()
    .describe("monitor_id returned by monitor-create or monitor-list, example: '6f1d0c9e-0d55-4b8e-9a3c-3c4d9b8e2a10'.");

function monitorRunId() {
    return z.string().uuid().describe("run_id from monitor-runs or monitor-trigger.");
}

function monitorSources() {
    return z
        .array(z.enum(MONITOR_SOURCES))
        .min(1)
        .describe(
            "Where to look: any of 'web', 'x', 'reddit', 'youtube', 'threads', 'tiktok', 'instagram', 'facebook', 'meta_ads' (API default ['web', 'x']). Each run searches each source once, or reads its watched accounts and hashtags (x_accounts, reddit_subreddits, youtube_channels, tiktok_accounts, tiktok_hashtags, threads_accounts, instagram_accounts, instagram_hashtags, facebook_pages). 'instagram' and 'facebook' only read watched feeds: 'instagram' needs instagram_accounts or instagram_hashtags and 'facebook' needs facebook_pages (422 otherwise). 'meta_ads' searches the Meta Ad Library (ads) with the query as keywords."
        );
}

function monitorInterval() {
    return z
        .enum(MONITOR_INTERVALS)
        .describe("How often it runs: '1h', '3h', '6h', '12h', '1d' (API default), or '7d'. Each run is billed.");
}

const MONITOR_KEPT_NOTE =
    "the query and criteria still decide what is kept (min_score 0 keeps every new post). Names are sent as given and the API returns them cleaned; a name it cannot read is a 422.";
const MONITOR_ACCOUNTS_NOTE = `the source reads their newest posts each run instead of searching by keyword; ${MONITOR_KEPT_NOTE}`;
const MONITOR_HASHTAGS_NOTE =
    "A hashtag feed lists popular as well as recent posts from any account, so it finds posts outside the watched accounts; with accounts or hashtags, the source reads those feeds each run instead of searching by keyword, and the query and criteria still decide what is kept (min_score 0 keeps every new post). Hashtags are sent as given and the API returns them without # (a tag URL becomes its tag); one it cannot read is a 422.";

/** A watched-accounts (or watched-hashtags) list. A new schema per field. */
function monitorAccounts(description: string) {
    return z.array(z.string().min(1).max(200)).max(MONITOR_ACCOUNTS_MAX).optional().describe(description);
}

// Per-source options, flat here and nested in `options` by monitors.ts. A new schema per field.
// The counts and watched accounts change what a run costs, so monitor-estimate takes them too;
// x_lang and x_min_likes only filter.
function monitorSourceOptions(withFilters: boolean): Record<string, z.ZodTypeAny> {
    const costly: Record<string, z.ZodTypeAny> = {
        web_count: z
            .union([z.literal(MONITOR_WEB_COUNTS[0]), z.literal(MONITOR_WEB_COUNTS[1]), z.literal(MONITOR_WEB_COUNTS[2])])
            .optional()
            .describe("Web pages read per run: 10 (API default), 15, or 20. Sent as options.web.count."),
        x_count: z
            .number()
            .int()
            .min(1)
            .max(MONITOR_X_COUNT_MAX)
            .optional()
            .describe(
                `Newest X posts read per run (1-${MONITOR_X_COUNT_MAX}, API default 20). Not used with x_accounts (a timeline page is 20 posts). Sent as options.x.count.`
            ),
        x_accounts: monitorAccounts(
            `Up to ${MONITOR_ACCOUNTS_MAX} X usernames (1-15 characters) to watch, example: ['OpenAI', '@sama', 'https://x.com/opentensor']. With accounts, ${MONITOR_ACCOUNTS_NOTE} x_lang and x_min_likes still filter the timelines. Sent as options.x.accounts.`
        ),
        reddit_subreddits: monitorAccounts(
            `Up to ${MONITOR_ACCOUNTS_MAX} subreddits to watch, example: ['LocalLLaMA', 'r/bittensor_']. With subreddits, ${MONITOR_ACCOUNTS_NOTE} Sent as options.reddit.subreddits.`
        ),
        youtube_channels: monitorAccounts(
            `Up to ${MONITOR_ACCOUNTS_MAX} YouTube channels to watch: an @handle, a UC... channel ID, or a channel URL, example: ['@OpenAI']. With channels, ${MONITOR_ACCOUNTS_NOTE} Sent as options.youtube.channels.`
        ),
        tiktok_count: z
            .union([
                z.literal(MONITOR_TIKTOK_COUNTS[0]),
                z.literal(MONITOR_TIKTOK_COUNTS[1]),
                z.literal(MONITOR_TIKTOK_COUNTS[2]),
            ])
            .optional()
            .describe(
                "TikTok posts read per run: 10 (API default), 20, or 30; per account and per hashtag with tiktok_accounts or tiktok_hashtags. Billed per read, not per post (see the billing note). Sent as options.tiktok.count."
            ),
        tiktok_accounts: monitorAccounts(
            `Up to ${MONITOR_ACCOUNTS_MAX} TikTok usernames to watch, example: ['openai', '@tiktok']. With accounts, ${MONITOR_ACCOUNTS_NOTE} Sent as options.tiktok.accounts.`
        ),
        tiktok_hashtags: monitorAccounts(
            `Up to ${MONITOR_ACCOUNTS_MAX} TikTok hashtags to watch, in any script, example: ['skincare', '#სილამაზე', 'https://www.tiktok.com/tag/skincare']. ${MONITOR_HASHTAGS_NOTE} Each hashtag is one read per run ($0.003), whatever the number of posts. Sent as options.tiktok.hashtags.`
        ),
        threads_accounts: monitorAccounts(
            `Up to ${MONITOR_ACCOUNTS_MAX} Threads usernames to watch, example: ['zuck', '@mosseri', 'https://www.threads.com/@zuck']. Threads keyword search returns loosely matched posts, so accounts work better. With accounts, ${MONITOR_ACCOUNTS_NOTE} Each account is one request per run ($0.00207). Sent as options.threads.accounts.`
        ),
        instagram_accounts: monitorAccounts(
            `Up to ${MONITOR_ACCOUNTS_MAX} Instagram usernames to watch, example: ['openai', '@nasa', 'https://www.instagram.com/nasa/']. The 'instagram' source has no keyword search and reads only watched accounts and hashtags, so it needs instagram_accounts or instagram_hashtags (422 without either). Each run reads up to 12 newest posts per account; ${MONITOR_KEPT_NOTE} Each account is one read per run ($0.003), whatever the number of posts. Sent as options.instagram.accounts.`
        ),
        instagram_hashtags: monitorAccounts(
            `Up to ${MONITOR_ACCOUNTS_MAX} Instagram hashtags to watch, in any script, example: ['skincare', '#სილამაზე', 'https://www.instagram.com/explore/tags/skincare/']. ${MONITOR_HASHTAGS_NOTE} Each run reads up to 12 posts per hashtag; each hashtag is one read per run ($0.003), whatever the number of posts. Sent as options.instagram.hashtags.`
        ),
        facebook_pages: monitorAccounts(
            `Facebook pages to watch, 1-${MONITOR_ACCOUNTS_MAX}: a page name, a numeric page ID, or a page URL (profile.php?id=... and /pages/Name/123... URLs are read as the ID), example: ['NASA', '100064869009429']. Required with the 'facebook' source, which has no keyword search or hashtag feed and reads only these pages (422 without any); for ads by keyword use the 'meta_ads' source. Each run reads up to 10 newest posts per page; ${MONITOR_KEPT_NOTE} Each page is one read per run ($0.003), whatever the number of posts. Sent as options.facebook.pages.`
        ),
        meta_ads_count: z
            .union([
                z.literal(MONITOR_META_ADS_COUNTS[0]),
                z.literal(MONITOR_META_ADS_COUNTS[1]),
                z.literal(MONITOR_META_ADS_COUNTS[2]),
            ])
            .optional()
            .describe(
                "Meta Ad Library ads read per run with the 'meta_ads' source: 10 (API default), 20, or 30. The search is one read per run ($0.003), whatever the count. The Ad Library is searched with the query as keywords (a brand, product, or short phrase). Sent as options.meta_ads.count."
            ),
    };
    if (!withFilters) {
        return costly;
    }
    return {
        ...costly,
        x_lang: z
            .string()
            .min(2)
            .max(3)
            .optional()
            .describe("Only X posts in this language, example: 'en'. Sent as options.x.lang."),
        x_min_likes: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("Only X posts with at least this many likes. Sent as options.x.min_likes."),
    };
}

/**
 * `metadata` labels: at most 20 keys of 1-64 characters to strings of up to 500. Like
 * peopleMetadata, the key rules are checked in a refinement rather than advertised as
 * `propertyNames`/`maxProperties`, which some MCP clients do not accept.
 */
function monitorMetadata() {
    return z
        .record(z.string(), z.string().max(MONITOR_METADATA_VALUE_MAX))
        .superRefine((value, ctx) => {
            const keys = Object.keys(value);
            if (keys.length > MONITOR_METADATA_MAX_KEYS) {
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: `At most ${MONITOR_METADATA_MAX_KEYS} metadata keys` });
            }
            for (const key of keys) {
                if (key.length < 1 || key.length > MONITOR_METADATA_KEY_MAX) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        path: [key],
                        message: `metadata keys are 1-${MONITOR_METADATA_KEY_MAX} characters`,
                    });
                }
            }
        })
        .describe(
            `Your own labels, example: {"team": "growth"}. Up to ${MONITOR_METADATA_MAX_KEYS} keys of 1-${MONITOR_METADATA_KEY_MAX} characters; values are strings of up to ${MONITOR_METADATA_VALUE_MAX} characters. Echoed in webhook deliveries; the monitor does not use them.`
        );
}

// Fields monitor-create and monitor-update share. A new schema per field.
function monitorSettingsFields(): Record<string, z.ZodTypeAny> {
    return {
        name: z.string().max(MONITOR_NAME_MAX).optional().describe("A label for the console and webhook deliveries."),
        criteria: z
            .array(z.string().min(1).max(MONITOR_CRITERION_MAX))
            .max(MONITOR_CRITERIA_MAX)
            .optional()
            .describe(
                `Up to ${MONITOR_CRITERIA_MAX} conditions a new item must meet to be kept, each up to ${MONITOR_CRITERION_MAX} characters, example: ['Announces a new subnet, release or partnership']. Each is one yes/no question in the screen.`
            ),
        sources: monitorSources().optional(),
        interval: monitorInterval().optional(),
        ...monitorSourceOptions(true),
        min_score: z
            .number()
            .int()
            .min(0)
            .max(100)
            .optional()
            .describe(
                "Score (0-100) an item needs to be kept (API default 60). The score is the lowest of relevant and each criterion."
            ),
        summary: z
            .boolean()
            .optional()
            .describe("Write a short digest of the items each run keeps (API default false). Billed as its LLM usage plus 50%."),
        webhook_url: z
            .string()
            .url()
            .max(2000)
            .optional()
            .describe(
                "HTTPS URL on a public address that receives new items as signed POSTs (redirects are not followed). A new or changed URL gets a new webhook_secret, returned only in this response."
            ),
        webhook_events: z
            .array(z.enum(MONITOR_EVENTS))
            .min(1)
            .optional()
            .describe(
                "Events sent to webhook_url: 'monitor.items.found' (a run kept at least one item), 'monitor.run.completed' (every completed run), 'monitor.run.failed'. API default ['monitor.items.found', 'monitor.run.failed']. Needs webhook_url."
            ),
        metadata: monitorMetadata().optional(),
    };
}

const MONITOR_BILLING =
    "Creating, reading, changing, and deleting monitors is free. Each run is billed when it ends: its searches at their list price (TikTok, Instagram, Facebook, and Meta ads per read, $3.00 per 1,000 reads ($0.003 a read), whatever the number of posts: one read per watched account, hashtag, or Facebook page, per TikTok keyword search, and per Ad Library search; an empty or private TikTok account takes two reads, so the hold counts two per TikTok account; a watched X account about $0.003, its 20-post timeline; a watched subreddit, YouTube channel, or Threads account $0.00207 each; ten watched accounts cost about ten searches), AI screening at $0.05 per 1,000 new items screened, and the summary's LLM usage plus 50% when summary is on. A run with no new items still pays for its searches. While a run is queued or running, its most (max_run_cost_usd) is held on the balance; it is billed what it used and the rest is released. A run that cannot be held fails with insufficient_credits and pauses the monitor. Use monitor-estimate for the cost of a configuration.";

const MONITOR_HOW =
    "Each run searches its sources inside a window that starts where the previous run ended (or, for a source with watched accounts or hashtags, reads each feed's newest posts), drops everything the monitor has already seen, and screens the new items with an AI classifier: relevant (about what the query watches), new_info (news rather than an evergreen page), and one yes/no question per criterion. score is the lowest of relevant and the criteria x 100; an item is kept at min_score (0 keeps every new post). Read kept items with monitor-items or monitor-run; with a webhook they are also POSTed to it, signed with webhook_secret.";

const MONITOR_TIKTOK_NOTE =
    "TikTok search has no working date filter and ranks by relevance, so a TikTok keyword monitor finds a new video only when it reaches TikTok's top results; to follow creators or a tag, watch their accounts (tiktok_accounts) or the hashtag (tiktok_hashtags).";

const MONITOR_SOCIAL_NOTE =
    "'instagram' and 'facebook' have no keyword search: they read only watched feeds, so a monitor with 'instagram' needs instagram_accounts or instagram_hashtags and one with 'facebook' needs facebook_pages, or the API answers 422. Facebook has no organic hashtag feed. 'meta_ads' searches the Meta Ad Library with the query, so write the query as keywords (a brand, product, or short phrase such as 'ChatGPT'); a sentence finds nothing. An ad counts as new the first time a run sees it if it started within the last 30 days, and ads are screened with their own relevance question and no new_info. Threads keyword search returns loosely matched posts, so watch accounts there (threads_accounts).";

const MONITOR_WEBHOOK_VIEW =
    "webhook (null without one; never the secret): url, events, consecutive_failures, and last_delivery, the newest delivery (null before the first): event, status ('pending' while it waits for its first or next attempt at next_attempt_at, with the last answer in status_code and error; 'delivered'; or 'failed' after every retry, at 1, 5, 30, 120, and 360 minutes), attempts, status_code, error, created_at, next_attempt_at, delivered_at. 5 failed deliveries in a row pause the monitor (paused_reason webhook_failing)";

const MONITOR_ITEM_FIELDS =
    "Each item has item_id, run_id, source, url, title, text (cut to 1000 characters), author, published_at, score (0-100), signals (relevant and new_info, plus criteria, the lowest answer across the criteria, when the monitor has criteria; Meta ads have no new_info), found_at, and data by source: X likes, reposts, replies, views; Reddit subreddit, score, comments; YouTube channel, views, thumbnail; TikTok views, likes, comments, shares, saves, duration_s; Threads likes; Instagram likes, comments, views, media_type; Facebook reactions, comments, shares, views; Meta ads page, active, cta, link (the ad's landing page), platforms, thumbnail, with the ad headline as title and url the Ad Library record; web highlights, domain. TikTok, Instagram, and Facebook items also have post_id (the ID the API's GET /desearch/social/post gives the same post; an Instagram shortcode), type (video, image, carousel, reel, ...), hashtags, mentions (TikTok and Instagram), media (links to the post's videos and pictures), and thumbnail; media and thumbnail links expire after a few days. The metrics are the post's when the run found it. An item read from a watched account also has data.account, the name it was watched as, and one read from a watched hashtag has data.hashtag.";

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
 * `client`, `peopleClient`, `companyClient`, and `monitorClient` are test seams. Production
 * callers omit them and the server builds a desearch-js client, a People Search client
 * (people.ts), a Company Search client (companies.ts), and a Monitors client (monitors.ts)
 * from `apiKey`.
 * The routes desearch-js 1.5 does not cover (People Search, Company Search, Monitors, TikTok,
 * Facebook, Instagram, YouTube, Reddit, Threads, `POST /search`) share one direct API caller (desearch-api.ts)
 * for that key.
 */
export function createDesearchMcpServer(
    apiKey: string,
    client?: DesearchClient,
    peopleClient?: PeopleClient,
    companyClient?: CompanyClient,
    monitorClient?: MonitorClient
): McpServer {
    const desearch = client ?? new Desearch(apiKey);
    const api: DesearchApi = createDesearchApi(apiKey);
    const people = peopleClient ?? peopleClientFor(api);
    const companies = companyClient ?? companyClientFor(api);
    const monitors = monitorClient ?? monitorClientFor(api);
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
                "Search the public web and X with Desearch. Use search for titles and links, then fetch with a result URL to read the page. search-api returns ranked pages with the passage that best matches the query. Other tools cover AI search, X posts, and page extraction. tiktok, facebook, instagram, youtube, reddit, and threads read public social data (posts, profiles, comments, hashtags, YouTube transcripts and channels, subreddits); list actions return next_cursor for the next page where the platform has one. People Search finds people and creators on X, YouTube, LinkedIn, and TikTok: people-search starts a paid job billed to the user's Desearch balance, people-search-status reads progress, people-search-pause, people-search-resume, and people-search-cancel pause, resume, or cancel it, and people-search-export returns the people found as CSV or JSON Lines. Company Search finds companies on the web from a description and Company Enrich reads the domains you send; both collect public emails, phones, social profiles, and leaders (CEO, founders, CTO, CFO): company-search and company-enrich start paid jobs billed to the user's Desearch balance, company-search-status reads progress and the companies, and company-search-pause, company-search-resume, and company-search-cancel pause, resume, or cancel a task. Set company-search's max_cost_usd only when the user agreed to that budget: it bills search effort even when few companies are found. Monitors rerun a search over web, X, Reddit, YouTube, Threads, TikTok, and Meta Ad Library ads (or watch chosen accounts there and on Instagram and Facebook) on a schedule and keep only new, relevant items: monitor-create sets one up (free; each run is billed to the user's Desearch balance), monitor-items and monitor-runs read what it found, monitor-update changes or pauses it, monitor-trigger runs it now, and monitor-delete removes it. Calls need a Desearch API key.",
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
        "Read public Facebook data with Desearch. Set action and that action's arguments. search (query; optional count, sort, cursor) and hashtag (tag; optional count, cursor) return Meta Ad Library ads that match, not organic posts. post (id): one public post. profile (profile_id): a page or profile by ID or public handle. profile_posts (profile_id; optional count, cursor): its posts. comments (post_id; optional count, cursor): a post's comments, about 10 per page. post and profile return the item itself. " +
            SOCIAL_PAGING,
        strictArgs({
            action: socialAction(
                "facebook",
                "What to read: 'search', 'post', 'profile', 'profile_posts', 'comments', or 'hashtag'."
            ),
            query: socialQuery("running shoes"),
            sort: z
                .enum(FACEBOOK_SEARCH_SORTS)
                .optional()
                .describe(
                    "search: 'impressions' (API default: most seen first) or 'recent' (Meta's monthly relevance grouping, which puts recently started ads first)."
                ),
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
        "youtube",
        "YouTube",
        "Read public YouTube data with Desearch. Set action and that action's arguments. search (query; optional type, upload_date, sort_by, duration, cursor): videos, Shorts, live streams, channels, and playlists that match a keyword; each result has a type. video (id): one video or Short by ID or URL, with its channel, counts, chapters, and caption languages. transcript (video_id; optional language): its captions as plain text and timestamped segments; a video without captions returns 404. comments (video_id; optional order, cursor): its top-level comments. channel (handle): one channel by handle or channel ID. channel_videos (handle; optional sort, cursor): the channel's videos. A video id from search or channel_videos can be passed to video, transcript, or comments. video, transcript, and channel return the item itself. " +
            SOCIAL_PAGING,
        strictArgs({
            action: socialAction(
                "youtube",
                "What to read: 'search', 'video', 'transcript', 'comments', 'channel', or 'channel_videos'."
            ),
            query: socialQuery("bittensor", 500, " Use intitle:\"...\" for stricter title matching."),
            type: z
                .enum(["videos", "shorts", "channels", "playlists"])
                .optional()
                .describe("search: only this kind of result. Omit for mixed results."),
            upload_date: z
                .enum(["today", "this_week", "this_month", "this_year"])
                .optional()
                .describe("search: only videos uploaded in this window."),
            sort_by: z.enum(["relevance", "popular"]).optional().describe("search: result order."),
            duration: z
                .enum(["under_3_min", "between_3_and_20_min", "over_20_min"])
                .optional()
                .describe("search: video length. Applies to videos, not Shorts."),
            id: socialTarget("video: YouTube video or Short ID, or its full URL, example: 'dQw4w9WgXcQ'."),
            video_id: socialTarget("transcript, comments: YouTube video or Short ID, or its full URL."),
            language: z
                .string()
                .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,4})?$/)
                .optional()
                .describe("transcript: caption language code, example: 'en' or 'es'. Omit for YouTube's default track."),
            order: z.enum(["top", "newest"]).optional().describe("comments: comment order."),
            handle: socialTarget(
                "channel, channel_videos: channel handle (with or without @) or channel ID (UC...), example: '@MrBeast'."
            ),
            sort: z.enum(["latest", "popular"]).optional().describe("channel_videos: video order (API default latest)."),
            cursor: socialCursor(),
        }),
        async (args) => {
            try {
                return ok(await runSocialAction(api, "youtube", args));
            } catch (error) {
                return fail("YouTube error", error);
            }
        }
    );

    registerTool(
        server,
        apiKey,
        "reddit",
        "Reddit",
        "Read public Reddit data with Desearch. Set action and that action's arguments. search (query; optional sort, timeframe, cursor): posts across all subreddits that match a keyword. subreddit (name): a subreddit's description, rules, and weekly activity; the name is case-sensitive ('AskReddit', not 'askreddit'). subreddit_posts (name; optional sort, timeframe, cursor): its posts. post (id): one post by ID or URL, without comments. comments (post_id; optional cursor): a post's comments as a tree, with the replies Reddit loaded alongside them. A post id from search or subreddit_posts can be passed to post or comments. subreddit and post return the item itself. " +
            SOCIAL_PAGING,
        strictArgs({
            action: socialAction("reddit", "What to read: 'search', 'subreddit', 'subreddit_posts', 'post', or 'comments'."),
            query: socialQuery("bittensor", 500),
            sort: z
                .enum(["relevance", "new", "top", "comment_count", "best", "hot", "rising"])
                .optional()
                .describe(
                    "search: 'relevance', 'new', 'top', or 'comment_count'. subreddit_posts: 'best', 'hot', 'new', 'top', or 'rising'."
                ),
            timeframe: z
                .enum(["all", "day", "week", "month", "year"])
                .optional()
                .describe(
                    "search: only posts from this window. subreddit_posts: the window for sort 'top' (ignored with another sort; without a sort it means top)."
                ),
            name: socialTarget(
                "subreddit, subreddit_posts: subreddit name, case-sensitive, example: 'AskReddit'. A leading r/ is removed."
            ),
            id: socialTarget("post: Reddit post ID (example: '1q6pxwn', with or without t3_) or its full URL."),
            post_id: socialTarget("comments: Reddit post ID (with or without t3_) or its full URL."),
            cursor: socialCursor(),
        }),
        async (args) => {
            try {
                return ok(await runSocialAction(api, "reddit", args));
            } catch (error) {
                return fail("Reddit error", error);
            }
        }
    );

    registerTool(
        server,
        apiKey,
        "threads",
        "Threads",
        "Read public Threads data with Desearch. Set action and that action's arguments. search (query; optional start_date, end_date): one page of posts that match a keyword. search_users (query): accounts that match a username or name. profile (username): one profile with bio, followers, and links. profile_posts (username): the account's latest public posts (Threads shows only the most recent ones). post (id): one post by URL or shortcode, with its replies (comments) and the author's own continuation posts (threadItems). profile and post return the item itself. List actions return { results, next_cursor, next }; Threads returns no further pages, so next_cursor is always null and no action takes a cursor.",
        strictArgs({
            action: socialAction(
                "threads",
                "What to read: 'search', 'search_users', 'profile', 'profile_posts', or 'post'."
            ),
            query: socialQuery("bittensor", 500, " search_users: username or name, up to 100 characters, example: 'zuck'."),
            start_date: socialDate("search: only posts on or after this date (YYYY-MM-DD), example: '2026-01-01'."),
            end_date: socialDate("search: only posts on or before this date (YYYY-MM-DD)."),
            username: socialTarget("profile, profile_posts: Threads username, example: 'zuck'. A leading @ is removed."),
            id: socialTarget(
                "post: Threads post URL or shortcode, example: 'DK-BydcJHkF' or 'https://www.threads.com/@zuck/post/DK-BydcJHkF'."
            ),
        }),
        async (args) => {
            try {
                return ok(await runSocialAction(api, "threads", args));
            } catch (error) {
                return fail("Threads error", error);
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

    registerTool(
        server,
        apiKey,
        "company-search",
        "Company Search",
        "Start a paid job billed to the user's Desearch balance: find companies on the web that match a plain-language description, and collect each one's public contact data. Returns a task_id at once, with the task's status and reserved_cost_usd. " +
            "Cost: without max_cost_usd, the call reserves count companies at the Company Search per-company price at the time of the call (reserved_cost_usd; prices at https://desearch.ai/pricing). When the task ends you pay only for the companies it delivered (final_cost_usd; a minimum of 1 when it delivers any; a task that delivers none is free) and the rest of the reservation is returned. A company left out by min_score or require is not billed. Such a search stops once it costs more than the companies it found pay for (completion_reason cost_limit, coverage_limited: true). " +
            "Search budget: with max_cost_usd the whole budget is reserved, and the search goes on until it delivers count or spends the budget. Its search effort is billed where the companies delivered do not cover it, up to the budget, even when it finds few companies or none; the unused part is returned. Set max_cost_usd only when the user agreed to spend that amount, never on your own. " +
            "Find more: when a search ended before count because a limit stopped it (coverage_limited, for example cost_limit), offer the user a new company-search with the same query and filters, continue_from set to its task_id, and count set to the companies still wanted, optionally with a budget the user agrees to. It leaves out every company the earlier search delivered or held for review, so it finds only new ones. " +
            "To check only companies you name, give their websites in query, for example 'Restrict this search to Acme (acme.com.au) and Beta (beta.co.uk). Return only those.' Only those domains are then checked against the rest of the description, with no web search (the task shows them as only_domains and ends with completion_reason all_domains_processed). Companies named without their websites do not restrict the search (warning scope_not_applied). " +
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
                    "The companies you are looking for, in plain language: what they do, where, how far along. Example: 'Series A fintech startups in Berlin building payment infrastructure'. To check only companies you name, give each one's website: 'Restrict this search to Acme (acme.com.au) and Beta (beta.co.uk). Return only those.' Only those domains are checked; companies named without a website do not restrict the search (warning scope_not_applied)."
                ),
            count: z
                .number()
                .int()
                .min(5)
                .max(200)
                .optional()
                .describe(
                    "How many companies to deliver (5-200, API default 25). Without max_cost_usd the task reserves this many and bills only the companies it delivers. With continue_from, the companies still wanted."
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
            max_cost_usd: z
                .number()
                .positive()
                .max(COMPANY_SEARCH_MAX_BUDGET_USD)
                .optional()
                .describe(
                    `Search budget in USD (more than 0, up to ${COMPANY_SEARCH_MAX_BUDGET_USD}): the most this task may charge. Set it only when the user agreed to spend this amount. It must be at least what count reserves (count times the per-company price; a smaller budget is refused with HTTP 422, which gives the minimum). The whole budget is reserved (reserved_cost_usd) and the search goes on until it delivers count or spends the budget. Its search effort is billed where the companies delivered do not cover it, up to the budget, even when it finds few companies or none; the unused part is returned when the task ends. Without it, the search stops once it costs more than the companies it found pay for (cost_limit), and only the companies delivered are billed.`
                ),
            continue_from: z
                .string()
                .uuid()
                .optional()
                .describe(
                    "task_id of an earlier Company Search of yours that has ended, to find only new companies: this search leaves out every company that one delivered, held for review, or was told to exclude, as well as your own exclude. Send the same query and filters with count set to the companies still wanted. HTTP 409 while that task has not ended (queued, running, or paused); 404 when it is not your Company Search (a Company Enrich or People Search task_id is refused)."
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
            "Companies arrive while the task runs and are filled in place by the later stages: pass the returned next_cursor as cursor to get only the companies delivered since then, and call without cursor to read every company in its latest version. stage enriching means every company is delivered and only later stages of some are left. When done is true and has_more is false you have every company. An ended task has completion_reason (why it stopped; all_domains_processed for Company Enrich or a search restricted to the domains its query names, listed as only_domains), coverage_limited: true when a limit stopped it before count (more companies may match: the next hint says how to continue it with continue_from), and warnings. A search with a budget shows max_cost_usd, and progress.effort_units once it ended (the search effort billed where the companies delivered do not cover it); a continued search shows continue_from. Company Search results have fully_verified (every criterion confirmed by the company's own pages) and unverified_criteria (criteria that are unknown or not met, or a disqualifier that applies). These are information only: the company still qualified.",
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
        "Cancel a Company Search or Company Enrich task. Free. The task stops for good; you pay only for the companies it already delivered (a task cancelled before it starts costs nothing) and the rest of the reservation is returned. A Company Search started with max_cost_usd pays for its search effort so far instead when that is more, up to its budget. Companies delivered so far stay readable for 30 days. This cannot be undone.",
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
        "Your Company Search and Company Enrich tasks, newest first, with status, counts, cost, why each ended task stopped (completion_reason, coverage_limited), max_cost_usd and continue_from when a search set them, and the metadata labels set on company-search or company-enrich. Free; it lists your own tasks, not the companies they found (read those with company-search-status). People Search tasks are not listed here (see people-search-tasks). Use it to find a task_id (filter by type, status, or metadata to find the tasks of one campaign), or to see which tasks are still queued, running, or paused: a new task is refused while too many People Search and Company Search tasks are active.",
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

    registerTool(
        server,
        apiKey,
        "monitor-create",
        "Create Monitor",
        "Create a monitor: a search that reruns on a schedule over web, X, Reddit, YouTube, Threads, TikTok, and Meta Ad Library ads (or watches up to 10 X, TikTok, Threads, or Instagram users, subreddits, YouTube channels, or Facebook pages per source, and up to 10 TikTok or Instagram hashtags) and keeps only the new items that match. Returns the monitor (monitor_id, settings, max_run_cost_usd, next_run_at) and, when webhook_url is set, webhook_secret, which is shown only here. With run_now (the API default) the first run is queued at once and billed when it ends; set run_now false to wait for the schedule. " +
            MONITOR_BILLING +
            " " +
            MONITOR_HOW +
            " " +
            MONITOR_TIKTOK_NOTE +
            " " +
            MONITOR_SOCIAL_NOTE +
            " Limits: 25 monitors per account (409 too_many_monitors); 402 when the balance cannot hold one run, even with run_now false.",
        strictArgs({
            query: z
                .string()
                .min(MONITOR_QUERY_MIN)
                .max(MONITOR_QUERY_MAX)
                .describe(
                    `What to watch, in plain words (${MONITOR_QUERY_MIN}-${MONITOR_QUERY_MAX} characters). Each source is searched with it. Example: 'Bittensor subnet launches and updates'. With 'meta_ads', use keywords (a brand, product, or short phrase such as 'ChatGPT'): the Ad Library finds nothing for a sentence.`
                ),
            ...monitorSettingsFields(),
            run_now: z
                .boolean()
                .optional()
                .describe("Queue the first run at once (API default true; billed when it ends). False waits for next_run_at."),
        }),
        async (args) => {
            try {
                return ok(await createMonitor(monitors, args));
            } catch (error) {
                return fail("Create Monitor error", error);
            }
        },
        undefined,
        BILLED_TASK
    );

    registerTool(
        server,
        apiKey,
        "monitor-estimate",
        "Estimate Monitor Cost",
        "The most one run of a monitor with these sources, counts, and watched accounts and hashtags can cost (max_run_cost_usd, the amount held while it runs), how many runs a month its interval makes, the most a month can cost, and a breakdown in USD per source plus screening and summary. Free: it creates nothing and runs no search. A run is billed only what it used, which is usually less. Unlike monitor-create, it does not refuse 'instagram' or 'facebook' without accounts or hashtags. " +
            MONITOR_BILLING,
        strictArgs({
            sources: monitorSources().optional(),
            ...monitorSourceOptions(false),
            summary: z.boolean().optional().describe("Include the summary's LLM cost (API default false)."),
            interval: monitorInterval().optional(),
        }),
        async (args) => {
            try {
                return ok(await monitors.estimate(monitorEstimateBody(args)));
            } catch (error) {
                return fail("Estimate Monitor Cost error", error);
            }
        },
        undefined,
        READ_ONLY_OPEN_WORLD
    );

    registerTool(
        server,
        apiKey,
        "monitor-list",
        "List Monitors",
        "Your monitors, newest first, with their settings, status (active or paused, and paused_reason: user, insufficient_credits, or webhook_failing), webhook (url, events, consecutive_failures, and last_delivery, the newest delivery with its status, as on monitor-get; never the secret), next_run_at, last_run, and totals (runs, items, spent_usd). Free. Returns { monitors, next_cursor }; next_cursor is null on the last page.",
        strictArgs({
            status: z
                .array(z.enum(MONITOR_STATUSES))
                .optional()
                .describe("Only monitors in these statuses: 'active', 'paused'."),
            limit: z.number().int().min(1).max(100).optional().describe("Monitors per page (1-100, API default 20)."),
            cursor: z
                .string()
                .min(1)
                .max(512)
                .optional()
                .describe("next_cursor from the previous page. Keep the same status filter when you page."),
        }),
        async (args) => {
            try {
                return ok(await listMonitors(monitors, args));
            } catch (error) {
                return fail("List Monitors error", error);
            }
        },
        undefined,
        READ_ONLY_OPEN_WORLD
    );

    registerTool(
        server,
        apiKey,
        "monitor-get",
        "Get Monitor",
        "One monitor: settings, status and paused_reason, " +
            MONITOR_WEBHOOK_VIEW +
            ", max_run_cost_usd, next_run_at, last_run (run_id, status, item_count, cost_usd), and totals (runs, items, spent_usd). Free. Use webhook.last_delivery to tell whether deliveries reach the endpoint: a 'pending' delivery with an error is being retried.",
        strictArgs({ monitor_id: monitorId }),
        async (args) => {
            try {
                return ok(await monitors.get(args.monitor_id));
            } catch (error) {
                return fail("Get Monitor error", error);
            }
        },
        undefined,
        READ_ONLY_OPEN_WORLD
    );

    registerTool(
        server,
        apiKey,
        "monitor-update",
        "Update Monitor",
        "Change a monitor's settings and return it. Free. Send only what changes. status 'paused' stops scheduled runs (monitor-trigger still runs it once) and 'active' resumes them, also after a pause for credits or a failing webhook. The per-source options (web_count, x_count, x_lang, x_min_likes, x_accounts, reddit_subreddits, youtube_channels, tiktok_count, tiktok_accounts, tiktok_hashtags, threads_accounts, instagram_accounts, instagram_hashtags, facebook_pages, meta_ads_count) replace the monitor's options as a whole: send every option you want to keep, including its watched accounts and hashtags (an empty list watches none). The API checks the monitor as changed: an update that leaves 'instagram' without instagram_accounts or instagram_hashtags or 'facebook' without facebook_pages (new sources with the current options, or new options with the current sources) is a 422. A new webhook_url gets a new webhook_secret, returned only in this response; remove_webhook removes the webhook. The old values are not kept.",
        strictArgs({
            monitor_id: monitorId,
            query: z
                .string()
                .min(MONITOR_QUERY_MIN)
                .max(MONITOR_QUERY_MAX)
                .optional()
                .describe(`New query (${MONITOR_QUERY_MIN}-${MONITOR_QUERY_MAX} characters).`),
            ...monitorSettingsFields(),
            status: z
                .enum(MONITOR_STATUSES)
                .optional()
                .describe("'paused' stops scheduled runs; 'active' resumes them."),
            remove_webhook: z
                .boolean()
                .optional()
                .describe("true removes the webhook (sent as webhook: null). Do not combine with webhook_url."),
        }),
        async (args) => {
            try {
                return ok(await updateMonitor(monitors, args));
            } catch (error) {
                return fail("Update Monitor error", error);
            }
        },
        undefined,
        MONITOR_OVERWRITE
    );

    registerTool(
        server,
        apiKey,
        "monitor-delete",
        "Delete Monitor",
        "Delete a monitor for good. Free. A queued run is cancelled and its hold released; its runs and items are no longer readable. This cannot be undone: to stop it for a while, use monitor-update with status 'paused' instead.",
        strictArgs({ monitor_id: monitorId }),
        async (args) => {
            try {
                return ok(await monitors.remove(args.monitor_id));
            } catch (error) {
                return fail("Delete Monitor error", error);
            }
        },
        undefined,
        MONITOR_OVERWRITE
    );

    registerTool(
        server,
        apiKey,
        "monitor-trigger",
        "Run Monitor Now",
        "Queue one run of a monitor now, outside its schedule, and return the run (run_id, status queued). It costs one run, billed when it ends (at most the monitor's max_run_cost_usd); it works on a paused monitor too. 409 run_in_progress while a run is queued or running; 402 when the balance cannot hold the run. Poll monitor-run with the run_id.",
        strictArgs({ monitor_id: monitorId }),
        async (args) => {
            try {
                return ok(await triggerMonitor(monitors, args));
            } catch (error) {
                return fail("Run Monitor Now error", error);
            }
        },
        undefined,
        BILLED_TASK
    );

    registerTool(
        server,
        apiKey,
        "monitor-runs",
        "List Monitor Runs",
        "A monitor's runs, newest first: trigger (schedule or manual), status (queued, running, completed, failed, cancelled) and fail_reason, the window it searched, item_count, stats per source (fetched, in_window, new, passed, error, accounts_failed and hashtags_failed: watched accounts and hashtags that could not be read; the source fails only when all of them do) and how items were screened (stats.screen: ai, by an AI classifier, or keyword when it fell back), summary, reserved_usd, and cost_usd (null until billed). Free. Returns { runs, next_cursor }; next_cursor is null on the last page.",
        strictArgs({
            monitor_id: monitorId,
            limit: z.number().int().min(1).max(100).optional().describe("Runs per page (1-100, API default 20)."),
            cursor: z.string().min(1).max(512).optional().describe("next_cursor from the previous page."),
        }),
        async (args) => {
            try {
                return ok(await listMonitorRuns(monitors, args));
            } catch (error) {
                return fail("List Monitor Runs error", error);
            }
        },
        undefined,
        READ_ONLY_OPEN_WORLD
    );

    registerTool(
        server,
        apiKey,
        "monitor-run",
        "Get Monitor Run",
        "One run with the items it kept, most relevant first, plus its status, stats, summary, and cost. Free. " +
            MONITOR_ITEM_FIELDS +
            " The run's stats.sources.<source>.accounts_failed and hashtags_failed list watched accounts and hashtags it could not read.",
        strictArgs({ monitor_id: monitorId, run_id: monitorRunId() }),
        async (args) => {
            try {
                return ok(await readMonitorRun(monitors, args));
            } catch (error) {
                return fail("Get Monitor Run error", error);
            }
        },
        undefined,
        READ_ONLY_OPEN_WORLD
    );

    registerTool(
        server,
        apiKey,
        "monitor-items",
        "List Monitor Items",
        "Everything a monitor kept across its runs, newest first. Free. Filter by source. Returns { items, next_cursor }; next_cursor is null on the last page. To get only what is new since your last read, keep the first item_id you saw and stop paging when you reach it. " +
            MONITOR_ITEM_FIELDS,
        strictArgs({
            monitor_id: monitorId,
            source: z
                .enum(MONITOR_SOURCES)
                .optional()
                .describe(
                    "Only items from this source: 'web', 'x', 'reddit', 'youtube', 'threads', 'tiktok', 'instagram', 'facebook', 'meta_ads'."
                ),
            limit: z.number().int().min(1).max(200).optional().describe("Items per page (1-200, API default 50)."),
            cursor: z
                .string()
                .regex(/^\d+$/)
                .optional()
                .describe("next_cursor from the previous page. Keep the same source filter when you page."),
        }),
        async (args) => {
            try {
                return ok(await listMonitorItems(monitors, args));
            } catch (error) {
                return fail("List Monitor Items error", error);
            }
        },
        undefined,
        READ_ONLY_OPEN_WORLD
    );

    registerTool(
        server,
        apiKey,
        "monitor-webhook-test",
        "Test Monitor Webhook",
        "Send a signed monitor.test event with one sample item to the monitor's webhook and report what the endpoint answered: { delivered (a 2xx within 10 seconds), status_code, error, duration_ms }. Free; it is not retried, does not count toward webhook_failing, and does not change webhook.last_delivery. 400 when the monitor has no webhook.",
        strictArgs({ monitor_id: monitorId }),
        async (args) => {
            try {
                return ok(await monitors.testWebhook(args.monitor_id));
            } catch (error) {
                return fail("Test Monitor Webhook error", error);
            }
        },
        undefined,
        MONITOR_WEBHOOK_TEST
    );

    registerTool(
        server,
        apiKey,
        "monitor-webhook-rotate-secret",
        "Rotate Monitor Webhook Secret",
        "Replace the monitor's webhook signing secret and return the new webhook_secret, shown only here. Free. Deliveries from now on are signed with it, and the old secret no longer verifies them: update your endpoint before the next run. 400 when the monitor has no webhook.",
        strictArgs({ monitor_id: monitorId }),
        async (args) => {
            try {
                return ok(await rotateMonitorSecret(monitors, args));
            } catch (error) {
                return fail("Rotate Monitor Webhook Secret error", error);
            }
        },
        undefined,
        MONITOR_SECRET_ROTATE
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
