/**
 * One structured log line when dynamic client registration rejects a callback.
 * It lets us learn the exact callback a new directory sends (origin and path only)
 * so the allow-list can name it exactly. No query, fragment, user info, token or
 * other body field is ever logged.
 */

const MAX_URI_CHARS = 200;
const MAX_NAME_CHARS = 80;
const MAX_ENTRIES = 10;

function stripControl(value: string): string {
    return value.replace(/[\u0000-\u001f\u007f]/g, "");
}

/** Origin and path of a redirect URI, without query, fragment or user info. */
export function redirectForLog(value: unknown): string {
    if (typeof value !== "string") {
        return "<not a string>";
    }
    try {
        const url = new URL(value);
        if (url.protocol === "http:" || url.protocol === "https:") {
            return stripControl(`${url.origin}${url.pathname}`).slice(0, MAX_URI_CHARS);
        }
        return stripControl(`${url.protocol}${url.pathname}`).split(/[?#]/)[0].slice(0, MAX_URI_CHARS);
    } catch {
        const head = value.split(/[?#]/)[0].replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/]*@/, "$1");
        return stripControl(head).slice(0, MAX_URI_CHARS) || "<unparsable>";
    }
}

/** First product token of a User-Agent, e.g. "node", "python-httpx", "Mozilla". */
export function userAgentFamily(value: string | null): string {
    if (!value) {
        return "none";
    }
    const token = value.trim().split(/[\s/;(]/)[0] ?? "";
    const cleaned = token.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40);
    return cleaned || "other";
}

export interface RejectedRedirectLog {
    event: "dcr_redirect_rejected";
    rejected: string[];
    client_name: string;
    ua_family: string;
}

export function rejectedRedirectLog(
    rejected: unknown[],
    clientName: unknown,
    userAgent: string | null
): RejectedRedirectLog {
    return {
        event: "dcr_redirect_rejected",
        rejected: rejected.slice(0, MAX_ENTRIES).map(redirectForLog),
        client_name:
            typeof clientName === "string" ? stripControl(clientName).trim().slice(0, MAX_NAME_CHARS) : "",
        ua_family: userAgentFamily(userAgent),
    };
}

export function logRejectedRedirects(request: Request, rejected: unknown[], clientName: unknown): void {
    console.warn(JSON.stringify(rejectedRedirectLog(rejected, clientName, request.headers.get("user-agent"))));
}
