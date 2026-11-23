/**
 * "Continue with Desearch": the person signs in on the Desearch console instead
 * of pasting an API key.
 *
 *   1. POST /authorize with decision=desearch stores the authorization request,
 *      sets a cookie in this browser and sends the browser to the console.
 *   2. The console signs the person in, asks them to allow the connection,
 *      makes an API key on its server and posts it to /connect/complete. The
 *      key travels server to server and never appears in a URL.
 *   3. The browser comes back to /connect/return. Only the browser that holds
 *      the cookie from step 1 gets the authorization code, so a link to the
 *      console's page cannot hand one person's approval to another client.
 *
 * The feature is off until DESEARCH_CONNECT_SECRET is set: the authorize page
 * then shows only the API key form, as before.
 */
import {
    AUTH_CODE_PREFIX,
    CONNECT_REQUEST_PREFIX,
    challengesMatch,
    randomToken,
    sha256,
} from "./crypto.js";
import { htmlResponse, redirectBack, type DesearchSignIn } from "./flow.js";
import { grantedScope, publicOrigin } from "./metadata.js";
import { messagePage, type AuthorizePageFields } from "./page.js";
import { isLoopbackRedirect, redirectHostname } from "./redirects.js";
import { codeTtlSec, connectTtlSec, getOAuthStore } from "./store.js";

const TITLE = "Connect Desearch";
const MIN_SECRET_CHARS = 32;
const REQUEST_ID_PATTERN = new RegExp(`^${CONNECT_REQUEST_PREFIX}[A-Za-z0-9_-]{43}$`);
const API_KEY_PATTERN = /^[A-Za-z0-9_\-.]{20,200}$/;
const MAX_BODY_CHARS = 4096;

export interface ConnectConfig {
    secret: string;
    consoleOrigin: string;
}

function isLocalHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function connectConfig(): ConnectConfig | null {
    const secret = process.env.DESEARCH_CONNECT_SECRET?.trim();
    if (!secret) {
        return null;
    }
    if (secret.length < MIN_SECRET_CHARS) {
        console.error(
            `DESEARCH_CONNECT_SECRET must be at least ${MIN_SECRET_CHARS} characters. Continue with Desearch is off.`
        );
        return null;
    }
    const raw = process.env.DESEARCH_CONSOLE_URL?.trim() || "https://console.desearch.ai";
    try {
        const url = new URL(raw);
        if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost(url.hostname))) {
            throw new Error("not https");
        }
        return { secret, consoleOrigin: url.origin };
    } catch {
        console.error("DESEARCH_CONSOLE_URL must be an https URL. Continue with Desearch is off.");
        return null;
    }
}

/** What the authorize page needs to offer the console sign-in, or undefined when it is off. */
export function desearchSignIn(): DesearchSignIn | undefined {
    const config = connectConfig();
    if (!config) {
        return undefined;
    }
    return {
        consoleOrigin: config.consoleOrigin,
        start: (_request, fields) => startConnect(fields, config),
    };
}

function cookieName(requestId: string): string {
    return `__Host-dsc_${sha256(requestId).slice(0, 16)}`;
}

function cookieHeader(requestId: string, value: string, maxAgeSec: number): string {
    return `${cookieName(requestId)}=${value}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Lax`;
}

function readCookie(request: Request, name: string): string {
    const header = request.headers.get("cookie") ?? "";
    for (const part of header.split(";")) {
        const index = part.indexOf("=");
        if (index > 0 && part.slice(0, index).trim() === name) {
            return part.slice(index + 1).trim();
        }
    }
    return "";
}

function json(status: number, body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
}

function withCookie(response: Response, cookie: string): Response {
    const headers = new Headers(response.headers);
    headers.append("Set-Cookie", cookie);
    return new Response(response.body, { status: response.status, headers });
}

/** The console's server proves itself with the shared secret. Digests are compared in constant time. */
function serverAuthorized(request: Request, config: ConnectConfig): boolean {
    const header = request.headers.get("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (!presented) {
        return false;
    }
    return challengesMatch(sha256(presented), sha256(config.secret));
}

async function startConnect(fields: AuthorizePageFields, config: ConnectConfig): Promise<Response> {
    const requestId = randomToken(CONNECT_REQUEST_PREFIX, 32);
    const browserSecret = randomToken("", 32);
    const ttlSec = connectTtlSec();
    const store = await getOAuthStore();
    await store.saveConnect(requestId, {
        clientId: fields.clientId,
        clientName: fields.clientName,
        redirectUri: fields.redirectUri,
        state: fields.state,
        codeChallenge: fields.codeChallenge,
        resource: fields.resource,
        scope: grantedScope(fields.scope),
        browserHash: sha256(browserSecret),
        status: "pending",
        expiresAt: Date.now() + ttlSec * 1000,
    });
    const target = new URL("/connect", config.consoleOrigin);
    target.searchParams.set("request", requestId);
    return new Response(null, {
        status: 303,
        headers: {
            Location: target.toString(),
            "Set-Cookie": cookieHeader(requestId, browserSecret, ttlSec),
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
        },
    });
}

/** GET /connect/info?request=…: what the console shows on its "Allow" screen. Server to server. */
export async function connectInfo(request: Request): Promise<Response> {
    const config = connectConfig();
    if (!config) {
        return json(503, { error: "unavailable" });
    }
    if (!serverAuthorized(request, config)) {
        return json(401, { error: "unauthorized" });
    }
    const requestId = new URL(request.url).searchParams.get("request") ?? "";
    if (!REQUEST_ID_PATTERN.test(requestId)) {
        return json(400, { error: "invalid_request" });
    }
    const store = await getOAuthStore();
    const record = await store.getConnect(requestId);
    if (!record) {
        return json(404, { error: "not_found" });
    }
    return json(200, {
        status: record.status,
        client_name: record.clientName,
        redirect_host: redirectHostname(record.redirectUri),
        loopback: isLoopbackRedirect(record.redirectUri),
        expires_at: new Date(record.expiresAt).toISOString(),
    });
}

/**
 * POST /connect/complete: the console's decision, with the API key it made when
 * the person allowed the connection. Server to server. The key is not checked
 * against the API here: the console that made it is the caller, and a new
 * account's key would fail a balance-gated check.
 */
export async function completeConnect(request: Request): Promise<Response> {
    const config = connectConfig();
    if (!config) {
        return json(503, { error: "unavailable" });
    }
    if (!serverAuthorized(request, config)) {
        return json(401, { error: "unauthorized" });
    }
    let body: Record<string, unknown>;
    try {
        const text = await request.text();
        if (text.length > MAX_BODY_CHARS) {
            throw new Error("body too large");
        }
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("not an object");
        }
        body = parsed as Record<string, unknown>;
    } catch {
        return json(400, { error: "invalid_request" });
    }
    const requestId = typeof body.request_id === "string" ? body.request_id : "";
    const decision = body.decision;
    const apiKey = typeof body.api_key === "string" ? body.api_key.trim() : "";
    if (!REQUEST_ID_PATTERN.test(requestId) || (decision !== "allow" && decision !== "deny")) {
        return json(400, { error: "invalid_request" });
    }
    if (decision === "allow" && !API_KEY_PATTERN.test(apiKey)) {
        return json(400, { error: "invalid_request" });
    }
    const store = await getOAuthStore();
    const record = await store.getConnect(requestId);
    if (!record) {
        return json(404, { error: "not_found" });
    }
    if (record.status !== "pending" || !(await store.claimConnectDecision(requestId))) {
        return json(409, { error: "already_decided" });
    }
    if (decision === "allow") {
        await store.saveConnect(requestId, {
            ...record,
            status: "approved",
            apiKeyCiphertext: store.sealApiKey(apiKey),
        });
    } else {
        await store.saveConnect(requestId, { ...record, status: "denied" });
    }
    const returnUrl = new URL("/connect/return", publicOrigin(request));
    returnUrl.searchParams.set("request", requestId);
    return json(200, {
        status: decision === "allow" ? "approved" : "denied",
        return_url: returnUrl.toString(),
    });
}

/** GET /connect/return?request=…: the browser comes back from the console and gets its code. */
export async function returnConnect(request: Request): Promise<Response> {
    const expired = () =>
        htmlResponse(
            400,
            messagePage(TITLE, "This sign-in has expired. Go back to your app and connect Desearch again.")
        );
    const requestId = new URL(request.url).searchParams.get("request") ?? "";
    if (!REQUEST_ID_PATTERN.test(requestId)) {
        return expired();
    }
    const store = await getOAuthStore();
    const record = await store.getConnect(requestId);
    if (!record) {
        return expired();
    }
    const presented = readCookie(request, cookieName(requestId));
    if (!presented || !challengesMatch(sha256(presented), record.browserHash)) {
        return htmlResponse(
            403,
            messagePage(
                TITLE,
                "This sign-in was started in another browser. Go back to your app and connect Desearch again."
            )
        );
    }
    if (record.status === "pending") {
        return htmlResponse(
            409,
            messagePage(TITLE, "This sign-in is not finished yet. Go back to the Desearch tab and choose Allow.")
        );
    }
    const taken = await store.takeConnect(requestId);
    if (!taken) {
        return expired();
    }
    const clearCookie = cookieHeader(requestId, "", 0);
    const issuer = publicOrigin(request);
    if (taken.status !== "approved" || !taken.apiKeyCiphertext) {
        return withCookie(
            redirectBack(taken.redirectUri, issuer, {
                error: "access_denied",
                error_description: "The sign-in was cancelled.",
                state: taken.state,
            }),
            clearCookie
        );
    }
    const code = randomToken(AUTH_CODE_PREFIX, 32);
    await store.saveCode(code, {
        clientId: taken.clientId,
        redirectUri: taken.redirectUri,
        codeChallenge: taken.codeChallenge,
        resource: taken.resource,
        scope: taken.scope,
        apiKeyCiphertext: taken.apiKeyCiphertext,
        expiresAt: Date.now() + codeTtlSec() * 1000,
    });
    return withCookie(redirectBack(taken.redirectUri, issuer, { code, state: taken.state }), clearCookie);
}
