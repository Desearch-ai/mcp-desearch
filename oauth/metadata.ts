export const SUPPORTED_SCOPES = ["mcp", "offline_access"] as const;

export function publicOrigin(request: Request): string {
    const configured = process.env.OAUTH_ISSUER?.trim().replace(/\/+$/, "");
    if (configured) {
        return configured;
    }
    const url = new URL(request.url);
    const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
    const proto = forwardedProto || url.protocol.replace(/:$/, "");
    const host = forwardedHost || request.headers.get("host") || url.host;
    return `${proto}://${host}`;
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

export function wwwAuthenticate(request: Request): string {
    return `Bearer realm="Desearch", resource_metadata="${resourceMetadataUrl(request)}", scope="mcp"`;
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
