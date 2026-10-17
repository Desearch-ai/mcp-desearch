/**
 * Redirect URIs accepted at registration and at /authorize.
 * Hosted clients use fixed HTTPS callbacks. Native clients use a loopback
 * redirect whose port changes every session (RFC 8252), so the port is ignored
 * for localhost and 127.0.0.1.
 */

const EXACT_REDIRECTS = new Set([
    "https://claude.ai/api/mcp/auth_callback",
    "https://claude.com/api/mcp/auth_callback",
    "https://chatgpt.com/connector_platform_oauth_redirect",
]);

const CHATGPT_CALLBACK_ID = /^\/connector\/oauth\/[A-Za-z0-9._~-]{1,200}$/;

function isLoopbackHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function isAllowedRedirectUri(value: string): boolean {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return false;
    }
    if (url.username || url.password || url.hash) {
        return false;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        return false;
    }

    const exact = `${url.origin}${url.pathname}`;
    if (EXACT_REDIRECTS.has(exact) && url.search === "") {
        return true;
    }

    if (
        url.protocol === "https:" &&
        url.hostname === "chatgpt.com" &&
        CHATGPT_CALLBACK_ID.test(url.pathname) &&
        url.search === ""
    ) {
        return true;
    }

    if (isLoopbackHost(url.hostname)) {
        return true;
    }

    return false;
}

/**
 * Loopback clients register one callback and then open another port.
 * The host and path must match. The port does not.
 */
export function redirectsMatch(registered: string, requested: string): boolean {
    if (registered === requested) {
        return true;
    }
    let left: URL;
    let right: URL;
    try {
        left = new URL(registered);
        right = new URL(requested);
    } catch {
        return false;
    }
    if (!isLoopbackHost(left.hostname) || !isLoopbackHost(right.hostname)) {
        return false;
    }
    return (
        left.protocol === right.protocol &&
        left.hostname.toLowerCase() === right.hostname.toLowerCase() &&
        left.pathname === right.pathname &&
        left.search === right.search
    );
}

export function redirectHostname(value: string): string {
    try {
        return new URL(value).hostname;
    } catch {
        return "";
    }
}
