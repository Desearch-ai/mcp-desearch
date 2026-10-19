/** Stamped by the Node HTTP server from the socket. Ignored when `VERCEL` is set. */
export const DIRECT_CLIENT_IP_HEADER = "x-desearch-remote-address";

/**
 * Address used for per-IP limits.
 * On Vercel the platform puts the client first in `X-Forwarded-For` and appends
 * proxies, so the first hop is the caller. Off Vercel that header is chosen by
 * the client and is ignored. The Node server stamps the socket address instead.
 */
export function clientIp(request: Request): string {
    if (process.env.VERCEL) {
        return firstForwardedHop(request.headers.get("x-forwarded-for")) ?? "unknown";
    }
    const direct = request.headers.get(DIRECT_CLIENT_IP_HEADER)?.trim();
    if (direct) {
        return direct.slice(0, 128);
    }
    return "unknown";
}

function firstForwardedHop(value: string | null): string | null {
    if (!value) {
        return null;
    }
    const first = value.split(",")[0]?.trim().replace(/^"|"$/g, "");
    if (!first) {
        return null;
    }
    return first.slice(0, 128);
}
