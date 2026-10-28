import { fetch } from "undici";

/**
 * People Search on the Desearch API (`/desearch/people/*`).
 *
 * desearch-js 1.5 has no People Search methods, so this module calls the routes
 * directly with the same base URL, `Authorization: <key>` header, and
 * `HTTP <status>: <detail>` error text that desearch-js uses.
 *
 * - `POST /desearch/people/search/{platform}` starts a background search and is billed:
 *   it reserves `count` people at the route price and settles to what it delivers.
 * - Every other route (tasks, results, pause/resume/cancel, profiles) is free.
 */

export const PEOPLE_API_BASE_URL = "https://api.desearch.ai";

export const PEOPLE_PLATFORMS = ["x", "youtube", "linkedin", "tiktok"] as const;
export type PeoplePlatform = (typeof PEOPLE_PLATFORMS)[number];

export const PEOPLE_TASK_STATUSES = [
    "queued",
    "running",
    "pausing",
    "paused",
    "cancelling",
    "completed",
    "partial",
    "failed",
    "cancelled",
    "expired",
] as const;

/** Statuses after which a task does not change again. */
export const PEOPLE_ENDED_STATUSES: ReadonlySet<string> = new Set([
    "completed",
    "partial",
    "failed",
    "cancelled",
    "expired",
]);

/** `has` channels on `GET /desearch/people/profiles` (src/utils/people_filters.py). */
export const PEOPLE_FILTER_CHANNELS = [
    "email",
    "website",
    "x",
    "linkedin",
    "instagram",
    "youtube",
    "tiktok",
] as const;

export const PEOPLE_PROFILE_SORTS = ["score", "recent", "audience"] as const;

export const PEOPLE_CONTROL_ACTIONS = ["pause", "resume", "cancel"] as const;

/**
 * `metadata`: the caller's own labels on a search (desearch-public-api model/people.py).
 * A search takes up to 10 keys; `GET /desearch/people/tasks` takes up to 3 as
 * `metadata.<key>=<value>` filters.
 */
export const PEOPLE_METADATA_KEY_PATTERN = "^[a-z0-9_.-]{1,40}$";
export const PEOPLE_METADATA_MAX_KEYS = 10;
export const PEOPLE_METADATA_MAX_FILTERS = 3;
export const PEOPLE_METADATA_VALUE_MAX = 200;
export type PeopleControlAction = (typeof PEOPLE_CONTROL_ACTIONS)[number];

/**
 * Search filters each platform accepts inside the request `filters` object.
 * The API forbids extra keys, so a filter that is not listed for a platform
 * is rejected before the billed call instead of returning HTTP 422.
 */
export const PEOPLE_SEARCH_FILTERS = {
    x: ["min_followers", "max_followers", "verified_only", "countries", "keywords", "exclude_keywords"],
    youtube: [
        "min_subscribers",
        "max_subscribers",
        "countries",
        "require_contact",
        "keywords",
        "exclude_keywords",
    ],
    linkedin: ["min_followers", "max_followers", "countries", "keywords", "exclude_keywords"],
    tiktok: ["min_followers", "max_followers", "require_contact", "keywords", "exclude_keywords"],
} as const satisfies Record<PeoplePlatform, readonly string[]>;

export const PEOPLE_SEARCH_FILTER_NAMES = [
    "min_followers",
    "max_followers",
    "min_subscribers",
    "max_subscribers",
    "verified_only",
    "require_contact",
    "countries",
    "keywords",
    "exclude_keywords",
] as const;

export interface PeopleSearchArgs {
    platform: PeoplePlatform;
    query: string;
    count?: number;
    min_score?: number;
    exclude?: string[];
    metadata?: Record<string, string>;
    idempotency_key?: string;
    min_followers?: number;
    max_followers?: number;
    min_subscribers?: number;
    max_subscribers?: number;
    verified_only?: boolean;
    require_contact?: boolean;
    countries?: string[];
    keywords?: string[];
    exclude_keywords?: string[];
}

export interface PeopleApiResponse {
    status: number;
    data: unknown;
}

export type QueryValue = string | number | boolean | undefined;

export interface PeopleClient {
    startSearch(
        platform: PeoplePlatform,
        body: Record<string, unknown>,
        idempotencyKey?: string
    ): Promise<PeopleApiResponse>;
    getTask(taskId: string): Promise<unknown>;
    getResults(taskId: string, params: { cursor?: string; limit?: number }): Promise<unknown>;
    controlTask(taskId: string, action: PeopleControlAction): Promise<unknown>;
    listTasks(params: Record<string, QueryValue>): Promise<unknown>;
    listProfiles(params: Record<string, QueryValue>): Promise<unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorDetail(data: unknown, text: string): string {
    if (isPlainObject(data) && data.detail !== undefined) {
        const detail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
        const task = isPlainObject(data.task) ? data.task : undefined;
        return typeof task?.status === "string" ? `${detail} Task status: ${task.status}.` : detail;
    }
    return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

export function withQuery(path: string, params: Record<string, QueryValue>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
            search.append(key, String(value));
        }
    }
    const qs = search.toString();
    return qs ? `${path}?${qs}` : path;
}

export type ApiCall = (
    method: "GET" | "POST",
    path: string,
    options?: { body?: Record<string, unknown>; headers?: Record<string, string> }
) => Promise<PeopleApiResponse>;

/**
 * One Desearch API request with the desearch-js conventions: `Authorization: <key>`,
 * a JSON body, and `HTTP <status>: <detail>` on an error status. People Search and
 * Company Search (companies.ts) share it.
 */
export function createApiCall(apiKey: string, baseUrl: string = PEOPLE_API_BASE_URL): ApiCall {
    return async function call(method, path, options = {}) {
        const headers: Record<string, string> = { Authorization: apiKey, ...options.headers };
        if (options.body) {
            headers["Content-Type"] = "application/json";
        }
        let response;
        let text;
        try {
            response = await fetch(`${baseUrl}${path}`, {
                method,
                headers,
                body: options.body ? JSON.stringify(options.body) : undefined,
            });
            text = await response.text();
        } catch (error) {
            throw new Error(
                `Unexpected Error: ${error instanceof Error ? error.message : String(error)}`
            );
        }
        let data: unknown = text;
        if (text) {
            try {
                data = JSON.parse(text);
            } catch {
                // Not JSON: keep the text.
            }
        }
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${errorDetail(data, text)}`);
        }
        return { status: response.status, data };
    };
}

export function createPeopleClient(apiKey: string, baseUrl: string = PEOPLE_API_BASE_URL): PeopleClient {
    const call = createApiCall(apiKey, baseUrl);
    const taskPath = (taskId: string) => `/desearch/people/tasks/${encodeURIComponent(taskId)}`;

    return {
        startSearch(platform, body, idempotencyKey) {
            return call("POST", `/desearch/people/search/${platform}`, {
                body,
                headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
            });
        },
        async getTask(taskId) {
            return (await call("GET", taskPath(taskId))).data;
        },
        async getResults(taskId, params) {
            return (await call("GET", withQuery(`${taskPath(taskId)}/results`, params))).data;
        },
        async controlTask(taskId, action) {
            return (await call("POST", `${taskPath(taskId)}/${action}`)).data;
        },
        async listTasks(params) {
            return (await call("GET", withQuery("/desearch/people/tasks", params))).data;
        },
        async listProfiles(params) {
            return (await call("GET", withQuery("/desearch/people/profiles", params))).data;
        },
    };
}

/**
 * Request body for `POST /desearch/people/search/{platform}`.
 * Throws when a filter does not apply to the platform, so no billed call is made.
 */
export function peopleSearchBody(args: PeopleSearchArgs): Record<string, unknown> {
    const allowed: readonly string[] = PEOPLE_SEARCH_FILTERS[args.platform];
    const filters: Record<string, unknown> = {};
    const rejected: string[] = [];
    for (const name of PEOPLE_SEARCH_FILTER_NAMES) {
        const value = args[name];
        if (value === undefined) {
            continue;
        }
        if (!allowed.includes(name)) {
            rejected.push(name);
            continue;
        }
        filters[name] = value;
    }
    if (rejected.length > 0) {
        throw new Error(
            `${rejected.join(", ")} ${rejected.length === 1 ? "does" : "do"} not apply to ${args.platform}. ${args.platform} filters: ${allowed.join(", ")}. Nothing was charged.`
        );
    }
    const body: Record<string, unknown> = { query: args.query };
    if (args.count !== undefined) body.count = args.count;
    if (args.min_score !== undefined) body.min_score = args.min_score;
    if (args.exclude !== undefined) body.exclude = args.exclude;
    if (Object.keys(filters).length > 0) body.filters = filters;
    if (args.metadata !== undefined && Object.keys(args.metadata).length > 0) body.metadata = args.metadata;
    return body;
}

export function compact(fields: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined || value === null || value === "") continue;
        if (Array.isArray(value) && value.length === 0) continue;
        if (isPlainObject(value) && Object.keys(value).length === 0) continue;
        out[key] = value;
    }
    return out;
}

export function objectOf(value: unknown): Record<string, unknown> {
    return isPlainObject(value) ? value : {};
}

export function arrayOf(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

export function numberOf(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function stringOf(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

// A check's `is_disqualifier` says whether it is a disqualifier. Checks scored before the
// flag existed fall back to the worker's keyword rule, which also sets the flag; the API's
// CSV `unverified_criteria` column (desearch-public-api src/utils/people_criteria.py) does the same.
const DISQUALIFIER_CRITERION = /\b(disqualif(?:y|ier|iers)|exclude|excluding|not a fit|not qualified)\b/i;
const MAX_UNVERIFIED = 5;
const MAX_CRITERION_CHARS = 120;

/**
 * The criteria a person's own profile and posts do not confirm, as short strings:
 * a criterion that is not met ("(unknown)" or "(not met)"), or a disqualifier that
 * applies ("(applies)"). Empty for results scored before criteria checks existed.
 */
export function unverifiedCriteria(score: unknown): string[] {
    const out: string[] = [];
    for (const check of arrayOf(objectOf(score).criteria_checks).map(objectOf)) {
        const criterion = stringOf(check.criterion);
        if (!criterion) continue;
        const met = check.verdict === "met";
        const disqualifier =
            typeof check.is_disqualifier === "boolean"
                ? check.is_disqualifier
                : DISQUALIFIER_CRITERION.test(criterion);
        if (met !== disqualifier) continue;
        const label = disqualifier ? "applies" : check.verdict === "not_met" ? "not met" : "unknown";
        const text =
            criterion.length > MAX_CRITERION_CHARS ? `${criterion.slice(0, MAX_CRITERION_CHARS - 3)}...` : criterion;
        out.push(`${text} (${label})`);
    }
    return out.length > MAX_UNVERIFIED
        ? [...out.slice(0, MAX_UNVERIFIED), `and ${out.length - MAX_UNVERIFIED} more`]
        : out;
}

/**
 * One person as an agent needs it: who they are, how big their audience is,
 * how well they fit and why, what their profile does not confirm, and how to reach them.
 */
export function compactPerson(person: unknown): Record<string, unknown> {
    const p = objectOf(person);
    const metrics = objectOf(p.metrics);
    const attributes = objectOf(p.attributes);
    const score = objectOf(p.score);
    const evidence = arrayOf(p.evidence).map(objectOf);
    const found = isPlainObject(p.found_by) ? p.found_by : undefined;
    return compact({
        id: p.id,
        platform: p.platform,
        handle: p.handle,
        name: p.name,
        url: p.url,
        audience: numberOf(metrics.followers) ?? numberOf(metrics.subscribers),
        location: stringOf(p.location),
        verified: typeof attributes.verified === "boolean" ? attributes.verified : undefined,
        headline: stringOf(attributes.headline),
        company: stringOf(attributes.company),
        score: numberOf(score.value),
        why: stringOf(score.summary),
        reasons: arrayOf(score.reasons).filter((r) => typeof r === "string").slice(0, 3),
        fully_verified: typeof score.fully_verified === "boolean" ? score.fully_verified : undefined,
        unverified_criteria: unverifiedCriteria(score),
        // Only when the profile could not be read after search: it was scored on the search hit.
        enrichment: attributes.enrichment === "failed" ? "failed" : undefined,
        enrichment_error: attributes.enrichment === "failed" ? stringOf(attributes.enrichment_error) : undefined,
        contacts: arrayOf(p.contacts)
            .map(objectOf)
            .filter((c) => stringOf(c.value))
            .map((c) => compact({ type: c.type, value: c.value })),
        links: arrayOf(p.links)
            .map(objectOf)
            .filter((l) => stringOf(l.url))
            .map((l) => compact({ type: l.type, url: l.url })),
        evidence_url: evidence.map((e) => stringOf(e.url)).find((url) => url !== undefined),
        found_by: found
            ? compact({
                  task_id: found.task_id,
                  query: found.query,
                  times_found: found.times_found,
                  found_at: found.found_at,
              })
            : undefined,
    });
}

/** Warning codes this server knows; another code keeps the API's message. */
const KNOWN_WARNING_CODES: ReadonlySet<string> = new Set(["partial_enrichment"]);

/**
 * A task warning without its long message: `partial_enrichment` means `failed` of
 * `attempted` profile lookups could not be read, so those people were scored on the
 * search hit (`by_reason` says why).
 */
function compactWarning(warning: unknown): Record<string, unknown> {
    const w = objectOf(warning);
    const code = stringOf(w.code);
    return compact({
        code,
        platform: w.platform,
        attempted: numberOf(w.attempted),
        failed: numberOf(w.failed),
        by_reason: isPlainObject(w.by_reason) ? w.by_reason : undefined,
        message: code && KNOWN_WARNING_CODES.has(code) ? undefined : stringOf(w.message),
    });
}

/**
 * Task fields an agent polls on. `progress` is the worker's counters, passed through.
 * `completion_reason` appears once the task has ended, `coverage_limited` only when true.
 */
export function compactTask(task: unknown, options: { progress?: boolean } = {}): Record<string, unknown> {
    const t = objectOf(task);
    const status = typeof t.status === "string" ? t.status : undefined;
    return compact({
        task_id: t.task_id,
        platform: t.platform,
        status,
        stage: t.stage,
        done: status ? PEOPLE_ENDED_STATUSES.has(status) : undefined,
        query: t.query,
        metadata: t.metadata,
        count: t.count,
        result_count: t.result_count,
        completion_reason: stringOf(t.completion_reason),
        coverage_limited: t.coverage_limited === true ? true : undefined,
        warnings: arrayOf(t.warnings).map(compactWarning),
        progress: options.progress ? t.progress : undefined,
        errors: options.progress ? t.errors : undefined,
        reserved_cost_usd: t.reserved_cost_usd,
        final_cost_usd: t.final_cost_usd,
        refunded_usd: t.refunded_usd,
        created_at: t.created_at,
        finished_at: t.finished_at,
        results_expire_at: t.results_expire_at,
    });
}

/**
 * One sentence on what to do next, so an agent does not have to infer it from the status.
 * `nextCursor` is the results cursor when the caller just read a page of people.
 * `task` adds why a completed search ended (`completion_reason`, `coverage_limited`).
 */
export function peopleNextStep(
    status: string | undefined,
    nextCursor?: string,
    hasMore = false,
    task: { completion_reason?: unknown; coverage_limited?: unknown; count?: unknown } = {}
): string {
    const again =
        nextCursor === undefined
            ? "people-search-status again"
            : `people-search-status again with cursor "${nextCursor}"`;
    if (hasMore) {
        return `More people are ready now: call ${again}.`;
    }
    switch (status) {
        case "queued":
        case "running":
            return nextCursor === undefined
                ? `Still searching. Wait 15 to 30 seconds, then call ${again}.`
                : `Still searching. Wait 15 to 30 seconds, then call ${again} to get only the people found since this call.`;
        case "pausing":
            return "Pausing after the current batch. Resume it with people-search-resume.";
        case "paused":
            return "Paused. Resume it with people-search-resume, or cancel it with people-search-cancel.";
        case "cancelling":
            return "Cancelling. Call people-search-status again to read the final status.";
        case "completed":
            if (task.coverage_limited === true) {
                const wanted = typeof task.count === "number" ? `${task.count} people` : "the count you asked for";
                return `Finished early: a budget stopped it (${String(task.completion_reason)}) before it found ${wanted}, so more people may match. You have every person it found.`;
            }
            if (task.completion_reason === "no_candidates") {
                return "Finished: its searches found nobody to check. Try a broader description.";
            }
            if (task.completion_reason === "zero_qualified") {
                return "Finished: it checked the people its searches found and none fit. Try a broader description.";
            }
            return "Finished. You have every person this search found.";
        case "partial":
            return "Finished with partial results: some searches failed. You have every person it found.";
        case "failed":
            return "The search failed. See errors. A search that finds no one is not charged.";
        case "cancelled":
            return "Cancelled. You pay only for the people listed; the rest of the reservation is returned.";
        case "expired":
            return "Results expired 30 days after the search ended.";
        default:
            return `Call ${again} to check for changes.`;
    }
}

const POLL_HINT =
    "Searches usually take 1 to 5 minutes. Poll people-search-status with this task_id every 15 to 30 seconds; people appear while it runs.";

/** `people-search`: start a billed background search and return the task to poll. */
export async function startPeopleSearch(
    client: PeopleClient,
    args: PeopleSearchArgs
): Promise<Record<string, unknown>> {
    const body = peopleSearchBody(args);
    const { status, data } = await client.startSearch(args.platform, body, args.idempotency_key);
    const raw = objectOf(data);
    // 200 means the same Idempotency-Key already created this task; the API refunds this call.
    const existing = status === 200;
    return compact({
        ...compactTask(data),
        cost_usd: numberOf(raw.cost_usd),
        currency: stringOf(raw.currency),
        existing_task: existing ? true : undefined,
        next: existing
            ? `This idempotency_key already started this search, so it was not charged again. ${POLL_HINT}`
            : POLL_HINT,
    });
}

/** `people-search-status`: task status and progress, plus a page of people when there are any. */
export async function readPeopleStatus(
    client: PeopleClient,
    args: { task_id: string; cursor?: string; limit?: number; include_people?: boolean }
): Promise<Record<string, unknown>> {
    const task = await client.getTask(args.task_id);
    const summary = compactTask(task, { progress: true });
    const status = typeof summary.status === "string" ? summary.status : undefined;
    const includePeople = args.include_people !== false;
    if (!includePeople) {
        return { ...summary, next: peopleNextStep(status, undefined, false, summary) };
    }
    let nextCursor = args.cursor ?? "0";
    let hasMore = false;
    let people: Record<string, unknown>[] = [];
    const resultCount = numberOf(summary.result_count) ?? 0;
    // No results yet, or expired (the results route answers 410): skip the second call.
    if (resultCount > 0 && status !== "expired") {
        const page = objectOf(
            await client.getResults(args.task_id, { cursor: args.cursor, limit: args.limit })
        );
        people = arrayOf(page.results).map(compactPerson);
        nextCursor = stringOf(page.next_cursor) ?? nextCursor;
        hasMore = page.has_more === true;
    }
    return {
        ...summary,
        people,
        next_cursor: nextCursor,
        has_more: hasMore,
        next: peopleNextStep(status, nextCursor, hasMore, summary),
    };
}

/** `people-search-pause`, `people-search-resume`, `people-search-cancel`: change a task's state. */
export async function controlPeopleTask(
    client: PeopleClient,
    args: { task_id: string; action: PeopleControlAction }
): Promise<Record<string, unknown>> {
    const task = compactTask(await client.controlTask(args.task_id, args.action));
    const status = typeof task.status === "string" ? task.status : undefined;
    return { ...task, next: peopleNextStep(status, undefined, false, task) };
}

/** `people-search-tasks`: the caller's tasks, newest first. */
export async function listPeopleTasks(
    client: PeopleClient,
    args: {
        platform?: PeoplePlatform;
        status?: string[];
        limit?: number;
        cursor?: string;
        metadata?: Record<string, string>;
    }
): Promise<Record<string, unknown>> {
    const params: Record<string, QueryValue> = {
        platform: args.platform,
        status: args.status?.length ? args.status.join(",") : undefined,
        limit: args.limit,
        cursor: args.cursor,
    };
    // The API reads metadata filters as `metadata.<key>=<value>`, one parameter per pair.
    for (const [key, value] of Object.entries(args.metadata ?? {})) {
        params[`metadata.${key}`] = value;
    }
    const page = objectOf(await client.listTasks(params));
    return {
        tasks: arrayOf(page.tasks).map((task) => compactTask(task)),
        next_cursor: stringOf(page.next_cursor) ?? null,
    };
}

export interface PeopleProfilesArgs {
    platform: PeoplePlatform;
    q?: string;
    sort?: (typeof PEOPLE_PROFILE_SORTS)[number];
    limit?: number;
    cursor?: string;
    has?: string[];
    min_audience?: number;
    max_audience?: number;
    min_score?: number;
    location?: string;
    verified?: boolean;
}

/** `people-profiles`: everyone the caller's searches found on one platform. */
export async function listPeopleProfiles(
    client: PeopleClient,
    args: PeopleProfilesArgs
): Promise<Record<string, unknown>> {
    const page = objectOf(
        await client.listProfiles({
            platform: args.platform,
            q: args.q,
            sort: args.sort,
            limit: args.limit,
            cursor: args.cursor,
            has: args.has?.length ? args.has.join(",") : undefined,
            min_audience: args.min_audience,
            max_audience: args.max_audience,
            min_score: args.min_score,
            location: args.location,
            verified: args.verified,
        })
    );
    return {
        total: numberOf(page.total) ?? 0,
        next_cursor: stringOf(page.next_cursor) ?? null,
        profiles: arrayOf(page.profiles).map(compactPerson),
    };
}
