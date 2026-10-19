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
 * (HTTP 422) instead of running a full trends query. Only 422 counts as valid.
 * Invalid keys return 401 or 403. Any other status, including 2xx, is an error:
 * the trends route may have changed, and treating success as "valid" would
 * accept a key the check never authenticated.
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
        if (response.status === 422) {
            return { ok: true };
        }
        console.warn(`Desearch API key check returned unexpected HTTP ${response.status}`);
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
