import { createClient } from "redis";
import {
    ACCESS_TOKEN_PREFIX,
    REFRESH_TOKEN_PREFIX,
    decryptSecret,
    encryptSecret,
    encryptionKey,
    positiveInt,
    randomToken,
    sha256,
} from "./crypto.js";
import { isProductionHost, OAuthConfigError } from "./errors.js";
import { resourcesMatch } from "./metadata.js";

export { OAuthConfigError, isProductionHost };

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

export interface ConsumeCodeResult {
    status: "ok" | "missing" | "replay";
    recordJson?: string;
    familyId?: string;
}

export interface ClaimRefreshInput {
    refreshKey: string;
    tombstoneKey: string;
    now: number;
    expectedClientId: string;
    canonicalResource: string;
    presentedResource: string;
    tombTtlSec: number;
    familyKeyPrefix: string;
    revokedKeyPrefix: string;
}

export interface ClaimRefreshResult {
    status: "ok" | "invalid" | "client_mismatch" | "resource_mismatch" | "reused";
    recordJson?: string;
    familyId?: string;
    resourceReason?: "presented" | "canonical";
}

export interface Kv {
    get(key: string): Promise<string | null>;
    getDel(key: string): Promise<string | null>;
    set(key: string, value: string, ttlSec: number): Promise<void>;
    del(key: string): Promise<void>;
    consumeAuthCode(codeKey: string, tombstoneKey: string, now: number, tombTtlSec: number): Promise<ConsumeCodeResult>;
    commitAuthCode(tombstoneKey: string, familyId: string, tombTtlSec: number): Promise<"committed" | "replayed">;
    claimRefresh(input: ClaimRefreshInput): Promise<ClaimRefreshResult>;
}

const PREFIX = "desearch:oauth:";
const FAMILY_PREFIX = PREFIX + "family:";
const REVOKED_PREFIX = PREFIX + "family-revoked:";

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

    async consumeCode(code: string): Promise<{ ok: true; record: CodeRecord } | { ok: false }> {
        const hash = sha256(code);
        const result = await this.kv.consumeAuthCode(
            PREFIX + "code:" + hash,
            PREFIX + "code-used:" + hash,
            Date.now(),
            refreshTtlSec()
        );
        if (result.status === "ok") {
            const record = readJson<CodeRecord>(result.recordJson ?? null);
            if (!record) {
                return { ok: false };
            }
            return { ok: true, record };
        }
        if (result.status === "replay" && result.familyId) {
            await this.revokeFamily(result.familyId);
        }
        return { ok: false };
    }

    async commitIssuedCode(code: string, familyId: string): Promise<boolean> {
        const result = await this.kv.commitAuthCode(
            PREFIX + "code-used:" + sha256(code),
            familyId,
            refreshTtlSec()
        );
        return result === "committed";
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
     * Rotate a refresh token. The claim, reuse detection, and family revoke
     * flag are one atomic step (in-process for memory, one Lua script for Redis)
     * so two overlapping presentations cannot both mint a new grant.
     */
    async rotateRefresh(
        token: string,
        options: { clientId: string; canonicalResource: string; presentedResource: string | null }
    ): Promise<
        | { ok: true; accessToken: string; refreshToken: string; scope: string; expiresIn: number }
        | { ok: false; error: "invalid_grant" | "invalid_target"; description: string }
    > {
        const hash = sha256(token);
        const claimed = await this.kv.claimRefresh({
            refreshKey: PREFIX + "refresh:" + hash,
            tombstoneKey: PREFIX + "refresh-used:" + hash,
            now: Date.now(),
            expectedClientId: options.clientId,
            canonicalResource: options.canonicalResource,
            presentedResource: options.presentedResource ?? "",
            tombTtlSec: refreshTtlSec(),
            familyKeyPrefix: FAMILY_PREFIX,
            revokedKeyPrefix: REVOKED_PREFIX,
        });
        if (claimed.status === "resource_mismatch") {
            return {
                ok: false,
                error: "invalid_target",
                description:
                    claimed.resourceReason === "presented"
                        ? "The resource does not match the refresh token."
                        : "The refresh token was issued for a different resource.",
            };
        }
        if (claimed.status === "reused" && claimed.familyId) {
            await this.revokeFamily(claimed.familyId);
        }
        if (claimed.status !== "ok" || !claimed.recordJson) {
            return {
                ok: false,
                error: "invalid_grant",
                description: "The refresh token is invalid or was already used.",
            };
        }
        const record = readJson<RefreshRecord>(claimed.recordJson);
        if (!record) {
            return {
                ok: false,
                error: "invalid_grant",
                description: "The refresh token is invalid or was already used.",
            };
        }
        const accessToken = randomToken(ACCESS_TOKEN_PREFIX, 32);
        const refreshToken = randomToken(REFRESH_TOKEN_PREFIX, 32);
        const accessExpires = Date.now() + accessTtlSec() * 1000;
        const refreshExpires = Date.now() + refreshTtlSec() * 1000;
        await this.saveAccess(accessToken, {
            clientId: record.clientId,
            resource: record.resource,
            scope: record.scope,
            apiKeyCiphertext: record.apiKeyCiphertext,
            expiresAt: accessExpires,
            familyId: record.familyId,
        });
        await this.saveRefresh(refreshToken, {
            clientId: record.clientId,
            resource: record.resource,
            scope: record.scope,
            apiKeyCiphertext: record.apiKeyCiphertext,
            expiresAt: refreshExpires,
            familyId: record.familyId,
        });
        if (await this.isFamilyRevoked(record.familyId)) {
            await this.revokeFamily(record.familyId);
            return {
                ok: false,
                error: "invalid_grant",
                description: "The refresh token is invalid or was already used.",
            };
        }
        return {
            ok: true,
            accessToken,
            refreshToken,
            scope: record.scope,
            expiresIn: accessTtlSec(),
        };
    }

    async isFamilyRevoked(familyId: string): Promise<boolean> {
        return (await this.kv.get(REVOKED_PREFIX + familyId)) === "1";
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
        const familyKey = FAMILY_PREFIX + familyId;
        const family = readJson<FamilyRecord>(await this.kv.get(familyKey)) ?? {
            accessKeys: [],
            refreshKeys: [],
        };
        family[field].push(key);
        await this.kv.set(familyKey, JSON.stringify(family), refreshTtlSec());
    }

    async revokeFamily(familyId: string): Promise<void> {
        await this.kv.set(REVOKED_PREFIX + familyId, "1", refreshTtlSec());
        const familyKey = FAMILY_PREFIX + familyId;
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

interface MemoryRow {
    value: string;
    expiresAt: number;
}

class MemoryKv implements Kv {
    private readonly rows = new Map<string, MemoryRow>();

    async get(key: string): Promise<string | null> {
        return this.getSync(key);
    }

    async getDel(key: string): Promise<string | null> {
        const value = this.getSync(key);
        this.rows.delete(key);
        return value;
    }

    async set(key: string, value: string, ttlSec: number): Promise<void> {
        this.setSync(key, value, ttlSec);
    }

    async del(key: string): Promise<void> {
        this.rows.delete(key);
    }

    async consumeAuthCode(
        codeKey: string,
        tombstoneKey: string,
        now: number,
        tombTtlSec: number
    ): Promise<ConsumeCodeResult> {
        const raw = this.getSync(codeKey);
        if (!raw) {
            const tomb = this.getSync(tombstoneKey);
            if (!tomb) {
                return { status: "missing" };
            }
            if (tomb === "pending" || tomb === "replayed") {
                this.setSync(tombstoneKey, "replayed", tombTtlSec);
                return { status: "replay" };
            }
            this.revokeFamilySync(tomb);
            return { status: "replay", familyId: tomb };
        }
        const record = readJson<CodeRecord>(raw);
        if (!record || record.expiresAt <= now) {
            this.rows.delete(codeKey);
            return { status: "missing" };
        }
        this.rows.delete(codeKey);
        this.setSync(tombstoneKey, "pending", tombTtlSec);
        return { status: "ok", recordJson: raw };
    }

    async commitAuthCode(
        tombstoneKey: string,
        familyId: string,
        tombTtlSec: number
    ): Promise<"committed" | "replayed"> {
        if (this.getSync(tombstoneKey) === "replayed") {
            return "replayed";
        }
        this.setSync(tombstoneKey, familyId, tombTtlSec);
        return "committed";
    }

    async claimRefresh(input: ClaimRefreshInput): Promise<ClaimRefreshResult> {
        const raw = this.getSync(input.refreshKey);
        if (!raw) {
            const familyId = this.getSync(input.tombstoneKey);
            if (familyId) {
                this.revokeFamilySync(familyId);
                return { status: "reused", familyId };
            }
            return { status: "invalid" };
        }
        const record = readJson<RefreshRecord>(raw);
        if (!record || record.expiresAt <= input.now) {
            this.rows.delete(input.refreshKey);
            return { status: "invalid" };
        }
        if (record.clientId !== input.expectedClientId) {
            return { status: "client_mismatch" };
        }
        if (input.presentedResource && !resourcesMatch(record.resource, input.presentedResource)) {
            return { status: "resource_mismatch", resourceReason: "presented" };
        }
        if (!resourcesMatch(record.resource, input.canonicalResource)) {
            return { status: "resource_mismatch", resourceReason: "canonical" };
        }
        if (record.replacedBy) {
            this.setSync(input.tombstoneKey, record.familyId, input.tombTtlSec);
            this.revokeFamilySync(record.familyId);
            return { status: "reused", familyId: record.familyId };
        }
        const remainingMs = (this.rows.get(input.refreshKey)?.expiresAt ?? input.now) - input.now;
        record.replacedBy = "claimed";
        this.rows.set(input.refreshKey, {
            value: JSON.stringify(record),
            expiresAt: input.now + Math.max(1000, remainingMs),
        });
        this.setSync(input.tombstoneKey, record.familyId, input.tombTtlSec);
        return { status: "ok", recordJson: raw };
    }

    private getSync(key: string): string | null {
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

    private setSync(key: string, value: string, ttlSec: number): void {
        this.rows.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
    }

    private revokeFamilySync(familyId: string): void {
        this.setSync(REVOKED_PREFIX + familyId, "1", refreshTtlSec());
        const familyKey = FAMILY_PREFIX + familyId;
        const family = readJson<FamilyRecord>(this.getSync(familyKey));
        if (!family) {
            return;
        }
        for (const key of family.accessKeys) {
            this.rows.delete(key);
        }
        for (const key of family.refreshKeys) {
            this.rows.delete(key);
        }
        this.rows.delete(familyKey);
    }
}

interface RedisLike {
    get(key: string): Promise<string | null>;
    getDel(key: string): Promise<string | null>;
    set(key: string, value: string, options: { EX: number }): Promise<unknown>;
    del(key: string): Promise<unknown>;
    eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

const CONSUME_CODE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
local now = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
if not raw then
  local tomb = redis.call('GET', KEYS[2])
  if not tomb or tomb == '' then
    return cjson.encode({ status = 'missing' })
  end
  if tomb == 'pending' or tomb == 'replayed' then
    redis.call('SET', KEYS[2], 'replayed', 'EX', ttl)
    return cjson.encode({ status = 'replay' })
  end
  local revokedKey = ARGV[3] .. tomb
  local familyKey = ARGV[4] .. tomb
  redis.call('SET', revokedKey, '1', 'EX', ttl)
  local familyRaw = redis.call('GET', familyKey)
  if familyRaw then
    local family = cjson.decode(familyRaw)
    for _, key in ipairs(family.accessKeys or {}) do redis.call('DEL', key) end
    for _, key in ipairs(family.refreshKeys or {}) do redis.call('DEL', key) end
    redis.call('DEL', familyKey)
  end
  return cjson.encode({ status = 'replay', familyId = tomb })
end
local ok, record = pcall(cjson.decode, raw)
if not ok or type(record) ~= 'table' or tonumber(record.expiresAt or 0) <= now then
  redis.call('DEL', KEYS[1])
  return cjson.encode({ status = 'missing' })
end
redis.call('DEL', KEYS[1])
redis.call('SET', KEYS[2], 'pending', 'EX', ttl)
return cjson.encode({ status = 'ok', record = raw })
`;

const COMMIT_CODE_SCRIPT = `
local tomb = redis.call('GET', KEYS[1])
if tomb == 'replayed' then
  return 'replayed'
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
return 'committed'
`;

const CLAIM_REFRESH_SCRIPT = `
local function norm(value)
  if type(value) ~= 'string' then return '' end
  local scheme, rest = string.match(value, '^([%a][%w+.-]*)://(.*)$')
  if not scheme then
    return (string.gsub(value, '/+$', ''))
  end
  local host, path = string.match(rest, '^([^/]+)(.*)$')
  path = path or ''
  path = string.gsub(path, '[?#].*$', '')
  path = string.gsub(path, '/+$', '')
  return string.lower(scheme) .. '://' .. string.lower(host or '') .. path
end

local function revoke(familyId, ttl, revokedPrefix, familyPrefix)
  if not familyId or familyId == '' then return end
  redis.call('SET', revokedPrefix .. familyId, '1', 'EX', ttl)
  local familyRaw = redis.call('GET', familyPrefix .. familyId)
  if not familyRaw then return end
  local family = cjson.decode(familyRaw)
  for _, key in ipairs(family.accessKeys or {}) do redis.call('DEL', key) end
  for _, key in ipairs(family.refreshKeys or {}) do redis.call('DEL', key) end
  redis.call('DEL', familyPrefix .. familyId)
end

local raw = redis.call('GET', KEYS[1])
local now = tonumber(ARGV[1])
local ttl = tonumber(ARGV[6])
if not raw then
  local familyId = redis.call('GET', KEYS[2])
  if familyId and familyId ~= '' then
    revoke(familyId, ttl, ARGV[7], ARGV[8])
    return cjson.encode({ status = 'reused', familyId = familyId })
  end
  return cjson.encode({ status = 'invalid' })
end
local ok, record = pcall(cjson.decode, raw)
if not ok or type(record) ~= 'table' or tonumber(record.expiresAt or 0) <= now then
  redis.call('DEL', KEYS[1])
  return cjson.encode({ status = 'invalid' })
end
if record.clientId ~= ARGV[2] then
  return cjson.encode({ status = 'client_mismatch' })
end
if ARGV[4] ~= '' and norm(record.resource) ~= norm(ARGV[4]) then
  return cjson.encode({ status = 'resource_mismatch', resourceReason = 'presented' })
end
if norm(record.resource) ~= norm(ARGV[3]) then
  return cjson.encode({ status = 'resource_mismatch', resourceReason = 'canonical' })
end
if record.replacedBy and record.replacedBy ~= '' and record.replacedBy ~= cjson.null then
  redis.call('SET', KEYS[2], record.familyId, 'EX', ttl)
  revoke(record.familyId, ttl, ARGV[7], ARGV[8])
  return cjson.encode({ status = 'reused', familyId = record.familyId })
end
local pttl = redis.call('PTTL', KEYS[1])
if pttl < 1 then pttl = 1000 end
record.replacedBy = 'claimed'
redis.call('SET', KEYS[1], cjson.encode(record), 'PX', pttl)
redis.call('SET', KEYS[2], record.familyId, 'EX', ttl)
return cjson.encode({ status = 'ok', record = raw })
`;

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

    async consumeAuthCode(
        codeKey: string,
        tombstoneKey: string,
        now: number,
        tombTtlSec: number
    ): Promise<ConsumeCodeResult> {
        const reply = await this.client.eval(CONSUME_CODE_SCRIPT, {
            keys: [codeKey, tombstoneKey],
            arguments: [String(now), String(tombTtlSec), REVOKED_PREFIX, FAMILY_PREFIX],
        });
        const parsed = parseScript<{
            status: ConsumeCodeResult["status"];
            record?: string;
            familyId?: string;
        }>(reply, { status: "missing" });
        return { status: parsed.status, recordJson: parsed.record, familyId: parsed.familyId };
    }

    async commitAuthCode(
        tombstoneKey: string,
        familyId: string,
        tombTtlSec: number
    ): Promise<"committed" | "replayed"> {
        const reply = await this.client.eval(COMMIT_CODE_SCRIPT, {
            keys: [tombstoneKey],
            arguments: [familyId, String(tombTtlSec)],
        });
        const text = redisText(reply);
        return text === "replayed" ? "replayed" : "committed";
    }

    async claimRefresh(input: ClaimRefreshInput): Promise<ClaimRefreshResult> {
        const reply = await this.client.eval(CLAIM_REFRESH_SCRIPT, {
            keys: [input.refreshKey, input.tombstoneKey],
            arguments: [
                String(input.now),
                input.expectedClientId,
                input.canonicalResource,
                input.presentedResource,
                input.familyKeyPrefix,
                String(input.tombTtlSec),
                input.revokedKeyPrefix,
                input.familyKeyPrefix,
            ],
        });
        const parsed = parseScript<{
            status: ClaimRefreshResult["status"];
            record?: string;
            familyId?: string;
            resourceReason?: "presented" | "canonical";
        }>(reply, { status: "invalid" });
        return {
            status: parsed.status,
            recordJson: parsed.record,
            familyId: parsed.familyId,
            resourceReason: parsed.resourceReason,
        };
    }
}

function redisText(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    if (value instanceof Uint8Array) {
        return new TextDecoder().decode(value);
    }
    throw new Error("Unexpected Redis script reply");
}

function parseScript<T>(value: unknown, fallback: T): T {
    try {
        return JSON.parse(redisText(value)) as T;
    } catch {
        return fallback;
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
    const backend = (process.env.OAUTH_STORE ?? "memory").trim().toLowerCase();
    if (isProductionHost() && backend !== "redis") {
        throw new OAuthConfigError("OAUTH_STORE must be redis in production");
    }
    if (globalStore.__desearchOAuthStore) {
        return globalStore.__desearchOAuthStore;
    }
    if (backend === "memory" || backend === "") {
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
