import { clientIp } from "./client-ip.js";
import { positiveInt } from "./crypto.js";
import { getOAuthStore } from "./store.js";

export interface RateLimitDecision {
    allowed: boolean;
    retryAfterSec: number;
}

export function registerRateLimitConfig(): { limit: number; windowSec: number } {
    return {
        limit: positiveInt(process.env.OAUTH_REGISTER_RATE_LIMIT, 10, 1, 10_000),
        windowSec: positiveInt(process.env.OAUTH_REGISTER_RATE_WINDOW_SEC, 60 * 60, 1, 60 * 60 * 24),
    };
}

export function authorizeKeyRateLimitConfig(): { limit: number; windowSec: number } {
    return {
        limit: positiveInt(process.env.OAUTH_AUTHORIZE_RATE_LIMIT, 20, 1, 10_000),
        windowSec: positiveInt(process.env.OAUTH_AUTHORIZE_RATE_WINDOW_SEC, 10 * 60, 1, 60 * 60 * 24),
    };
}

export async function takeIpRateLimit(
    request: Request,
    bucket: string,
    limit: number,
    windowSec: number
): Promise<RateLimitDecision> {
    const store = await getOAuthStore();
    return store.consumeRateLimit(bucket, clientIp(request), limit, windowSec);
}
