export interface KeyCheckOk {
    ok: true;
}

export interface KeyCheckFail {
    ok: false;
    message: string;
}

export type KeyCheck = KeyCheckOk | KeyCheckFail;

const INVALID_MESSAGE =
    "That API key was rejected. Copy the full key from the Desearch console and try again.";
const UNAVAILABLE_MESSAGE = "Could not verify the API key. Try again in a moment.";

let checkerOverride: ((apiKey: string) => Promise<KeyCheck>) | null = null;

export function setApiKeyCheckerForTests(checker: ((apiKey: string) => Promise<KeyCheck>) | null): void {
    if (process.env.NODE_ENV === "production") {
        throw new Error("API key check overrides are disabled");
    }
    checkerOverride = checker;
}

/**
 * Confirm the key with Desearch before an authorization code is issued.
 * `GET /twitter/trends?woeid=1&count=1` asks for fewer trends than the route
 * allows, so a real key is authenticated and then rejected as invalid input
 * (HTTP 422) instead of running a full trends query. Invalid keys return 401
 * or 403 before that check. 402 means the key is recognized and out of credits.
 */
export async function validateDesearchApiKey(
    apiKey: string,
    fetchImpl: typeof fetch = fetch
): Promise<KeyCheck> {
    const trimmed = apiKey.trim();
    if (!trimmed || /\s/.test(trimmed) || trimmed.length > 200) {
        return { ok: false, message: INVALID_MESSAGE };
    }

    const base = (process.env.DESEARCH_API_BASE ?? "https://api.desearch.ai").replace(/\/+$/, "");
    const url = new URL("/twitter/trends", base);
    url.searchParams.set("woeid", "1");
    url.searchParams.set("count", "1");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        const response = await fetchImpl(url, {
            method: "GET",
            headers: {
                Authorization: trimmed,
                Accept: "application/json",
            },
            signal: controller.signal,
        });
        await response.arrayBuffer().catch(() => undefined);
        if (response.status === 401 || response.status === 403) {
            return { ok: false, message: INVALID_MESSAGE };
        }
        if (response.status === 422 || response.status === 402 || (response.status >= 200 && response.status < 300)) {
            return { ok: true };
        }
        if (response.status === 429) {
            return {
                ok: false,
                message: "Desearch rate limited the key check. Wait a moment and try again.",
            };
        }
        return { ok: false, message: UNAVAILABLE_MESSAGE };
    } catch {
        return { ok: false, message: UNAVAILABLE_MESSAGE };
    } finally {
        clearTimeout(timer);
    }
}

export async function checkDesearchApiKey(apiKey: string): Promise<KeyCheck> {
    if (checkerOverride) {
        return checkerOverride(apiKey);
    }
    return validateDesearchApiKey(apiKey);
}
