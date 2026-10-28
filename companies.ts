import {
    PEOPLE_API_BASE_URL,
    PEOPLE_ENDED_STATUSES,
    PEOPLE_TASK_STATUSES,
    arrayOf,
    compact,
    createApiCall,
    numberOf,
    objectOf,
    stringOf,
    unverifiedCriteria,
    withQuery,
    type PeopleApiResponse,
    type PeopleControlAction,
    type QueryValue,
} from "./people.js";

/**
 * Company Search and Company Enrich on the Desearch API (`/desearch/companies/*`).
 *
 * desearch-js 1.5 has no Company Search methods, so this module calls the routes
 * directly with the same base URL, `Authorization: <key>` header, and
 * `HTTP <status>: <detail>` error text as People Search (people.ts).
 *
 * - `POST /desearch/companies/search` finds companies from a description and
 *   `POST /desearch/companies/enrich` reads the domains you send. Both are billed:
 *   they reserve companies at the route price and settle to what they deliver.
 * - Every other route (tasks, results, pause/resume/cancel) is free. Both kinds of task
 *   run on the People Search engine, but a People Search task_id is a 404 on these
 *   routes and a company task_id is a 404 on People Search's.
 *
 * A company is published once the stages its request needs have run
 * (`enrichment.status: "partial"`); later stages (contacts, people, email_patterns,
 * email_check) fill it in place until it is `complete`. A results cursor returns only
 * companies delivered after it; reading without a cursor returns every company in its
 * latest version.
 */

/** Statuses are People Search's (desearch-public-api model/people.py TaskStatus). */
export const COMPANY_TASK_STATUSES = PEOPLE_TASK_STATUSES;

/** `roles` (desearch-public-api model/companies.py Role). */
export const COMPANY_ROLES = [
    "ceo",
    "founder",
    "cto",
    "cfo",
    "coo",
    "cmo",
    "president",
    "owner",
    "managing_director",
] as const;
export type CompanyRole = (typeof COMPANY_ROLES)[number];

/** `filters.require` (model/companies.py Requirement). */
export const COMPANY_REQUIREMENTS = ["email", "phone", "linkedin", "leader", "leader_email"] as const;
export type CompanyRequirement = (typeof COMPANY_REQUIREMENTS)[number];

/** `type` on `GET /desearch/companies/tasks` (routers/companies.py TYPE_SERVICES). */
export const COMPANY_TASK_TYPES = ["search", "enrich"] as const;
export type CompanyTaskType = (typeof COMPANY_TASK_TYPES)[number];

/** Request limits (model/companies.py, model/people.py). */
export const COMPANY_DOMAINS_MAX = 200;
export const COMPANY_COUNTRIES_MAX = 20;
export const COMPANY_EXCLUDE_MAX = 1000;

interface CompanyTaskOptions {
    roles?: CompanyRole[];
    infer_emails?: boolean;
    verify_emails?: boolean;
    metadata?: Record<string, string>;
    idempotency_key?: string;
}

export interface CompanySearchArgs extends CompanyTaskOptions {
    query: string;
    count?: number;
    min_score?: number;
    exclude?: string[];
    countries?: string[];
    require?: CompanyRequirement[];
}

export interface CompanyEnrichArgs extends CompanyTaskOptions {
    domains: string[];
}

export interface CompanyClient {
    startSearch(body: Record<string, unknown>, idempotencyKey?: string): Promise<PeopleApiResponse>;
    startEnrich(body: Record<string, unknown>, idempotencyKey?: string): Promise<PeopleApiResponse>;
    getTask(taskId: string): Promise<unknown>;
    getResults(taskId: string, params: { cursor?: string; limit?: number }): Promise<unknown>;
    controlTask(taskId: string, action: PeopleControlAction): Promise<unknown>;
    listTasks(params: Record<string, QueryValue>): Promise<unknown>;
}

export function createCompanyClient(apiKey: string, baseUrl: string = PEOPLE_API_BASE_URL): CompanyClient {
    const call = createApiCall(apiKey, baseUrl);
    const taskPath = (taskId: string) => `/desearch/companies/tasks/${encodeURIComponent(taskId)}`;
    const start = (path: string, body: Record<string, unknown>, idempotencyKey?: string) =>
        call("POST", path, {
            body,
            headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
        });

    return {
        startSearch(body, idempotencyKey) {
            return start("/desearch/companies/search", body, idempotencyKey);
        },
        startEnrich(body, idempotencyKey) {
            return start("/desearch/companies/enrich", body, idempotencyKey);
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
            return (await call("GET", withQuery("/desearch/companies/tasks", params))).data;
        },
    };
}

/** `roles`, `infer_emails`, and `verify_emails`, only when the caller set them. */
function leaderFields(args: CompanyTaskOptions, body: Record<string, unknown>): void {
    if (args.roles !== undefined) body.roles = args.roles;
    if (args.infer_emails !== undefined) body.infer_emails = args.infer_emails;
    if (args.verify_emails !== undefined) body.verify_emails = args.verify_emails;
}

/** `metadata`, left out when empty. */
function metadataField(args: CompanyTaskOptions, body: Record<string, unknown>): Record<string, unknown> {
    if (args.metadata !== undefined && Object.keys(args.metadata).length > 0) body.metadata = args.metadata;
    return body;
}

/**
 * Request body for `POST /desearch/companies/search` (model/companies.py CompanySearchRequest).
 * The tool takes `countries` and `require` as top-level arguments; they go in `filters`.
 */
export function companySearchBody(args: CompanySearchArgs): Record<string, unknown> {
    const body: Record<string, unknown> = { query: args.query };
    if (args.count !== undefined) body.count = args.count;
    if (args.min_score !== undefined) body.min_score = args.min_score;
    if (args.exclude !== undefined) body.exclude = args.exclude;
    leaderFields(args, body);
    const filters: Record<string, unknown> = {};
    if (args.countries !== undefined) filters.countries = args.countries;
    if (args.require !== undefined) filters.require = args.require;
    if (Object.keys(filters).length > 0) body.filters = filters;
    return metadataField(args, body);
}

/** Request body for `POST /desearch/companies/enrich` (model/companies.py CompanyEnrichRequest). */
export function companyEnrichBody(args: CompanyEnrichArgs): Record<string, unknown> {
    const body: Record<string, unknown> = { domains: args.domains };
    leaderFields(args, body);
    return metadataField(args, body);
}

const MAX_DESCRIPTION_CHARS = 300;
const MAX_REASONS = 3;

function truncated(value: unknown, max: number): string | undefined {
    const text = stringOf(value);
    return text && text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function strings(value: unknown): string[] {
    return arrayOf(value).filter((item): item is string => typeof item === "string" && item !== "");
}

/**
 * One email: the address, what kind it is, where it came from (`source`, `source_url`),
 * the inference details (`confidence`, `pattern`) and `verification` (the check's status:
 * valid, invalid, risky, or unknown; left out until the email checks ran).
 */
function compactEmail(value: unknown, withPerson = true): Record<string, unknown> {
    const e = objectOf(value);
    return compact({
        value: stringOf(e.value),
        type: e.type,
        source: e.source,
        source_url: stringOf(e.source_url),
        person: withPerson ? stringOf(e.person) : undefined,
        confidence: e.confidence,
        pattern: stringOf(e.pattern),
        verification: stringOf(objectOf(e.verification).status),
    });
}

function compactEmails(value: unknown, withPerson = true): Record<string, unknown>[] {
    return arrayOf(value)
        .map((email) => compactEmail(email, withPerson))
        .filter((email) => email.value !== undefined);
}

function compactPhones(value: unknown): Record<string, unknown>[] {
    return arrayOf(value)
        .map(objectOf)
        .filter((phone) => stringOf(phone.value))
        .map((phone) => compact({ value: phone.value, type: phone.type, source_url: stringOf(phone.source_url) }));
}

function compactSocials(value: unknown): Record<string, unknown>[] {
    return arrayOf(value)
        .map(objectOf)
        .filter((social) => stringOf(social.url))
        .map((social) => compact({ type: social.type, url: social.url, source_url: stringOf(social.source_url) }));
}

/** One leader: who, which of the request's roles, where the role is shown, and how to reach them. */
function compactLeader(value: unknown): Record<string, unknown> {
    const p = objectOf(value);
    return compact({
        name: stringOf(p.name),
        title: stringOf(p.title),
        roles: strings(p.roles),
        verified: typeof p.verified === "boolean" ? p.verified : undefined,
        linkedin_url: stringOf(p.linkedin_url),
        x_url: stringOf(p.x_url),
        github_url: stringOf(p.github_url),
        emails: compactEmails(p.emails, false),
        phones: compactPhones(p.phones),
        evidence_url: stringOf(objectOf(p.evidence).source_url),
    });
}

function compactEnrichment(value: unknown): Record<string, unknown> {
    const e = objectOf(value);
    const stages = objectOf(e.stages);
    return compact({
        status: stringOf(e.status),
        stages: compact(stages),
        errors: arrayOf(e.errors)
            .map(objectOf)
            .map((error) => compact({ stage: stringOf(error.stage), message: stringOf(error.message) }))
            .filter((error) => Object.keys(error).length > 0),
    });
}

/**
 * One company as an agent needs it: what it is, how well it fits (Company Search; `score`
 * is null for Company Enrich), how to reach it and its leaders, with the page each contact
 * came from, and how far its enrichment has got.
 */
export function compactCompany(company: unknown): Record<string, unknown> {
    const c = objectOf(company);
    const location = objectOf(c.location);
    const score = objectOf(c.score);
    const contact = objectOf(c.primary_contact);
    const primaryEmail = compactEmail(c.primary_email);
    return {
        ...compact({
            domain: stringOf(c.domain) ?? stringOf(c.handle),
            name: stringOf(c.name),
            url: stringOf(c.url),
            industry: stringOf(c.industry),
            location: compact({
                country: stringOf(location.country),
                city: stringOf(location.city),
                address: stringOf(location.address),
            }),
            description: truncated(c.description, MAX_DESCRIPTION_CHARS),
        }),
        // Always present: a number for Company Search, null for Company Enrich (no fit score).
        score: numberOf(score.value) ?? null,
        ...compact({
            why: stringOf(score.summary),
            reasons: strings(score.reasons).slice(0, MAX_REASONS),
            fully_verified: typeof score.fully_verified === "boolean" ? score.fully_verified : undefined,
            unverified_criteria: unverifiedCriteria(score),
            primary_email: primaryEmail.value !== undefined ? primaryEmail : undefined,
            primary_contact: compact({
                name: stringOf(contact.name),
                title: stringOf(contact.title),
                email: stringOf(contact.email),
                linkedin_url: stringOf(contact.linkedin_url),
                reason: stringOf(contact.reason),
            }),
            contact_coverage: compact(objectOf(c.contact_coverage)),
            emails: compactEmails(c.emails),
            phones: compactPhones(c.phones),
            socials: compactSocials(c.socials),
            leaders: arrayOf(c.people)
                .map(compactLeader)
                .filter((leader) => leader.name !== undefined),
            enrichment: compactEnrichment(c.enrichment),
        }),
    };
}

/** Company task warnings are short (`code`, `message`), so both are kept. */
function compactWarning(warning: unknown): Record<string, unknown> {
    const w = objectOf(warning);
    return compact({ code: stringOf(w.code), message: stringOf(w.message) });
}

/**
 * Task fields an agent polls on. `progress` is the worker's counters, passed through
 * without its copy of `warnings` (listed once, at the top). `completion_reason` appears
 * once the task has ended, `coverage_limited` only when true.
 */
export function compactCompanyTask(task: unknown, options: { progress?: boolean } = {}): Record<string, unknown> {
    const t = objectOf(task);
    const status = typeof t.status === "string" ? t.status : undefined;
    let progress: Record<string, unknown> | undefined;
    if (options.progress) {
        const { warnings: _warnings, ...rest } = objectOf(t.progress);
        progress = rest;
    }
    return compact({
        task_id: t.task_id,
        search_type: t.search_type,
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
        progress,
        errors: options.progress ? t.errors : undefined,
        reserved_cost_usd: t.reserved_cost_usd,
        final_cost_usd: t.final_cost_usd,
        refunded_usd: t.refunded_usd,
        created_at: t.created_at,
        finished_at: t.finished_at,
        results_expire_at: t.results_expire_at,
    });
}

const LATEST = "call company-search-status without cursor to read every company in its latest version";

/**
 * One sentence (or two) on what to do next, so an agent does not have to infer it from the status.
 * `nextCursor` is the results cursor when the caller just read a page of companies.
 * `task` adds the stage (`enriching`) and why an ended task stopped.
 * `page.partial` counts the companies on this page whose enrichment is still `partial`;
 * `page.readAfterStart` is true when the caller passed a cursor, so it may hold older
 * versions of companies it read before.
 */
export function companyNextStep(
    status: string | undefined,
    nextCursor?: string,
    hasMore = false,
    task: { stage?: unknown; completion_reason?: unknown; coverage_limited?: unknown; count?: unknown } = {},
    page: { partial?: number; readAfterStart?: boolean } = {}
): string {
    const again =
        nextCursor === undefined
            ? "company-search-status again"
            : `company-search-status again with cursor "${nextCursor}"`;
    const partial = page.partial ?? 0;
    if (hasMore) {
        return `More companies are ready now: call ${again}.`;
    }
    const ended = (first: string): string => {
        const notes = [first];
        if (partial > 0) {
            notes.push(
                `${partial === 1 ? "1 company" : `${partial} companies`} on this page stayed partial: the task ended before every stage ran for ${partial === 1 ? "it" : "them"}.`
            );
        }
        if (page.readAfterStart) {
            notes.push(
                "If you read companies while it ran, call company-search-status without cursor to read every company in its final version."
            );
        }
        return notes.join(" ");
    };
    switch (status) {
        case "queued":
        case "running": {
            if (task.stage === "enriching") {
                return `Every company is delivered; later stages (leaders, inferred emails, email checks) are still filling some in. Wait 15 to 30 seconds, then ${LATEST}.`;
            }
            const wait =
                nextCursor === undefined
                    ? `Still running. Wait 15 to 30 seconds, then call ${again}.`
                    : `Still running. Wait 15 to 30 seconds, then call ${again} to get only the companies delivered since this call.`;
            return partial > 0 || page.readAfterStart
                ? `${wait} Companies with enrichment status "partial" are still being filled in; when the task is done, ${LATEST}.`
                : wait;
        }
        case "pausing":
            return "Pausing after the current batch. Resume it with company-search-resume.";
        case "paused":
            return "Paused. Resume it with company-search-resume, or cancel it with company-search-cancel.";
        case "cancelling":
            return "Cancelling. Call company-search-status again to read the final status.";
        case "completed":
            if (task.coverage_limited === true) {
                const wanted = typeof task.count === "number" ? `${task.count} companies` : "the count you asked for";
                return ended(
                    `Finished early: a budget stopped it (${String(task.completion_reason)}) before it delivered ${wanted}, so more companies may match. You have every company it delivered.`
                );
            }
            if (task.completion_reason === "no_candidates") {
                return "Finished: its searches found no company to check. Try a broader description.";
            }
            if (task.completion_reason === "zero_qualified") {
                return "Finished: it checked the companies its searches found and none fit. Try a broader description, a lower min_score, or fewer require values.";
            }
            if (task.completion_reason === "all_domains_processed") {
                return ended("Finished: it read every domain. You have every company it delivered.");
            }
            return ended("Finished. You have every company this task delivered.");
        case "partial":
            return ended("Finished with partial results: some searches failed. You have every company it delivered.");
        case "failed":
            return "The task failed. See errors. A task that delivers no companies is not charged.";
        case "cancelled":
            return ended("Cancelled. You pay only for the companies it delivered; the rest of the reservation is returned.");
        case "expired":
            return "Results expired 30 days after the task ended.";
        default:
            return `Call ${again} to check for changes.`;
    }
}

const POLL_HINT =
    "The task runs in the background. Poll company-search-status with this task_id every 15 to 30 seconds: companies appear while it runs, and later stages fill them in.";

async function startCompanyTask(
    start: (body: Record<string, unknown>, idempotencyKey?: string) => Promise<PeopleApiResponse>,
    body: Record<string, unknown>,
    idempotencyKey: string | undefined
): Promise<Record<string, unknown>> {
    const { status, data } = await start(body, idempotencyKey);
    const raw = objectOf(data);
    // 200 means the same Idempotency-Key already created this task; the API does not charge again.
    const existing = status === 200;
    return compact({
        ...compactCompanyTask(data),
        cost_usd: numberOf(raw.cost_usd),
        currency: stringOf(raw.currency),
        existing_task: existing ? true : undefined,
        next: existing
            ? `This idempotency_key already started this task, so it was not charged again. ${POLL_HINT}`
            : POLL_HINT,
    });
}

/** `company-search`: start a billed background Company Search and return the task to poll. */
export async function startCompanySearch(
    client: CompanyClient,
    args: CompanySearchArgs
): Promise<Record<string, unknown>> {
    return startCompanyTask(
        (body, key) => client.startSearch(body, key),
        companySearchBody(args),
        args.idempotency_key
    );
}

/** `company-enrich`: start a billed background Company Enrich and return the task to poll. */
export async function startCompanyEnrich(
    client: CompanyClient,
    args: CompanyEnrichArgs
): Promise<Record<string, unknown>> {
    return startCompanyTask(
        (body, key) => client.startEnrich(body, key),
        companyEnrichBody(args),
        args.idempotency_key
    );
}

/** `company-search-status`: task status and progress, plus a page of companies when there are any. */
export async function readCompanyStatus(
    client: CompanyClient,
    args: { task_id: string; cursor?: string; limit?: number; include_companies?: boolean }
): Promise<Record<string, unknown>> {
    const task = await client.getTask(args.task_id);
    const summary = compactCompanyTask(task, { progress: true });
    const status = typeof summary.status === "string" ? summary.status : undefined;
    if (args.include_companies === false) {
        return { ...summary, next: companyNextStep(status, undefined, false, summary) };
    }
    let nextCursor = args.cursor ?? "0";
    let hasMore = false;
    let partial = 0;
    let companies: Record<string, unknown>[] = [];
    const resultCount = numberOf(summary.result_count) ?? 0;
    // No results yet, or expired (the results route answers 410): skip the second call.
    if (resultCount > 0 && status !== "expired") {
        const page = objectOf(
            await client.getResults(args.task_id, { cursor: args.cursor, limit: args.limit })
        );
        const rows = arrayOf(page.results);
        companies = rows.map(compactCompany);
        partial = rows.filter((row) => objectOf(objectOf(row).enrichment).status === "partial").length;
        nextCursor = stringOf(page.next_cursor) ?? nextCursor;
        hasMore = page.has_more === true;
    }
    const readAfterStart = args.cursor !== undefined && args.cursor !== "0";
    return {
        ...summary,
        companies,
        next_cursor: nextCursor,
        has_more: hasMore,
        next: companyNextStep(status, nextCursor, hasMore, summary, { partial, readAfterStart }),
    };
}

/** `company-search-pause`, `company-search-resume`, `company-search-cancel`: change a task's state. */
export async function controlCompanyTask(
    client: CompanyClient,
    args: { task_id: string; action: PeopleControlAction }
): Promise<Record<string, unknown>> {
    const task = compactCompanyTask(await client.controlTask(args.task_id, args.action));
    const status = typeof task.status === "string" ? task.status : undefined;
    return { ...task, next: companyNextStep(status, undefined, false, task) };
}

/** `company-search-tasks`: the caller's Company Search and Company Enrich tasks, newest first. */
export async function listCompanyTasks(
    client: CompanyClient,
    args: {
        type?: CompanyTaskType;
        status?: string[];
        limit?: number;
        cursor?: string;
        metadata?: Record<string, string>;
    }
): Promise<Record<string, unknown>> {
    const params: Record<string, QueryValue> = {
        type: args.type,
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
        tasks: arrayOf(page.tasks).map((task) => compactCompanyTask(task)),
        next_cursor: stringOf(page.next_cursor) ?? null,
    };
}
