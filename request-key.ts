/**
 * Desearch API key from the remote client.
 * Prefer `Authorization: Bearer <key>` (what MCP clients send). `x-api-key` is
 * accepted as well. A bare `Authorization: <key>` value is accepted so the same
 * string used as `DESEARCH_API_KEY` for stdio can be sent without a scheme.
 * Query strings are ignored so keys do not land in access logs.
 */
export function extractDesearchApiKey(request: Request): string | undefined {
    const authorization = request.headers.get("authorization")?.trim();
    if (authorization) {
        const bearer = /^Bearer\s+(\S+)$/i.exec(authorization);
        if (bearer?.[1]) {
            return bearer[1];
        }
        if (!/^Bearer\b/i.test(authorization) && !/\s/.test(authorization)) {
            return authorization;
        }
    }

    const headerKey = request.headers.get("x-api-key")?.trim();
    if (headerKey) {
        return headerKey;
    }

    return undefined;
}
