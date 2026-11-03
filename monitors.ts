import { createDesearchApi, withQuery, type DesearchApi, type QueryValue } from "./desearch-api.js";
import { PEOPLE_API_BASE_URL, arrayOf, compact, objectOf, stringOf } from "./people.js";

/**
 * Monitors on the Desearch API (`/desearch/monitors/*`, desearch-public-api docs/monitors.md).
 *
 * desearch-js 1.5 has no Monitors methods, so this module calls the routes directly through
 * `desearch-api.ts`, with the same base URL, `Authorization: <key>` header, and
 * `HTTP <status>: <detail>` error text as Company Search (companies.ts).
 *
 * A monitor reruns a search over its `sources` on a schedule (`interval`), drops everything it
 * has already seen, screens the new items (Jev: relevant, new_info, and one question per
 * criterion; `score` is the lowest, kept at `min_score`), and keeps the ones that pass. Kept
 * items are readable with the items route and are sent to the monitor's signed webhook.
 *
 * - Creating, reading, changing, and deleting monitors is free, and so are the run, item, and
 *   webhook routes.
 * - Each run is billed when it ends: its searches at their list price, Jev screening per item
 *   screened (the `/desearch/monitors` price), and the summary's LLM usage plus 50%. Its most
 *   (`max_run_cost_usd`) is held on the balance while it runs. `run_now` on create (the API
 *   default) and the trigger route each queue a billed run.
 * - `webhook_secret` is returned only by create (with a webhook), by an update that changes the
 *   webhook URL, and by rotate-secret.
 */

/** `sources` (model/monitors.py MonitorSource). */
export const MONITOR_SOURCES = ["web", "x", "reddit", "youtube", "threads"] as const;
export type MonitorSource = (typeof MONITOR_SOURCES)[number];

/** `interval` (model/monitors.py MONITOR_INTERVALS). */
export const MONITOR_INTERVALS = ["1h", "3h", "6h", "12h", "1d", "7d"] as const;
export type MonitorInterval = (typeof MONITOR_INTERVALS)[number];

/** `webhook.events` (model/monitors.py MonitorEvent). */
export const MONITOR_EVENTS = ["monitor.items.found", "monitor.run.completed", "monitor.run.failed"] as const;
export type MonitorEvent = (typeof MONITOR_EVENTS)[number];

/** `status` on a monitor, its PATCH body, and the list filter. */
export const MONITOR_STATUSES = ["active", "paused"] as const;
export type MonitorStatus = (typeof MONITOR_STATUSES)[number];

/** `options.web.count` (model/monitors.py WebOptions). */
export const MONITOR_WEB_COUNTS = [10, 15, 20] as const;

/** Request limits (model/monitors.py). */
export const MONITOR_QUERY_MIN = 3;
export const MONITOR_QUERY_MAX = 500;
export const MONITOR_NAME_MAX = 120;
export const MONITOR_CRITERIA_MAX = 5;
export const MONITOR_CRITERION_MAX = 300;
export const MONITOR_METADATA_MAX_KEYS = 20;
export const MONITOR_METADATA_KEY_MAX = 64;
export const MONITOR_METADATA_VALUE_MAX = 500;
export const MONITOR_X_COUNT_MAX = 100;

/** Settings create and update share. Per-source options are flat here and nested in the body. */
export interface MonitorSettingsArgs {
    name?: string;
    criteria?: string[];
    sources?: MonitorSource[];
    interval?: MonitorInterval;
    web_count?: number;
    x_count?: number;
    x_lang?: string;
    x_min_likes?: number;
    min_score?: number;
    summary?: boolean;
    webhook_url?: string;
    webhook_events?: MonitorEvent[];
    metadata?: Record<string, string>;
}

export interface MonitorCreateArgs extends MonitorSettingsArgs {
    query: string;
    run_now?: boolean;
}

export interface MonitorUpdateArgs extends MonitorSettingsArgs {
    monitor_id: string;
    query?: string;
    status?: MonitorStatus;
    remove_webhook?: boolean;
}

export interface MonitorEstimateArgs {
    sources?: MonitorSource[];
    web_count?: number;
    x_count?: number;
    summary?: boolean;
    interval?: MonitorInterval;
}

export interface MonitorClient {
    create(body: Record<string, unknown>): Promise<unknown>;
    estimate(body: Record<string, unknown>): Promise<unknown>;
    list(params: Record<string, QueryValue>): Promise<unknown>;
    get(monitorId: string): Promise<unknown>;
    update(monitorId: string, body: Record<string, unknown>): Promise<unknown>;
    remove(monitorId: string): Promise<unknown>;
    trigger(monitorId: string): Promise<unknown>;
    listRuns(monitorId: string, params: Record<string, QueryValue>): Promise<unknown>;
    getRun(monitorId: string, runId: string): Promise<unknown>;
    listItems(monitorId: string, params: Record<string, QueryValue>): Promise<unknown>;
    testWebhook(monitorId: string): Promise<unknown>;
    rotateSecret(monitorId: string): Promise<unknown>;
}

export function createMonitorClient(apiKey: string, baseUrl: string = PEOPLE_API_BASE_URL): MonitorClient {
    return monitorClientFor(createDesearchApi(apiKey, baseUrl));
}

/** A Monitors client on an existing API caller, so the server shares one per key. */
export function monitorClientFor(call: DesearchApi): MonitorClient {
    const base = "/desearch/monitors";
    const monitorPath = (monitorId: string, suffix = "") => `${base}/${encodeURIComponent(monitorId)}${suffix}`;
    const data = async (pending: ReturnType<DesearchApi>) => (await pending).data;

    return {
        create(body) {
            return data(call("POST", base, { body }));
        },
        estimate(body) {
            return data(call("POST", `${base}/estimate`, { body }));
        },
        list(params) {
            return data(call("GET", withQuery(base, params)));
        },
        get(monitorId) {
            return data(call("GET", monitorPath(monitorId)));
        },
        update(monitorId, body) {
            return data(call("PATCH", monitorPath(monitorId), { body }));
        },
        remove(monitorId) {
            return data(call("DELETE", monitorPath(monitorId)));
        },
        trigger(monitorId) {
            return data(call("POST", monitorPath(monitorId, "/trigger")));
        },
        listRuns(monitorId, params) {
            return data(call("GET", withQuery(monitorPath(monitorId, "/runs"), params)));
        },
        getRun(monitorId, runId) {
            return data(call("GET", monitorPath(monitorId, `/runs/${encodeURIComponent(runId)}`)));
        },
        listItems(monitorId, params) {
            return data(call("GET", withQuery(monitorPath(monitorId, "/items"), params)));
        },
        testWebhook(monitorId) {
            return data(call("POST", monitorPath(monitorId, "/webhook/test")));
        },
        rotateSecret(monitorId) {
            return data(call("POST", monitorPath(monitorId, "/webhook/rotate-secret")));
        },
    };
}

/** `options` from the flat tool arguments: `web.count`, `x.count`, `x.lang`, `x.min_likes`. */
export function monitorOptions(args: {
    web_count?: number;
    x_count?: number;
    x_lang?: string;
    x_min_likes?: number;
}): Record<string, unknown> | undefined {
    const web = compact({ count: args.web_count });
    const x = compact({ count: args.x_count, lang: args.x_lang, min_likes: args.x_min_likes });
    const options = compact({ web, x });
    return Object.keys(options).length > 0 ? options : undefined;
}

/** `webhook` from `webhook_url` and `webhook_events`. The API needs the URL in every webhook object. */
function webhookField(args: MonitorSettingsArgs): Record<string, unknown> | undefined {
    if (args.webhook_url === undefined) {
        if (args.webhook_events !== undefined) {
            throw new Error("webhook_events needs webhook_url: send the webhook's URL with its events.");
        }
        return undefined;
    }
    return compact({ url: args.webhook_url, events: args.webhook_events });
}

/** The settings fields create and update share, only when the caller set them. */
function settingsFields(args: MonitorSettingsArgs, body: Record<string, unknown>): Record<string, unknown> {
    if (args.name !== undefined) body.name = args.name;
    if (args.criteria !== undefined) body.criteria = args.criteria;
    if (args.sources !== undefined) body.sources = args.sources;
    if (args.interval !== undefined) body.interval = args.interval;
    const options = monitorOptions(args);
    if (options !== undefined) body.options = options;
    if (args.min_score !== undefined) body.min_score = args.min_score;
    if (args.summary !== undefined) body.summary = args.summary;
    const webhook = webhookField(args);
    if (webhook !== undefined) body.webhook = webhook;
    if (args.metadata !== undefined) body.metadata = args.metadata;
    return body;
}

/** Request body for `POST /desearch/monitors` (model/monitors.py MonitorCreateRequest). */
export function monitorCreateBody(args: MonitorCreateArgs): Record<string, unknown> {
    const body = settingsFields(args, { query: args.query });
    if (args.run_now !== undefined) body.run_now = args.run_now;
    return body;
}

/**
 * Request body for `PATCH /desearch/monitors/{monitor_id}` (model/monitors.py
 * MonitorUpdateRequest). `remove_webhook` sends `webhook: null`, which removes the webhook.
 */
export function monitorUpdateBody(args: MonitorUpdateArgs): Record<string, unknown> {
    if (args.remove_webhook === true && (args.webhook_url !== undefined || args.webhook_events !== undefined)) {
        throw new Error("Send either remove_webhook or webhook_url, not both.");
    }
    const body: Record<string, unknown> = {};
    if (args.query !== undefined) body.query = args.query;
    settingsFields(args, body);
    if (args.status !== undefined) body.status = args.status;
    if (args.remove_webhook === true) body.webhook = null;
    if (Object.keys(body).length === 0) {
        throw new Error("Nothing to change: send at least one setting.");
    }
    return body;
}

/** Request body for `POST /desearch/monitors/estimate` (model/monitors.py MonitorEstimateRequest). */
export function monitorEstimateBody(args: MonitorEstimateArgs): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (args.sources !== undefined) body.sources = args.sources;
    const options = monitorOptions(args);
    if (options !== undefined) body.options = options;
    if (args.summary !== undefined) body.summary = args.summary;
    if (args.interval !== undefined) body.interval = args.interval;
    return body;
}

const MAX_ITEM_TEXT_CHARS = 1000;

/**
 * One kept item as an agent needs it: where it came from, what it says (`text` cut to 1000
 * characters), who posted it, how it scored, and the source's own fields (`data`).
 */
export function compactMonitorItem(item: unknown): Record<string, unknown> {
    const i = objectOf(item);
    const text = stringOf(i.text);
    const author = objectOf(i.author);
    return compact({
        item_id: i.item_id,
        run_id: i.run_id,
        source: i.source,
        url: stringOf(i.url),
        title: stringOf(i.title),
        text: text && text.length > MAX_ITEM_TEXT_CHARS ? `${text.slice(0, MAX_ITEM_TEXT_CHARS - 3)}...` : text,
        author: compact({ name: stringOf(author.name), handle: stringOf(author.handle), url: stringOf(author.url) }),
        published_at: i.published_at,
        score: i.score,
        signals: i.signals,
        found_at: i.found_at,
        data: i.data,
    });
}

const SECRET_NOTE =
    "Store webhook_secret now: it is shown only on create, when the webhook URL changes, and by monitor-webhook-rotate-secret. Verify each delivery's Desearch-Signature header (t=<unix>,v1=<hex HMAC-SHA256 of \"<t>.<raw body>\">) with it.";

/** What to do next after a create or an update, so an agent does not have to infer it. */
export function monitorNextStep(monitor: unknown, options: { created?: boolean; runNow?: boolean } = {}): string {
    const m = objectOf(monitor);
    const notes: string[] = [];
    if (options.created) {
        notes.push(
            options.runNow === false
                ? "Created. No run is queued yet: it first runs at next_run_at, or call monitor-trigger to run it now (billed)."
                : "Created, and its first run is queued (billed when it ends, at most max_run_cost_usd). Call monitor-runs in about a minute to see it, then monitor-items for what it kept."
        );
    } else if (m.status === "paused") {
        notes.push(
            "Paused: no scheduled runs until you set status active with monitor-update (monitor-trigger still runs it once)."
        );
    } else {
        notes.push("Updated. The next scheduled run is at next_run_at.");
    }
    if (stringOf(m.webhook_secret)) {
        notes.push(SECRET_NOTE);
    }
    return notes.join(" ");
}

/** What to do next with one run, by its status. */
export function monitorRunNextStep(run: unknown): string {
    const r = objectOf(run);
    switch (r.status) {
        case "queued":
        case "running":
            return "Still running. Call monitor-run with this run_id again in 30 seconds.";
        case "completed":
            return "Done. Its kept items are on monitor-run (most relevant first) and monitor-items; cost_usd is what it was billed.";
        case "failed":
            return `The run failed (${String(r.fail_reason ?? "unknown")}). It is billed only for what it used.`;
        case "cancelled":
            return "Cancelled. Its hold was released.";
        default:
            return "Call monitor-run again to check for changes.";
    }
}

/** `monitor-create`: create a monitor; with run_now (the default) its first billed run is queued. */
export async function createMonitor(client: MonitorClient, args: MonitorCreateArgs): Promise<Record<string, unknown>> {
    const monitor = objectOf(await client.create(monitorCreateBody(args)));
    return { ...monitor, next: monitorNextStep(monitor, { created: true, runNow: args.run_now }) };
}

/** `monitor-update`: change settings, pause or resume, or remove the webhook. */
export async function updateMonitor(client: MonitorClient, args: MonitorUpdateArgs): Promise<Record<string, unknown>> {
    const body = monitorUpdateBody(args);
    const monitor = objectOf(await client.update(args.monitor_id, body));
    return { ...monitor, next: monitorNextStep(monitor) };
}

/** `monitor-list`: the caller's monitors, newest first. */
export async function listMonitors(
    client: MonitorClient,
    args: { status?: MonitorStatus[]; limit?: number; cursor?: string }
): Promise<Record<string, unknown>> {
    const page = objectOf(
        await client.list({
            status: args.status?.length ? args.status.join(",") : undefined,
            limit: args.limit,
            cursor: args.cursor,
        })
    );
    return { monitors: arrayOf(page.monitors), next_cursor: stringOf(page.next_cursor) ?? null };
}

/** `monitor-trigger`: queue one billed run now. */
export async function triggerMonitor(client: MonitorClient, args: { monitor_id: string }): Promise<Record<string, unknown>> {
    const run = objectOf(await client.trigger(args.monitor_id));
    return {
        ...run,
        next: "Run queued; it is billed when it ends (at most the monitor's max_run_cost_usd). Call monitor-run with this run_id in 30 to 60 seconds.",
    };
}

/** `monitor-runs`: a monitor's runs, newest first. */
export async function listMonitorRuns(
    client: MonitorClient,
    args: { monitor_id: string; limit?: number; cursor?: string }
): Promise<Record<string, unknown>> {
    const page = objectOf(await client.listRuns(args.monitor_id, { limit: args.limit, cursor: args.cursor }));
    return { runs: arrayOf(page.runs), next_cursor: stringOf(page.next_cursor) ?? null };
}

/** `monitor-run`: one run with the items it kept, most relevant first. */
export async function readMonitorRun(
    client: MonitorClient,
    args: { monitor_id: string; run_id: string }
): Promise<Record<string, unknown>> {
    const run = objectOf(await client.getRun(args.monitor_id, args.run_id));
    return { ...run, items: arrayOf(run.items).map(compactMonitorItem), next: monitorRunNextStep(run) };
}

/** `monitor-items`: everything a monitor kept, newest first. */
export async function listMonitorItems(
    client: MonitorClient,
    args: { monitor_id: string; source?: MonitorSource; limit?: number; cursor?: string }
): Promise<Record<string, unknown>> {
    const page = objectOf(
        await client.listItems(args.monitor_id, { source: args.source, limit: args.limit, cursor: args.cursor })
    );
    return { items: arrayOf(page.items).map(compactMonitorItem), next_cursor: stringOf(page.next_cursor) ?? null };
}

/** `monitor-webhook-rotate-secret`: a new signing secret, returned once. */
export async function rotateMonitorSecret(
    client: MonitorClient,
    args: { monitor_id: string }
): Promise<Record<string, unknown>> {
    const result = objectOf(await client.rotateSecret(args.monitor_id));
    return {
        ...result,
        next: "The old secret no longer signs deliveries. Store webhook_secret now: it is not shown again (rotate again if it is lost).",
    };
}
