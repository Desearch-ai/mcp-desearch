import { isProductionHost, OAuthConfigError } from "./errors.js";

export const SUPPORTED_SCOPES = ["mcp", "offline_access"] as const;

export interface WwwChallenge {
    error: string;
    error_description: string;
}

/**
 * Public origin of this authorization server.
 * Production refuses to run without `OAUTH_ISSUER`. Forwarded host headers are
 * never consulted, so a client cannot choose the issuer or the resource.
 */
export function publicOrigin(request: Request): string {
    const configured = process.env.OAUTH_ISSUER?.trim().replace(/\/+$/, "");
    if (configured) {
        return configured;
    }
    if (isProductionHost()) {
        throw new OAuthConfigError("OAUTH_ISSUER is required in production");
    }
    const url = new URL(request.url);
    return `${url.protocol}//${url.host}`;
}

export function canonicalResource(request: Request): string {
    const configured = process.env.OAUTH_RESOURCE?.trim().replace(/\/+$/, "");
    if (configured) {
        return configured;
    }
    return `${publicOrigin(request)}/mcp`;
}

export function resourceMetadataUrl(request: Request): string {
    return `${publicOrigin(request)}/.well-known/oauth-protected-resource/mcp`;
}

export function protectedResourceMetadata(request: Request): Record<string, unknown> {
    const origin = publicOrigin(request);
    return {
        resource: canonicalResource(request),
        authorization_servers: [origin],
        scopes_supported: [...SUPPORTED_SCOPES],
        bearer_methods_supported: ["header"],
        resource_documentation: "https://www.desearch.ai/docs/guide/sdk/mcp",
    };
}

export function authorizationServerMetadata(request: Request): Record<string, unknown> {
    const origin = publicOrigin(request);
    return {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: [...SUPPORTED_SCOPES],
        authorization_response_iss_parameter_supported: true,
    };
}

export function wwwAuthenticate(request: Request, challenge?: WwwChallenge): string {
    const base = `Bearer realm="Desearch", resource_metadata="${resourceMetadataUrl(request)}", scope="mcp"`;
    if (!challenge) {
        return base;
    }
    const description = challenge.error_description.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `${base}, error="${challenge.error}", error_description="${description}"`;
}

export function resourcesMatch(left: string, right: string): boolean {
    return normalizeResource(left) === normalizeResource(right);
}

function normalizeResource(value: string): string {
    try {
        const url = new URL(value);
        const path = url.pathname.replace(/\/+$/, "") || "";
        return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${path}`;
    } catch {
        return value;
    }
}

export function grantedScope(requested: string | null | undefined): string {
    const asked = (requested ?? "")
        .split(/\s+/)
        .map((scope) => scope.trim())
        .filter((scope) => (SUPPORTED_SCOPES as readonly string[]).includes(scope));
    const unique = [...new Set(asked)];
    if (unique.length === 0) {
        return "mcp offline_access";
    }
    return unique.join(" ");
}
