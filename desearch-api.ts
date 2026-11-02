import { fetch } from "undici";

/**
 * Direct calls to the Desearch API for routes desearch-js 1.5 does not cover
 * (People Search, the TikTok, Facebook and Instagram routes, `POST /search`).
 *
 * Same base URL, `Authorization: <key>` header, and `HTTP <status>: <detail>`
 * error text that desearch-js uses, so every tool reports API errors the same way.
 */

export const DESEARCH_API_BASE_URL = "https://api.desearch.ai";

export type QueryValue = string | number | boolean | undefined;

export interface ApiResponse {
    status: number;
    /** Parsed JSON body, or the body text when it is not JSON. */
    data: unknown;
    /** The body exactly as sent, for CSV and JSON Lines downloads. */
    text: string;
    headers: { get(name: string): string | null };
}

export interface ApiRequestOptions {
    query?: Record<string, QueryValue>;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
}

export type DesearchApi = (
    method: "GET" | "POST",
    path: string,
    options?: ApiRequestOptions
) => Promise<ApiResponse>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The API's `detail` (plus the task status People Search adds on a 409), or the start of the body. */
export function errorDetail(data: unknown, text: string): string {
    if (isPlainObject(data) && data.detail !== undefined) {
        const detail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
        const task = isPlainObject(data.task) ? data.task : undefined;
        return typeof task?.status === "string" ? `${detail} Task status: ${task.status}.` : detail;
    }
    return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

/** `path?key=value`, leaving out undefined values. */
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

export function createDesearchApi(apiKey: string, baseUrl: string = DESEARCH_API_BASE_URL): DesearchApi {
    return async (method, path, options = {}) => {
        const headers: Record<string, string> = { Authorization: apiKey, ...options.headers };
        if (options.body) {
            headers["Content-Type"] = "application/json";
        }
        const url = `${baseUrl}${options.query ? withQuery(path, options.query) : path}`;
        let response;
        let text;
        try {
            response = await fetch(url, {
                method,
                headers,
                body: options.body ? JSON.stringify(options.body) : undefined,
            });
            text = await response.text();
        } catch (error) {
            throw new Error(`Unexpected Error: ${error instanceof Error ? error.message : String(error)}`);
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
        return { status: response.status, data, text, headers: response.headers };
    };
}
