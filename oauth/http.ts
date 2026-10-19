import { ACCESS_TOKEN_PREFIX, REFRESH_TOKEN_PREFIX, AUTH_CODE_PREFIX } from "./crypto.js";
import { exchangeToken, htmlResponse, registerClient, showAuthorize, submitAuthorize, lookupAccessApiKey } from "./flow.js";
import { authorizationServerMetadata, protectedResourceMetadata, wwwAuthenticate } from "./metadata.js";
import { messagePage } from "./page.js";
import { OAuthConfigError } from "./store.js";
import { extractDesearchApiKey } from "../request-key.js";

export { resetOAuthForTests } from "./store.js";
export { setApiKeyCheckerForTests, validateDesearchApiKey } from "./validate-key.js";
export { wwwAuthenticate };

const OAUTH_PATHS = new Set([
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server",
    "/.well-known/openid-configuration",
    "/register",
    "/authorize",
    "/token",
]);

/**
 * `vercel.json` rewrites the public OAuth paths to these destinations before
 * the request reaches the process. The `api/*.js` wrappers map them back, but
 * a Node framework project uses `index.ts` as the only entry and never runs
 * those wrappers. Accept the rewritten paths here so both setups work.
 * Metadata URLs still advertise the public paths.
 */
const OAUTH_REWRITTEN_PATHS: Record<string, string> = {
    "/api/oauth-protected-resource": "/.well-known/oauth-protected-resource",
    "/api/oauth-protected-resource-mcp": "/.well-known/oauth-protected-resource/mcp",
    "/api/oauth-authorization-server": "/.well-known/oauth-authorization-server",
    "/api/openid-configuration": "/.well-known/openid-configuration",
    "/api/oauth-register": "/register",
    "/api/oauth-authorize": "/authorize",
    "/api/oauth-token": "/token",
};

export function canonicalOAuthPath(pathname: string): string | null {
    const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
    if (OAUTH_PATHS.has(normalized)) {
        return normalized;
    }
    return OAUTH_REWRITTEN_PATHS[normalized] ?? null;
}

export function isOAuthPath(pathname: string): boolean {
    return canonicalOAuthPath(pathname) !== null;
}

export function isOAuthMaterial(value: string): boolean {
    return (
        value.startsWith(ACCESS_TOKEN_PREFIX) ||
        value.startsWith(REFRESH_TOKEN_PREFIX) ||
        value.startsWith(AUTH_CODE_PREFIX)
    );
}

export type RequestCredential =
    | { kind: "anonymous" }
    | { kind: "key"; apiKey: string }
    | { kind: "unauthorized" }
    | { kind: "unavailable" };

/**
 * A raw Desearch API key is returned as-is. An OAuth access token is exchanged
 * for the key stored at grant time. Other OAuth material is never forwarded
 * to the Desearch API.
 */
export async function resolveRequestCredential(request: Request): Promise<RequestCredential> {
    const presented = extractDesearchApiKey(request);
    if (!presented) {
        return { kind: "anonymous" };
    }
    if (!isOAuthMaterial(presented)) {
        return { kind: "key", apiKey: presented };
    }
    if (!presented.startsWith(ACCESS_TOKEN_PREFIX)) {
        return { kind: "unauthorized" };
    }
    try {
        const apiKey = await lookupAccessApiKey(presented, request);
        if (!apiKey) {
            return { kind: "unauthorized" };
        }
        return { kind: "key", apiKey };
    } catch (error) {
        if (error instanceof OAuthConfigError) {
            return { kind: "unavailable" };
        }
        console.error(
            `OAuth token lookup failed: ${error instanceof Error ? error.message : "unknown error"}`
        );
        return { kind: "unavailable" };
    }
}

function json(body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=300",
        },
    });
}

function methodNotAllowed(allow: string): Response {
    return new Response(JSON.stringify({ error: "invalid_request", error_description: "Method not allowed." }), {
        status: 405,
        headers: {
            Allow: allow,
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
        },
    });
}

export async function handleOAuthHttp(request: Request): Promise<Response | null> {
    const pathname = canonicalOAuthPath(new URL(request.url).pathname);
    if (!pathname) {
        return null;
    }
    try {
        if (pathname === "/.well-known/oauth-protected-resource" || pathname === "/.well-known/oauth-protected-resource/mcp") {
            if (request.method !== "GET" && request.method !== "HEAD") {
                return methodNotAllowed("GET");
            }
            return json(protectedResourceMetadata(request));
        }
        if (pathname === "/.well-known/oauth-authorization-server" || pathname === "/.well-known/openid-configuration") {
            if (request.method !== "GET" && request.method !== "HEAD") {
                return methodNotAllowed("GET");
            }
            return json(authorizationServerMetadata(request));
        }
        if (pathname === "/register") {
            if (request.method !== "POST") {
                return methodNotAllowed("POST");
            }
            return await registerClient(request);
        }
        if (pathname === "/authorize") {
            if (request.method === "GET" || request.method === "HEAD") {
                return await showAuthorize(request);
            }
            if (request.method === "POST") {
                return await submitAuthorize(request);
            }
            return methodNotAllowed("GET, POST");
        }
        if (pathname === "/token") {
            if (request.method !== "POST") {
                return methodNotAllowed("POST");
            }
            return await exchangeToken(request);
        }
        return null;
    } catch (error) {
        if (error instanceof OAuthConfigError) {
            if (pathname === "/authorize") {
                return htmlResponse(500, messagePage("Connect Desearch", "OAuth storage is not configured on this server."));
            }
            return new Response(
                JSON.stringify({
                    error: "server_error",
                    error_description: "OAuth storage is not configured on this server.",
                }),
                {
                    status: 500,
                    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
                }
            );
        }
        console.error(`OAuth error: ${error instanceof Error ? error.message : "unknown error"}`);
        return new Response(JSON.stringify({ error: "server_error", error_description: "OAuth request failed." }), {
            status: 500,
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
    }
}
