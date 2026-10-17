import {
    createCipheriv,
    createDecipheriv,
    createHash,
    randomBytes,
    timingSafeEqual,
} from "node:crypto";

export const ACCESS_TOKEN_PREFIX = "dsoat_";
export const REFRESH_TOKEN_PREFIX = "dsort_";
export const AUTH_CODE_PREFIX = "dsoc_";
export const CLIENT_ID_PREFIX = "dsocid_";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const globalKey = globalThis as { __desearchOAuthKey?: Buffer };

export function randomToken(prefix: string, bytes = 32): string {
    return prefix + randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

export function s256Challenge(verifier: string): string {
    return createHash("sha256").update(verifier).digest("base64url");
}

export function challengesMatch(actual: string, expected: string): boolean {
    const left = Buffer.from(actual);
    const right = Buffer.from(expected);
    if (left.length !== right.length) {
        return false;
    }
    return timingSafeEqual(left, right);
}

function decodeConfiguredKey(raw: string): Buffer {
    const trimmed = raw.trim();
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
        return Buffer.from(trimmed, "hex");
    }
    const decoded = Buffer.from(trimmed, "base64url");
    if (decoded.length === KEY_BYTES) {
        return decoded;
    }
    const standard = Buffer.from(trimmed, "base64");
    if (standard.length === KEY_BYTES) {
        return standard;
    }
    throw new Error("OAUTH_ENCRYPTION_KEY must decode to 32 bytes (base64 or hex)");
}

/**
 * AES-256-GCM key for API keys at rest.
 * Redis mode refuses to start without OAUTH_ENCRYPTION_KEY so two instances
 * cannot encrypt with different process-local keys.
 */
export function encryptionKey(options: { requireConfigured?: boolean } = {}): Buffer {
    const configured = process.env.OAUTH_ENCRYPTION_KEY?.trim();
    if (configured) {
        return decodeConfiguredKey(configured);
    }
    if (options.requireConfigured) {
        throw new Error("OAUTH_ENCRYPTION_KEY is required when OAUTH_STORE=redis");
    }
    if (!globalKey.__desearchOAuthKey) {
        globalKey.__desearchOAuthKey = randomBytes(KEY_BYTES);
        console.error(
            "OAUTH_ENCRYPTION_KEY is unset. OAuth token storage is using a process-local key."
        );
    }
    return globalKey.__desearchOAuthKey;
}

export function encryptSecret(plaintext: string, key: Buffer = encryptionKey()): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ciphertext]).toString("base64url");
}

export function decryptSecret(payload: string, key: Buffer = encryptionKey()): string {
    const raw = Buffer.from(payload, "base64url");
    if (raw.length <= IV_BYTES + TAG_BYTES) {
        throw new Error("ciphertext is truncated");
    }
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function positiveInt(raw: string | undefined, fallback: number, min: number, max: number): number {
    if (raw === undefined || raw.trim() === "") {
        return fallback;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`expected an integer from ${min} to ${max}`);
    }
    return value;
}
