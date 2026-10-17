export class OAuthConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "OAuthConfigError";
    }
}

/**
 * Hosted runtimes must not fall open on process-local OAuth settings.
 * Vercel sets `VERCEL` even when `NODE_ENV` is missing.
 */
export function isProductionHost(): boolean {
    return process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
}
