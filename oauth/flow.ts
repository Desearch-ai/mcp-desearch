import {
    ACCESS_TOKEN_PREFIX,
    AUTH_CODE_PREFIX,
    CLIENT_ID_PREFIX,
    REFRESH_TOKEN_PREFIX,
    challengesMatch,
    randomToken,
    s256Challenge,
} from "./crypto.js";
import {
    canonicalResource,
    grantedScope,
    publicOrigin,
    resourcesMatch,
} from "./metadata.js";
import { authorizePage, messagePage, type AuthorizePageFields } from "./page.js";
import { authorizeKeyRateLimitConfig, registerRateLimitConfig, takeIpRateLimit } from "./rate-limit.js";
import { isAllowedRedirectUri, redirectsMatch } from "./redirects.js";
import {
    accessTtlSec,
    codeTtlSec,
    getOAuthStore,
    refreshTtlSec,
    type ClientRecord,
} from "./store.js";
import { checkDesearchApiKey } from "./validate-key.js";

const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
const HTML_HEADERS = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
};

const EXTRA_FORM_ACTION_ORIGINS: Readonly<Record<string, readonly string[]>> = {
    "https://chatgpt.com": ["https://platform.openai.com"],
};

/**
 * Chrome checks form-action on every redirect after a form POST, so allow the
 * validated callback origin and ChatGPT's extra hop to the OpenAI platform portal.
 */
function contentSecurityPolicy(redirectUri?: string): string {
    const targets = ["'self'"];
    if (redirectUri && isAllowedRedirectUri(redirectUri)) {
        try {
            const origin = new URL(redirectUri).origin;
            if (/^https?:\/\/[A-Za-z0-9.\[\]:-]+$/.test(origin)) {
                targets.push(origin);
                targets.push(...(EXTRA_FORM_ACTION_ORIGINS[origin] ?? []));
            }
        } catch {
            // The redirect was already rejected before a page is rendered.
        }
    }
    return `default-src 'none'; style-src 'unsafe-inline'; form-action ${targets.join(" ")}; base-uri 'none'; frame-ancestors 'none'`;
}

export function htmlResponse(status: number, html: string, redirectUri?: string): Response {
    return new Response(html, {
        status,
        headers: {
            ...HTML_HEADERS,
            "Content-Security-Policy": contentSecurityPolicy(redirectUri),
        },
    });
}

export function oauthError(status: number, error: string, description: string): Response {
    return new Response(JSON.stringify({ error, error_description: description }), {
        status,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
        },
    });
}

function withRetryAfter(response: Response, retryAfterSec: number): Response {
    const headers = new Headers(response.headers);
    headers.set("Retry-After", String(retryAfterSec));
    return new Response(response.body, { status: response.status, headers });
}

function tooManyJson(retryAfterSec: number, description: string): Response {
    return withRetryAfter(
        oauthError(429, "temporarily_unavailable", description),
        retryAfterSec
    );
}

function redirectBack(redirectUri: string, issuer: string, params: Record<string, string>): Response {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) {
        if (value) {
            url.searchParams.set(key, value);
        }
    }
    url.searchParams.set("iss", issuer);
    return new Response(null, {
        status: 302,
        headers: {
            Location: url.toString(),
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
        },
    });
}

async function readJsonBody(request: Request): Promise<unknown> {
    const text = await request.text();
    if (text.length > 32_000) {
        throw new Error("body too large");
    }
    return JSON.parse(text);
}

async function readFormBody(request: Request): Promise<URLSearchParams> {
    const text = await request.text();
    if (text.length > 32_000) {
        throw new Error("body too large");
    }
    return new URLSearchParams(text);
}

function clientName(value: unknown): string {
    if (typeof value !== "string") {
        return "MCP client";
    }
    const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
    return cleaned || "MCP client";
}

export async function registerClient(request: Request): Promise<Response> {
    const registerLimit = registerRateLimitConfig();
    const registration = await takeIpRateLimit(
        request,
        "register",
        registerLimit.limit,
        registerLimit.windowSec
    );
    if (!registration.allowed) {
        return tooManyJson(
            registration.retryAfterSec,
            "Too many registration attempts from this address. Try again later."
        );
    }
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
        return oauthError(400, "invalid_client_metadata", "Dynamic client registration requires application/json.");
    }
    let body: unknown;
    try {
        body = await readJsonBody(request);
    } catch {
        return oauthError(400, "invalid_client_metadata", "Registration body must be JSON.");
    }
    if (!body || typeof body !== "object") {
        return oauthError(400, "invalid_client_metadata", "Registration body must be a JSON object.");
    }
    const record = body as Record<string, unknown>;
    const redirects = record.redirect_uris;
    if (!Array.isArray(redirects) || redirects.length === 0 || redirects.length > 10) {
        return oauthError(400, "invalid_redirect_uri", "redirect_uris must list 1 to 10 callback URLs.");
    }
    const redirectUris: string[] = [];
    for (const entry of redirects) {
        if (typeof entry !== "string" || !isAllowedRedirectUri(entry)) {
            return oauthError(400, "invalid_redirect_uri", "One or more redirect_uris are not allowed.");
        }
        redirectUris.push(entry);
    }
    if (record.token_endpoint_auth_method && record.token_endpoint_auth_method !== "none") {
        return oauthError(
            400,
            "invalid_client_metadata",
            "This server registers public clients. Use token_endpoint_auth_method none."
        );
    }
    const responseTypes = record.response_types;
    if (responseTypes !== undefined) {
        if (!Array.isArray(responseTypes) || responseTypes.some((entry) => entry !== "code")) {
            return oauthError(400, "invalid_client_metadata", "Only response type code is supported.");
        }
    }
    const grantTypes = record.grant_types;
    if (grantTypes !== undefined) {
        if (!Array.isArray(grantTypes) || grantTypes.some((entry) => entry !== "authorization_code" && entry !== "refresh_token")) {
            return oauthError(400, "invalid_client_metadata", "Only authorization_code and refresh_token grants are supported.");
        }
    }

    const client: ClientRecord = {
        clientId: randomToken(CLIENT_ID_PREFIX, 24),
        clientName: clientName(record.client_name),
        redirectUris,
        tokenEndpointAuthMethod: "none",
        createdAt: Date.now(),
    };
    const store = await getOAuthStore();
    await store.saveClient(client);
    return new Response(
        JSON.stringify({
            client_id: client.clientId,
            client_name: client.clientName,
            redirect_uris: client.redirectUris,
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
        }),
        {
            status: 201,
            headers: {
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
            },
        }
    );
}

interface AuthorizeQuery {
    clientId: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    resource: string;
    scope: string;
    responseType: string;
}

function readAuthorizeQuery(params: URLSearchParams): AuthorizeQuery {
    return {
        clientId: params.get("client_id") ?? "",
        redirectUri: params.get("redirect_uri") ?? "",
        state: params.get("state") ?? "",
        codeChallenge: params.get("code_challenge") ?? "",
        codeChallengeMethod: params.get("code_challenge_method") ?? "",
        resource: params.get("resource") ?? "",
        scope: params.get("scope") ?? "",
        responseType: params.get("response_type") ?? "",
    };
}

async function authorizeContext(
    request: Request,
    query: AuthorizeQuery
): Promise<{ client: ClientRecord; fields: AuthorizePageFields } | Response> {
    if (!query.clientId || !query.redirectUri) {
        return htmlResponse(400, messagePage("Connect Desearch", "This sign-in link is missing a client or callback."));
    }
    if (!isAllowedRedirectUri(query.redirectUri)) {
        return htmlResponse(400, messagePage("Connect Desearch", "This callback URL is not allowed."));
    }
    const store = await getOAuthStore();
    const client = await store.getClient(query.clientId);
    if (!client || !client.redirectUris.some((uri) => redirectsMatch(uri, query.redirectUri))) {
        return htmlResponse(400, messagePage("Connect Desearch", "This application is not registered for that callback."));
    }
    const fields: AuthorizePageFields = {
        clientId: query.clientId,
        redirectUri: query.redirectUri,
        state: query.state,
        codeChallenge: query.codeChallenge,
        codeChallengeMethod: query.codeChallengeMethod,
        resource: query.resource,
        scope: query.scope,
        clientName: client.clientName,
    };
    if (query.responseType !== "code") {
        return failAuthorize(request, client, fields, "unsupported_response_type", "Only authorization code is supported.");
    }
    if (!query.state || query.state.length > 512) {
        return failAuthorize(request, client, fields, "invalid_request", "A state value is required.");
    }
    if (query.codeChallengeMethod !== "S256" || !VERIFIER_PATTERN.test(query.codeChallenge)) {
        return failAuthorize(request, client, fields, "invalid_request", "PKCE S256 is required.");
    }
    const resource = query.resource || canonicalResource(request);
    if (!resourcesMatch(resource, canonicalResource(request))) {
        return failAuthorize(request, client, fields, "invalid_target", "The requested resource does not match this server.");
    }
    fields.resource = canonicalResource(request);
    return { client, fields };
}

function failAuthorize(
    request: Request,
    client: ClientRecord,
    fields: AuthorizePageFields,
    error: string,
    description: string
): Response {
    if (
        client.redirectUris.some((uri) => redirectsMatch(uri, fields.redirectUri)) &&
        isAllowedRedirectUri(fields.redirectUri)
    ) {
        return redirectBack(fields.redirectUri, publicOrigin(request), {
            error,
            error_description: description,
            state: fields.state,
        });
    }
    return htmlResponse(400, messagePage("Connect Desearch", description));
}

export async function showAuthorize(request: Request): Promise<Response> {
    const query = readAuthorizeQuery(new URL(request.url).searchParams);
    const context = await authorizeContext(request, query);
    if (context instanceof Response) {
        return context;
    }
    return htmlResponse(200, authorizePage(context.fields), context.fields.redirectUri);
}

function authorizePostForbidden(request: Request): Response | null {
    const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase() ?? "";
    if (fetchSite === "cross-site" || fetchSite === "same-site") {
        return htmlResponse(400, messagePage("Connect Desearch", "This sign-in form was sent from another site."));
    }
    const expected = publicOrigin(request);
    const origin = request.headers.get("origin")?.trim() ?? "";
    // `no-referrer` made browsers send the literal Origin "null". Treat that
    // as a missing origin. A same-origin Sec-Fetch-Site is enough on its own.
    const originMissing = origin.length === 0 || origin.toLowerCase() === "null";
    if (!originMissing) {
        if (origin.replace(/\/+$/, "") !== expected) {
            return htmlResponse(400, messagePage("Connect Desearch", "This sign-in form was sent from another site."));
        }
        return null;
    }
    const referer = request.headers.get("referer")?.trim() ?? "";
    if (referer) {
        try {
            if (new URL(referer).origin !== expected) {
                return htmlResponse(400, messagePage("Connect Desearch", "This sign-in form was sent from another site."));
            }
        } catch {
            return htmlResponse(400, messagePage("Connect Desearch", "This sign-in form was sent from another site."));
        }
        return null;
    }
    if (fetchSite === "same-origin") {
        return null;
    }
    return htmlResponse(403, messagePage("Connect Desearch", "This sign-in form did not come from this site."));
}

export async function submitAuthorize(request: Request): Promise<Response> {
    const forbidden = authorizePostForbidden(request);
    if (forbidden) {
        return forbidden;
    }
    let form: URLSearchParams;
    try {
        form = await readFormBody(request);
    } catch {
        return htmlResponse(400, messagePage("Connect Desearch", "The sign-in form could not be read."));
    }
    const query = readAuthorizeQuery(form);
    const context = await authorizeContext(request, query);
    if (context instanceof Response) {
        return context;
    }
    const { fields } = context;
    if (form.get("decision") === "deny") {
        return redirectBack(fields.redirectUri, publicOrigin(request), {
            error: "access_denied",
            error_description: "The sign-in was cancelled.",
            state: fields.state,
        });
    }
    const keyLimit = authorizeKeyRateLimitConfig();
    const keyAttempts = await takeIpRateLimit(request, "authorize-key", keyLimit.limit, keyLimit.windowSec);
    if (!keyAttempts.allowed) {
        return withRetryAfter(
            htmlResponse(
                429,
                messagePage(
                    "Connect Desearch",
                    "Too many sign-in attempts from this address. Try again in a moment."
                )
            ),
            keyAttempts.retryAfterSec
        );
    }
    const apiKey = (form.get("api_key") ?? "").trim();
    const checked = await checkDesearchApiKey(apiKey);
    if (!checked.ok) {
        return htmlResponse(400, authorizePage({ ...fields, error: checked.message }), fields.redirectUri);
    }
    const code = randomToken(AUTH_CODE_PREFIX, 32);
    const store = await getOAuthStore();
    await store.saveCode(code, {
        clientId: fields.clientId,
        redirectUri: fields.redirectUri,
        codeChallenge: fields.codeChallenge,
        resource: fields.resource,
        scope: grantedScope(fields.scope),
        apiKeyCiphertext: store.sealApiKey(apiKey),
        expiresAt: Date.now() + codeTtlSec() * 1000,
    });
    return redirectBack(fields.redirectUri, publicOrigin(request), {
        code,
        state: fields.state,
    });
}

function tokenResponse(accessToken: string, refreshToken: string, scope: string, expiresIn: number): Response {
    return new Response(
        JSON.stringify({
            access_token: accessToken,
            token_type: "Bearer",
            expires_in: expiresIn,
            refresh_token: refreshToken,
            scope,
        }),
        {
            status: 200,
            headers: {
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
            },
        }
    );
}

async function issueTokens(
    clientId: string,
    resource: string,
    scope: string,
    apiKeyCiphertext: string,
    familyId?: string,
    issuedCode?: string
): Promise<Response> {
    const store = await getOAuthStore();
    const family = familyId ?? randomToken("", 16);
    if (issuedCode) {
        const committed = await store.commitIssuedCode(issuedCode, family);
        if (!committed) {
            return oauthError(400, "invalid_grant", "The authorization code is invalid or was already used.");
        }
    }
    const accessToken = randomToken(ACCESS_TOKEN_PREFIX, 32);
    const refreshToken = randomToken(REFRESH_TOKEN_PREFIX, 32);
    const accessExpires = Date.now() + accessTtlSec() * 1000;
    const refreshExpires = Date.now() + refreshTtlSec() * 1000;
    await store.saveAccess(accessToken, {
        clientId,
        resource,
        scope,
        apiKeyCiphertext,
        expiresAt: accessExpires,
        familyId: family,
    });
    await store.saveRefresh(refreshToken, {
        clientId,
        resource,
        scope,
        apiKeyCiphertext,
        expiresAt: refreshExpires,
        familyId: family,
    });
    if (await store.isFamilyRevoked(family)) {
        await store.revokeFamily(family);
        return oauthError(400, "invalid_grant", "The authorization code is invalid or was already used.");
    }
    return tokenResponse(accessToken, refreshToken, scope, accessTtlSec());
}

export async function exchangeToken(request: Request): Promise<Response> {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.toLowerCase().includes("application/json")) {
        return oauthError(400, "invalid_request", "The token endpoint expects application/x-www-form-urlencoded.");
    }
    let form: URLSearchParams;
    try {
        form = await readFormBody(request);
    } catch {
        return oauthError(400, "invalid_request", "The token request could not be read.");
    }
    const grant = form.get("grant_type");
    if (grant === "authorization_code") {
        return exchangeCode(request, form);
    }
    if (grant === "refresh_token") {
        return exchangeRefresh(request, form);
    }
    return oauthError(400, "unsupported_grant_type", "Supported grants are authorization_code and refresh_token.");
}

async function exchangeCode(request: Request, form: URLSearchParams): Promise<Response> {
    const code = form.get("code") ?? "";
    const clientId = form.get("client_id") ?? "";
    const redirectUri = form.get("redirect_uri") ?? "";
    const verifier = form.get("code_verifier") ?? "";
    const resource = form.get("resource");
    if (!code || !clientId || !redirectUri || !verifier) {
        return oauthError(400, "invalid_request", "code, client_id, redirect_uri, and code_verifier are required.");
    }
    if (!VERIFIER_PATTERN.test(verifier)) {
        return oauthError(400, "invalid_grant", "code_verifier is not valid.");
    }
    const store = await getOAuthStore();
    const consumed = await store.consumeCode(code);
    if (!consumed.ok || consumed.record.clientId !== clientId || consumed.record.redirectUri !== redirectUri) {
        return oauthError(400, "invalid_grant", "The authorization code is invalid or was already used.");
    }
    const pending = consumed.record;
    if (resource && !resourcesMatch(resource, pending.resource)) {
        return oauthError(400, "invalid_target", "The resource does not match the authorization request.");
    }
    if (!resourcesMatch(pending.resource, canonicalResource(request))) {
        return oauthError(400, "invalid_target", "The authorization code was issued for a different resource.");
    }
    const expected = s256Challenge(verifier);
    if (!challengesMatch(expected, pending.codeChallenge)) {
        return oauthError(400, "invalid_grant", "PKCE verification failed.");
    }
    return issueTokens(pending.clientId, pending.resource, pending.scope, pending.apiKeyCiphertext, undefined, code);
}

async function exchangeRefresh(request: Request, form: URLSearchParams): Promise<Response> {
    const refreshToken = form.get("refresh_token") ?? "";
    const clientId = form.get("client_id") ?? "";
    const resource = form.get("resource");
    if (!refreshToken || !clientId) {
        return oauthError(400, "invalid_request", "refresh_token and client_id are required.");
    }
    const store = await getOAuthStore();
    const rotated = await store.rotateRefresh(refreshToken, {
        clientId,
        canonicalResource: canonicalResource(request),
        presentedResource: resource,
    });
    if (!rotated.ok) {
        return oauthError(400, rotated.error, rotated.description);
    }
    return tokenResponse(rotated.accessToken, rotated.refreshToken, rotated.scope, rotated.expiresIn);
}

export async function lookupAccessApiKey(token: string, request: Request): Promise<string | null> {
    const store = await getOAuthStore();
    const record = await store.getAccess(token);
    if (!record) {
        return null;
    }
    if (!resourcesMatch(record.resource, canonicalResource(request))) {
        return null;
    }
    return store.readApiKey(record.apiKeyCiphertext);
}
