import { createClient } from "redis";
import { decryptSecret, encryptSecret, encryptionKey, positiveInt, sha256 } from "./crypto.js";

export interface ClientRecord {
    clientId: string;
    clientName: string;
    redirectUris: string[];
    tokenEndpointAuthMethod: "none";
    createdAt: number;
}

export interface CodeRecord {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    resource: string;
    scope: string;
    apiKeyCiphertext: string;
    expiresAt: number;
}

export interface AccessRecord {
    clientId: string;
    resource: string;
    scope: string;
    apiKeyCiphertext: string;
    expiresAt: number;
    familyId: string;
}

export interface RefreshRecord {
    clientId: string;
    resource: string;
    scope: string;
    apiKeyCiphertext: string;
    expiresAt: number;
    familyId: string;
    replacedBy?: string;
}

interface FamilyRecord {
    accessKeys: string[];
    refreshKeys: string[];
}

export interface Kv {
    get(key: string): Promise<string | null>;
    getDel(key: string): Promise<string | null>;
    set(key: string, value: string, ttlSec: number): Promise<void>;
    del(key: string): Promise<void>;
}

export class OAuthConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "OAuthConfigError";
    }
}

const PREFIX = "desearch:oauth:";

function clientTtlSec(): number {
    return positiveInt(process.env.OAUTH_CLIENT_TTL_SEC, 60 * 60 * 24 * 365 * 2, 3600, 60 * 60 * 24 * 365 * 5);
}

export function accessTtlSec(): number {
    return positiveInt(process.env.OAUTH_ACCESS_TTL_SEC, 3600, 60, 60 * 60 * 24);
}

export function refreshTtlSec(): number {
    return positiveInt(process.env.OAUTH_REFRESH_TTL_SEC, 60 * 60 * 24 * 30, 300, 60 * 60 * 24 * 90);
}

export function codeTtlSec(): number {
    return positiveInt(process.env.OAUTH_CODE_TTL_SEC, 300, 30, 600);
}

function ttlFromExpiry(expiresAt: number): number {
    return Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
}

export class KvOAuthStore {
    constructor(private readonly kv: Kv) {}

    async saveClient(record: ClientRecord): Promise<void> {
        await this.kv.set(PREFIX + "client:" + record.clientId, JSON.stringify(record), clientTtlSec());
    }

    async getClient(clientId: string): Promise<ClientRecord | null> {
        return readJson<ClientRecord>(await this.kv.get(PREFIX + "client:" + clientId));
    }

    async saveCode(code: string, record: CodeRecord): Promise<void> {
        await this.kv.set(PREFIX + "code:" + sha256(code), JSON.stringify(record), codeTtlSec());
    }

    async consumeCode(code: string): Promise<CodeRecord | null> {
        const record = readJson<CodeRecord>(await this.kv.getDel(PREFIX + "code:" + sha256(code)));
        if (!record || record.expiresAt <= Date.now()) {
            return null;
        }
        return record;
    }

    async saveAccess(token: string, record: AccessRecord): Promise<void> {
        const key = PREFIX + "access:" + sha256(token);
        await this.kv.set(key, JSON.stringify(record), accessTtlSec());
        await this.remember(record.familyId, "accessKeys", key);
    }

    async getAccess(token: string): Promise<AccessRecord | null> {
        const key = PREFIX + "access:" + sha256(token);
        const record = readJson<AccessRecord>(await this.kv.get(key));
        if (!record) {
            return null;
        }
        if (record.expiresAt <= Date.now()) {
            await this.kv.del(key);
            return null;
        }
        return record;
    }

    async saveRefresh(token: string, record: RefreshRecord): Promise<void> {
        const key = PREFIX + "refresh:" + sha256(token);
        await this.kv.set(key, JSON.stringify(record), refreshTtlSec());
        await this.remember(record.familyId, "refreshKeys", key);
    }

    /**
     * Rotate a refresh token. A token that was already rotated revokes the
     * whole grant family (OAuth 2.1 refresh-token reuse).
     */
    async rotateRefresh(token: string): Promise<
        | { ok: true; record: RefreshRecord }
        | { ok: false; error: "invalid_grant" }
    > {
        const key = PREFIX + "refresh:" + sha256(token);
        const record = readJson<RefreshRecord>(await this.kv.get(key));
        if (!record || record.expiresAt <= Date.now()) {
            if (record) {
                await this.kv.del(key);
            }
            return { ok: false, error: "invalid_grant" };
        }
        if (record.replacedBy) {
            await this.revokeFamily(record.familyId);
            return { ok: false, error: "invalid_grant" };
        }
        return { ok: true, record };
    }

    async markRefreshReplaced(token: string, replacedByHash: string, expiresAt: number): Promise<void> {
        const key = PREFIX + "refresh:" + sha256(token);
        const record = readJson<RefreshRecord>(await this.kv.get(key));
        if (!record) {
            return;
        }
        record.replacedBy = replacedByHash;
        await this.kv.set(key, JSON.stringify(record), ttlFromExpiry(expiresAt));
    }

    readApiKey(ciphertext: string): string | null {
        try {
            return decryptSecret(ciphertext);
        } catch (error) {
            console.error(
                `OAuth token decrypt failed: ${error instanceof Error ? error.message : "unknown error"}`
            );
            return null;
        }
    }

    sealApiKey(apiKey: string): string {
        return encryptSecret(apiKey);
    }

    private async remember(
        familyId: string,
        field: "accessKeys" | "refreshKeys",
        key: string
    ): Promise<void> {
        const familyKey = PREFIX + "family:" + familyId;
        const family = readJson<FamilyRecord>(await this.kv.get(familyKey)) ?? {
            accessKeys: [],
            refreshKeys: [],
        };
        family[field].push(key);
        await this.kv.set(familyKey, JSON.stringify(family), refreshTtlSec());
    }

    private async revokeFamily(familyId: string): Promise<void> {
        const familyKey = PREFIX + "family:" + familyId;
        const family = readJson<FamilyRecord>(await this.kv.get(familyKey));
        if (!family) {
            return;
        }
        await Promise.all([
            ...family.accessKeys.map((key) => this.kv.del(key)),
            ...family.refreshKeys.map((key) => this.kv.del(key)),
            this.kv.del(familyKey),
        ]);
    }
}

function readJson<T>(raw: string | null): T | null {
    if (!raw) {
        return null;
    }
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

class MemoryKv implements Kv {
    private readonly rows = new Map<string, { value: string; expiresAt: number }>();

    async get(key: string): Promise<string | null> {
        const row = this.rows.get(key);
        if (!row) {
            return null;
        }
        if (row.expiresAt <= Date.now()) {
            this.rows.delete(key);
            return null;
        }
        return row.value;
    }

    async getDel(key: string): Promise<string | null> {
        const value = await this.get(key);
        this.rows.delete(key);
        return value;
    }

    async set(key: string, value: string, ttlSec: number): Promise<void> {
        this.rows.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
    }

    async del(key: string): Promise<void> {
        this.rows.delete(key);
    }
}

interface RedisLike {
    get(key: string): Promise<string | null>;
    getDel(key: string): Promise<string | null>;
    set(key: string, value: string, options: { EX: number }): Promise<unknown>;
    del(key: string): Promise<unknown>;
}

class RedisKv implements Kv {
    constructor(private readonly client: RedisLike) {}

    async get(key: string): Promise<string | null> {
        return this.client.get(key);
    }

    async getDel(key: string): Promise<string | null> {
        return this.client.getDel(key);
    }

    async set(key: string, value: string, ttlSec: number): Promise<void> {
        await this.client.set(key, value, { EX: ttlSec });
    }

    async del(key: string): Promise<void> {
        await this.client.del(key);
    }
}

const globalStore = globalThis as { __desearchOAuthStore?: KvOAuthStore };

let redisClientPromise: Promise<RedisLike> | undefined;

async function redisClient(): Promise<RedisLike> {
    if (redisClientPromise) {
        return redisClientPromise;
    }
    const url = process.env.REDIS_URL?.trim();
    if (!url) {
        throw new OAuthConfigError("REDIS_URL is required when OAUTH_STORE=redis");
    }
    const client = createClient({ url });
    client.on("error", (error: Error) => {
        console.error(`OAuth Redis error: ${error.message}`);
    });
    redisClientPromise = client.connect().then(() => client as unknown as RedisLike);
    return redisClientPromise;
}

export async function getOAuthStore(): Promise<KvOAuthStore> {
    if (globalStore.__desearchOAuthStore) {
        return globalStore.__desearchOAuthStore;
    }
    const backend = (process.env.OAUTH_STORE ?? "memory").trim().toLowerCase();
    if (backend === "memory" || backend === "") {
        if (process.env.NODE_ENV === "production") {
            console.error(
                "OAUTH_STORE is memory. Tokens stay on this process. Set OAUTH_STORE=redis and REDIS_URL for a shared store."
            );
        }
        globalStore.__desearchOAuthStore = new KvOAuthStore(new MemoryKv());
        return globalStore.__desearchOAuthStore;
    }
    if (backend === "redis") {
        if (!process.env.REDIS_URL?.trim()) {
            throw new OAuthConfigError("REDIS_URL is required when OAUTH_STORE=redis");
        }
        try {
            encryptionKey({ requireConfigured: true });
        } catch (error) {
            throw new OAuthConfigError(
                error instanceof Error ? error.message : "OAUTH_ENCRYPTION_KEY is required when OAUTH_STORE=redis"
            );
        }
        const client = await redisClient();
        globalStore.__desearchOAuthStore = new KvOAuthStore(new RedisKv(client));
        return globalStore.__desearchOAuthStore;
    }
    throw new OAuthConfigError("OAUTH_STORE must be memory or redis");
}

export function resetOAuthForTests(): void {
    if (process.env.NODE_ENV === "production") {
        throw new Error("OAuth store reset is disabled");
    }
    delete globalStore.__desearchOAuthStore;
}
