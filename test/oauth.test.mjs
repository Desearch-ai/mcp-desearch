import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import protectedResource from "../api/oauth-protected-resource.js";
import protectedResourceMcp from "../api/oauth-protected-resource-mcp.js";
import { startHttpServer } from "../build/http.js";
import {
    resetOAuthForTests,
    setApiKeyCheckerForTests,
    validateDesearchApiKey,
} from "../build/oauth/http.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { clientIp } from "../build/oauth/client-ip.js";
import {
    clientTtlSec,
    getOAuthStore,
    KvOAuthStore,
    memoryStoreForTests,
    redisKvForTests,
} from "../build/oauth/store.js";

const API_KEY = "dt_test_key_do_not_leak";
const MCP_HEADERS = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
};

function pkce() {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return { verifier, challenge };
}

function restoreEnv(name, previous) {
    if (previous === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = previous;
    }
}

async function withServer(fn) {
    const previousIssuer = process.env.OAUTH_ISSUER;
    const previousResource = process.env.OAUTH_RESOURCE;
    const previousStore = process.env.OAUTH_STORE;
    const previousKey = process.env.OAUTH_ENCRYPTION_KEY;
    delete process.env.OAUTH_ISSUER;
    delete process.env.OAUTH_RESOURCE;
    process.env.OAUTH_STORE = "memory";
    process.env.OAUTH_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64url");
    resetOAuthForTests();
    setApiKeyCheckerForTests(async (apiKey) => {
        if (apiKey === API_KEY) {
            return { ok: true };
        }
        return { ok: false, message: "That API key was rejected." };
    });
    const server = await startHttpServer({ host: "127.0.0.1", port: 0 });
    try {
        await fn(server);
    } finally {
        await server.close();
        setApiKeyCheckerForTests(null);
        resetOAuthForTests();
        restoreEnv("OAUTH_ISSUER", previousIssuer);
        restoreEnv("OAUTH_RESOURCE", previousResource);
        restoreEnv("OAUTH_STORE", previousStore);
        restoreEnv("OAUTH_ENCRYPTION_KEY", previousKey);
    }
}

async function register(port, redirectUri) {
    const response = await fetch(`http://127.0.0.1:${port}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            client_name: "oauth-test",
            redirect_uris: [redirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
        }),
    });
    assert.equal(response.status, 201);
    return response.json();
}

async function authorizeAndToken(port, redirectUri) {
    const client = await register(port, redirectUri);
    const { verifier, challenge } = pkce();
    const state = "state-1";
    const resource = `http://127.0.0.1:${port}/mcp`;
    const authorizeUrl = new URL(`http://127.0.0.1:${port}/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", client.client_id);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("scope", "mcp offline_access");
    authorizeUrl.searchParams.set("resource", resource);

    const page = await fetch(authorizeUrl);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Desearch API key/);
    assert.match(html, /console\.desearch\.ai\/api-keys/);
    assert.equal(html.includes(API_KEY), false);

    const submitted = await fetch(`http://127.0.0.1:${port}/authorize`, {
        method: "POST",
        redirect: "manual",
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: `http://127.0.0.1:${port}`,
        },
        body: new URLSearchParams({
            response_type: "code",
            client_id: client.client_id,
            redirect_uri: redirectUri,
            code_challenge: challenge,
            code_challenge_method: "S256",
            state,
            scope: "mcp offline_access",
            resource,
            api_key: API_KEY,
            decision: "allow",
        }),
    });
    assert.equal(submitted.status, 302);
    const location = new URL(submitted.headers.get("location"));
    assert.equal(location.origin + location.pathname, redirectUri);
    assert.equal(location.searchParams.get("state"), state);
    assert.equal(location.searchParams.get("iss"), `http://127.0.0.1:${port}`);
    assert.equal(location.searchParams.get("code")?.includes(API_KEY), false);
    const code = location.searchParams.get("code");
    assert.ok(code);

    const token = await fetch(`http://127.0.0.1:${port}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: client.client_id,
            code_verifier: verifier,
            resource,
        }),
    });
    assert.equal(token.status, 200);
    const body = await token.json();
    assert.equal(body.token_type, "Bearer");
    assert.equal(body.scope, "mcp offline_access");
    assert.equal(body.access_token.includes(API_KEY), false);
    assert.equal(body.refresh_token.includes(API_KEY), false);
    assert.equal(body.access_token.startsWith("dsoat_"), true);
    assert.notEqual(body.access_token.split(".").length, 3);
    return { client, resource, body, code, verifier };
}

test("protected resource and authorization server metadata", async () => {
    await withServer(async (server) => {
        const origin = `http://127.0.0.1:${server.port}`;
        const resourceDoc = await fetch(`${origin}/.well-known/oauth-protected-resource`);
        assert.equal(resourceDoc.status, 200);
        const resource = await resourceDoc.json();
        assert.equal(resource.resource, `${origin}/mcp`);
        assert.deepEqual(resource.authorization_servers, [origin]);
        assert.deepEqual(resource.scopes_supported, ["mcp", "offline_access"]);
        assert.deepEqual(resource.bearer_methods_supported, ["header"]);

        const pathDoc = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
        assert.deepEqual(await pathDoc.json(), resource);

        const authorization = await fetch(`${origin}/.well-known/oauth-authorization-server`);
        const metadata = await authorization.json();
        assert.equal(metadata.issuer, origin);
        assert.equal(metadata.authorization_endpoint, `${origin}/authorize`);
        assert.equal(metadata.token_endpoint, `${origin}/token`);
        assert.equal(metadata.registration_endpoint, `${origin}/register`);
        assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
        assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ["none"]);
        assert.equal(metadata.authorization_response_iss_parameter_supported, true);
        assert.equal(metadata.client_id_metadata_document_supported, undefined);
        assert.deepEqual(metadata.grant_types_supported, ["authorization_code", "refresh_token"]);

        const alias = await fetch(`${origin}/.well-known/openid-configuration`);
        assert.deepEqual(await alias.json(), metadata);

        const denied = await fetch(`${origin}/mcp`, {
            method: "POST",
            headers: MCP_HEADERS,
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: "search", arguments: { query: "should-not-run" } },
            }),
        });
        assert.equal(denied.status, 401);
        assert.equal(
            denied.headers.get("www-authenticate"),
            `Bearer realm="Desearch", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="mcp"`
        );
    });
});

test("dynamic client registration accepts hosted callbacks and rejects others", async () => {
    await withServer(async (server) => {
        const origin = `http://127.0.0.1:${server.port}`;
        const allowed = [
            "https://claude.ai/api/mcp/auth_callback",
            "https://claude.com/api/mcp/auth_callback",
            "https://chatgpt.com/connector_platform_oauth_redirect",
            "https://chatgpt.com/connector/oauth/cb_123",
            "http://127.0.0.1:4312/callback",
            "http://localhost:5999/callback/codex",
        ];
        for (const redirectUri of allowed) {
            const response = await fetch(`${origin}/register`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "probe" }),
            });
            assert.equal(response.status, 201, redirectUri);
            const body = await response.json();
            assert.equal(typeof body.client_id, "string");
            assert.equal(body.client_secret, undefined);
            assert.equal(body.token_endpoint_auth_method, "none");
        }

        const rejected = await fetch(`${origin}/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ redirect_uris: ["https://evil.example/callback"] }),
        });
        assert.equal(rejected.status, 400);
        const error = await rejected.json();
        assert.equal(error.error, "invalid_redirect_uri");
        assert.equal(JSON.stringify(error).includes("evil.example"), false);

        const lookalike = await fetch(`${origin}/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ redirect_uris: ["https://chatgpt.com.evil.example/connector/oauth/cb"] }),
        });
        assert.equal(lookalike.status, 400);
    });
});

test("authorization code PKCE issues an opaque token that calls the server", async () => {
    await withServer(async (server) => {
        const origin = `http://127.0.0.1:${server.port}`;
        const redirectUri = "https://claude.ai/api/mcp/auth_callback";
        const issued = await authorizeAndToken(server.port, redirectUri);

        const listed = await fetch(`${origin}/mcp`, {
            method: "POST",
            headers: { ...MCP_HEADERS, authorization: `Bearer ${issued.body.access_token}` },
            body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
        });
        assert.equal(listed.status, 200);
        const tools = await listed.json();
        const names = tools.result.tools.map((tool) => tool.name);
        assert.equal(names.includes("search"), true);
        assert.equal(names.includes("fetch"), true);
        const expectedSchemes = [{ type: "oauth2", scopes: ["mcp"] }];
        assert.equal(tools.result.tools.length, 22);
        for (const tool of tools.result.tools) {
            assert.deepEqual(tool.securitySchemes, expectedSchemes, tool.name);
            assert.deepEqual(tool._meta.securitySchemes, expectedSchemes, tool.name);
        }

        const rawKey = await fetch(`${origin}/mcp`, {
            method: "POST",
            headers: { ...MCP_HEADERS, authorization: `Bearer ${API_KEY}` },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 3,
                method: "initialize",
                params: {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    clientInfo: { name: "oauth", version: "0.0.1" },
                },
            }),
        });
        assert.equal(rawKey.status, 200);
        assert.equal((await rawKey.json()).result.serverInfo.name, "Desearch");

        const reused = await fetch(`${origin}/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                code: issued.code,
                redirect_uri: redirectUri,
                client_id: issued.client.client_id,
                code_verifier: issued.verifier,
                resource: issued.resource,
            }),
        });
        assert.equal(reused.status, 400);
        assert.equal((await reused.json()).error, "invalid_grant");
    });
});

test("wrong PKCE verifier is invalid_grant and the code cannot be retried", async () => {
    await withServer(async (server) => {
        const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
        const client = await register(server.port, redirectUri);
        const { verifier, challenge } = pkce();
        const resource = `http://127.0.0.1:${server.port}/mcp`;
        const state = "pkce-state";
        const submitted = await fetch(`http://127.0.0.1:${server.port}/authorize`, {
            method: "POST",
            redirect: "manual",
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                origin: `http://127.0.0.1:${server.port}`,
            },
            body: new URLSearchParams({
                response_type: "code",
                client_id: client.client_id,
                redirect_uri: redirectUri,
                code_challenge: challenge,
                code_challenge_method: "S256",
                state,
                resource,
                api_key: API_KEY,
                decision: "allow",
            }),
        });
        const code = new URL(submitted.headers.get("location")).searchParams.get("code");
        const wrong = await fetch(`http://127.0.0.1:${server.port}/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                code,
                redirect_uri: redirectUri,
                client_id: client.client_id,
                code_verifier: randomBytes(32).toString("base64url"),
                resource,
            }),
        });
        assert.equal(wrong.status, 400);
        assert.equal((await wrong.json()).error, "invalid_grant");

        const retry = await fetch(`http://127.0.0.1:${server.port}/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                code,
                redirect_uri: redirectUri,
                client_id: client.client_id,
                code_verifier: verifier,
                resource,
            }),
        });
        assert.equal(retry.status, 400);
        assert.equal((await retry.json()).error, "invalid_grant");
    });
});

test("refresh rotates tokens and reuse revokes the grant", async () => {
    await withServer(async (server) => {
        const origin = `http://127.0.0.1:${server.port}`;
        const issued = await authorizeAndToken(server.port, "https://claude.com/api/mcp/auth_callback");
        const refreshed = await fetch(`${origin}/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: issued.body.refresh_token,
                client_id: issued.client.client_id,
                resource: issued.resource,
            }),
        });
        assert.equal(refreshed.status, 200);
        const next = await refreshed.json();
        assert.notEqual(next.access_token, issued.body.access_token);
        assert.notEqual(next.refresh_token, issued.body.refresh_token);
        assert.equal(next.access_token.includes(API_KEY), false);

        const listed = await fetch(`${origin}/mcp`, {
            method: "POST",
            headers: { ...MCP_HEADERS, authorization: `Bearer ${next.access_token}` },
            body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
        });
        assert.equal(listed.status, 200);

        const reused = await fetch(`${origin}/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: issued.body.refresh_token,
                client_id: issued.client.client_id,
            }),
        });
        assert.equal(reused.status, 400);
        assert.equal((await reused.json()).error, "invalid_grant");

        const revoked = await fetch(`${origin}/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: next.refresh_token,
                client_id: issued.client.client_id,
            }),
        });
        assert.equal(revoked.status, 400);
        assert.equal((await revoked.json()).error, "invalid_grant");

        const afterRevoke = await fetch(`${origin}/mcp`, {
            method: "POST",
            headers: { ...MCP_HEADERS, authorization: `Bearer ${next.access_token}` },
            body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "search", arguments: { query: "x" } } }),
        });
        assert.equal(afterRevoke.status, 401);
    });
});

test("an invalid API key does not issue a code or echo the key", async () => {
    await withServer(async (server) => {
        const redirectUri = "https://chatgpt.com/connector/oauth/callback-9";
        const client = await register(server.port, redirectUri);
        const { challenge } = pkce();
        const secret = "dt_rejected_key_value";
        const submitted = await fetch(`http://127.0.0.1:${server.port}/authorize`, {
            method: "POST",
            redirect: "manual",
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                origin: `http://127.0.0.1:${server.port}`,
            },
            body: new URLSearchParams({
                response_type: "code",
                client_id: client.client_id,
                redirect_uri: redirectUri,
                code_challenge: challenge,
                code_challenge_method: "S256",
                state: "bad-key",
                resource: `http://127.0.0.1:${server.port}/mcp`,
                api_key: secret,
                decision: "allow",
            }),
        });
        assert.equal(submitted.status, 400);
        assert.equal(submitted.headers.get("location"), null);
        const html = await submitted.text();
        assert.match(html, /rejected/);
        assert.equal(html.includes(secret), false);
    });
});

test("key validation accepts only HTTP 422", async () => {
    const previous = process.env.DESEARCH_API_BASE;
    process.env.DESEARCH_API_BASE = "https://api.desearch.ai";
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => {
        warnings.push(String(message));
    };
    try {
        const calls = [];
        const statuses = new Map([
            ["dt_ok", 422],
            ["dt_nope", 401],
            ["fake-forbid", 403],
            ["dt_paid", 402],
            ["dt_http200", 200],
            ["dt_down", 500],
            ["dt_limit", 429],
        ]);
        const fakeFetch = async (url, init) => {
            const authorization = init.headers.Authorization;
            calls.push({ url: String(url), authorization });
            const status = statuses.get(authorization);
            return new Response(JSON.stringify({ echo: authorization }), { status });
        };
        assert.equal((await validateDesearchApiKey("dt_ok", fakeFetch)).ok, true);
        const rejected = await validateDesearchApiKey("dt_nope", fakeFetch);
        assert.equal(rejected.ok, false);
        assert.match(rejected.message, /rejected/);
        const forbidden = await validateDesearchApiKey("fake-forbid", fakeFetch);
        assert.equal(forbidden.ok, false);
        assert.match(forbidden.message, /rejected/);
        for (const key of ["dt_paid", "dt_http200", "dt_down", "dt_limit"]) {
            const result = await validateDesearchApiKey(key, fakeFetch);
            assert.equal(result.ok, false, key);
            assert.match(result.message, /Could not verify/);
            assert.equal(result.message.includes(key), false);
        }
        assert.equal(calls.length, 7);
        assert.match(calls[0].url, /\/twitter\/trends\?woeid=1&count=1$/);
        assert.equal(calls[0].authorization, "dt_ok");
        assert.equal(warnings.length, 4);
        const logged = warnings.join("\n");
        assert.match(logged, /HTTP 402/);
        assert.match(logged, /HTTP 200/);
        assert.match(logged, /HTTP 500/);
        assert.match(logged, /HTTP 429/);
        for (const key of statuses.keys()) {
            assert.equal(logged.includes(key), false, key);
        }
        assert.equal(logged.includes("echo"), false);
    } finally {
        console.warn = originalWarn;
        restoreEnv("DESEARCH_API_BASE", previous);
    }
});

test("redis storage without REDIS_URL fails closed", async () => {
    const previousStore = process.env.OAUTH_STORE;
    const previousUrl = process.env.REDIS_URL;
    const previousKey = process.env.OAUTH_ENCRYPTION_KEY;
    process.env.OAUTH_STORE = "redis";
    delete process.env.REDIS_URL;
    process.env.OAUTH_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64url");
    resetOAuthForTests();
    try {
        await assert.rejects(getOAuthStore(), /REDIS_URL/);
    } finally {
        resetOAuthForTests();
        restoreEnv("OAUTH_STORE", previousStore);
        restoreEnv("REDIS_URL", previousUrl);
        restoreEnv("OAUTH_ENCRYPTION_KEY", previousKey);
    }
});

test("vercel function entries serve both protected resource documents", async () => {
    const previousIssuer = process.env.OAUTH_ISSUER;
    process.env.OAUTH_ISSUER = "https://mcp.desearch.ai";
    try {
        const root = await protectedResource.fetch(
            new Request("https://mcp.desearch.ai/api/oauth-protected-resource")
        );
        assert.equal(root.status, 200);
        const body = await root.json();
        assert.equal(body.resource, "https://mcp.desearch.ai/mcp");
        assert.deepEqual(body.authorization_servers, ["https://mcp.desearch.ai"]);

        const nested = await protectedResourceMcp.fetch(
            new Request("https://example.vercel.app/api/oauth-protected-resource-mcp", {
                headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" },
            })
        );
        const nestedBody = await nested.json();
        assert.equal(nestedBody.resource, "https://mcp.desearch.ai/mcp");
        assert.equal(JSON.stringify(nestedBody).includes("evil.example"), false);
    } finally {
        restoreEnv("OAUTH_ISSUER", previousIssuer);
    }
});

test("issuer ignores X-Forwarded-Host", async () => {
    await withServer(async (server) => {
        const origin = `http://127.0.0.1:${server.port}`;
        const response = await fetch(`${origin}/.well-known/oauth-authorization-server`, {
            headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" },
        });
        assert.equal(response.status, 200);
        const metadata = await response.json();
        assert.equal(metadata.issuer, origin);
        assert.equal(metadata.authorization_endpoint, `${origin}/authorize`);
        assert.equal(JSON.stringify(metadata).includes("evil.example"), false);

        const resourceDoc = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`, {
            headers: { "x-forwarded-host": "evil.example" },
        });
        const resource = await resourceDoc.json();
        assert.equal(resource.resource, `${origin}/mcp`);
        assert.equal(JSON.stringify(resource).includes("evil.example"), false);
    });
});

test("production refuses a missing issuer and the in-memory store", async () => {
    const previousNode = process.env.NODE_ENV;
    const previousVercel = process.env.VERCEL;
    const previousIssuer = process.env.OAUTH_ISSUER;
    const previousResource = process.env.OAUTH_RESOURCE;
    const previousStore = process.env.OAUTH_STORE;
    if (process.env.NODE_ENV !== "production") {
        resetOAuthForTests();
    }
    delete process.env.OAUTH_ISSUER;
    delete process.env.OAUTH_RESOURCE;
    delete process.env.VERCEL;
    process.env.NODE_ENV = "production";
    process.env.OAUTH_STORE = "memory";
    const server = await startHttpServer({ host: "127.0.0.1", port: 0 });
    try {
        await assert.rejects(() => getOAuthStore(), /OAUTH_STORE must be redis/);
        const metadata = await fetch(
            `http://127.0.0.1:${server.port}/.well-known/oauth-authorization-server`,
            { headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" } }
        );
        assert.equal(metadata.status, 500);
        assert.equal((await metadata.text()).includes("evil.example"), false);

        const denied = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
            method: "POST",
            headers: { ...MCP_HEADERS, "x-forwarded-host": "evil.example" },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: "search", arguments: { query: "x" } },
            }),
        });
        assert.equal(denied.status, 500);
        assert.equal((await denied.text()).includes("evil.example"), false);

        delete process.env.NODE_ENV;
        process.env.VERCEL = "1";
        await assert.rejects(() => getOAuthStore(), /OAUTH_STORE must be redis/);
        const vercelMetadata = await fetch(
            `http://127.0.0.1:${server.port}/.well-known/oauth-protected-resource`,
            { headers: { "x-forwarded-host": "evil.example" } }
        );
        assert.equal(vercelMetadata.status, 500);
        assert.equal((await vercelMetadata.text()).includes("evil.example"), false);

        process.env.OAUTH_ISSUER = "https://mcp.desearch.ai";
        const configured = await fetch(
            `http://127.0.0.1:${server.port}/.well-known/oauth-authorization-server`,
            { headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" } }
        );
        assert.equal(configured.status, 200);
        const configuredBody = await configured.json();
        assert.equal(configuredBody.issuer, "https://mcp.desearch.ai");
        assert.equal(JSON.stringify(configuredBody).includes("evil.example"), false);
        await assert.rejects(() => getOAuthStore(), /OAUTH_STORE must be redis/);
    } finally {
        await server.close();
        restoreEnv("NODE_ENV", previousNode);
        restoreEnv("VERCEL", previousVercel);
        restoreEnv("OAUTH_ISSUER", previousIssuer);
        restoreEnv("OAUTH_RESOURCE", previousResource);
        restoreEnv("OAUTH_STORE", previousStore);
        if (process.env.NODE_ENV !== "production") {
            resetOAuthForTests();
        }
    }
});

test("a bad access token and a token for another resource are invalid_token", async () => {
    await withServer(async (server) => {
        const origin = `http://127.0.0.1:${server.port}`;
        const issued = await authorizeAndToken(server.port, "https://claude.ai/api/mcp/auth_callback");
        const callBody = JSON.stringify({
            jsonrpc: "2.0",
            id: 9,
            method: "tools/call",
            params: { name: "search", arguments: { query: "x" } },
        });
        const bad = await fetch(`${origin}/mcp`, {
            method: "POST",
            headers: { ...MCP_HEADERS, authorization: "Bearer dsoat_not-a-real-token" },
            body: callBody,
        });
        assert.equal(bad.status, 401);
        const badHeader = bad.headers.get("www-authenticate") ?? "";
        assert.match(badHeader, /error="invalid_token"/);
        assert.match(badHeader, /error_description="The access token is invalid or expired\."/);
        const badBody = await bad.json();
        assert.equal(badBody.result.isError, true);
        assert.match(badBody.result._meta["mcp/www_authenticate"][0], /error="invalid_token"/);

        process.env.OAUTH_RESOURCE = "https://other.example/mcp";
        const wrongAudience = await fetch(`${origin}/mcp`, {
            method: "POST",
            headers: { ...MCP_HEADERS, authorization: `Bearer ${issued.body.access_token}` },
            body: callBody,
        });
        assert.equal(wrongAudience.status, 401);
        assert.match(wrongAudience.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
        const wrongBody = await wrongAudience.json();
        assert.match(wrongBody.result._meta["mcp/www_authenticate"][0], /error="invalid_token"/);
        delete process.env.OAUTH_RESOURCE;

        const restored = await fetch(`${origin}/mcp`, {
            method: "POST",
            headers: { ...MCP_HEADERS, authorization: `Bearer ${issued.body.access_token}` },
            body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
        });
        assert.equal(restored.status, 200);
    });
});

test("keyless tools/call returns the ChatGPT tool error and keeps HTTP 401", async () => {
    await withServer(async (server) => {
        const origin = `http://127.0.0.1:${server.port}`;
        const response = await fetch(`${origin}/mcp`, {
            method: "POST",
            headers: MCP_HEADERS,
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 4,
                method: "tools/call",
                params: { name: "search", arguments: { query: "should-not-run" } },
            }),
        });
        assert.equal(response.status, 401);
        const header = response.headers.get("www-authenticate") ?? "";
        assert.match(header, /resource_metadata=/);
        assert.equal(header.includes("error="), false);
        const body = await response.json();
        assert.equal(body.error, undefined);
        assert.equal(body.result.isError, true);
        assert.equal(body.id, 4);
        const challenge = body.result._meta["mcp/www_authenticate"][0];
        assert.match(challenge, /error="insufficient_scope"/);
        assert.match(challenge, /error_description="You need to login to continue"/);
        assert.match(challenge, new RegExp(`resource_metadata="${origin}/\\.well-known/oauth-protected-resource/mcp"`));
    });
});

test("strict mode requires auth on initialize and leaves tools/list public", async () => {
    await withServer(async (server) => {
        const origin = `http://127.0.0.1:${server.port}`;
        const initialize = {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: "2025-03-26",
                capabilities: {},
                clientInfo: { name: "strict", version: "0.0.1" },
            },
        };
        const open = await fetch(`${origin}/mcp`, {
            method: "POST",
            headers: MCP_HEADERS,
            body: JSON.stringify(initialize),
        });
        assert.equal(open.status, 200);
        assert.equal(open.headers.get("www-authenticate"), null);

        process.env.OAUTH_REQUIRE_AUTH_ON_INITIALIZE = "true";
        try {
            const closed = await fetch(`${origin}/mcp`, {
                method: "POST",
                headers: MCP_HEADERS,
                body: JSON.stringify(initialize),
            });
            assert.equal(closed.status, 401);
            assert.match(
                closed.headers.get("www-authenticate") ?? "",
                new RegExp(`resource_metadata="${origin}/\\.well-known/oauth-protected-resource/mcp"`)
            );
            const tools = await fetch(`${origin}/mcp`, {
                method: "POST",
                headers: MCP_HEADERS,
                body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
            });
            assert.equal(tools.status, 200);
        } finally {
            delete process.env.OAUTH_REQUIRE_AUTH_ON_INITIALIZE;
        }

        const openAgain = await fetch(`${origin}/mcp`, {
            method: "POST",
            headers: MCP_HEADERS,
            body: JSON.stringify(initialize),
        });
        assert.equal(openAgain.status, 200);
    });
});

test("authorize POST rejects a cross-site Origin or Referer", async () => {
    await withServer(async (server) => {
        const origin = `http://127.0.0.1:${server.port}`;
        const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
        const client = await register(server.port, redirectUri);
        const { challenge } = pkce();
        const fields = {
            response_type: "code",
            client_id: client.client_id,
            redirect_uri: redirectUri,
            code_challenge: challenge,
            code_challenge_method: "S256",
            state: "csrf-state",
            resource: `${origin}/mcp`,
            api_key: API_KEY,
            decision: "allow",
        };
        const post = (headers) =>
            fetch(`${origin}/authorize`, {
                method: "POST",
                redirect: "manual",
                headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
                body: new URLSearchParams(fields),
            });

        const crossSite = await post({ origin: "https://evil.example", "sec-fetch-site": "cross-site" });
        assert.equal(crossSite.status, 400);
        assert.equal(crossSite.headers.get("location"), null);
        assert.equal((await crossSite.text()).includes(API_KEY), false);

        const evilOrigin = await post({ origin: "https://evil.example" });
        assert.equal(evilOrigin.status, 400);
        assert.equal(evilOrigin.headers.get("location"), null);

        const evilReferer = await post({ referer: "https://evil.example/phish" });
        assert.equal(evilReferer.status, 400);
        assert.equal(evilReferer.headers.get("location"), null);

        const missing = await fetch(`${origin}/authorize`, {
            method: "POST",
            redirect: "manual",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(fields),
        });
        assert.equal(missing.status, 403);
        assert.equal(missing.headers.get("location"), null);
        assert.equal((await missing.text()).includes(API_KEY), false);

        const sameOrigin = await post({ origin });
        assert.equal(sameOrigin.status, 302);
        const location = new URL(sameOrigin.headers.get("location"));
        assert.equal(location.searchParams.get("state"), "csrf-state");
        assert.ok(location.searchParams.get("code"));

        const sameReferer = await post({ referer: `${origin}/authorize` });
        assert.equal(sameReferer.status, 302);

        const sameFetchSite = await post({ "sec-fetch-site": "same-origin" });
        assert.equal(sameFetchSite.status, 302);
    });
});

test("replaying an authorization code revokes tokens already issued", async () => {
    await withServer(async (server) => {
        const origin = `http://127.0.0.1:${server.port}`;
        const redirectUri = "https://claude.com/api/mcp/auth_callback";
        const issued = await authorizeAndToken(server.port, redirectUri);
        const replay = await fetch(`${origin}/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                code: issued.code,
                redirect_uri: redirectUri,
                client_id: issued.client.client_id,
                code_verifier: issued.verifier,
                resource: issued.resource,
            }),
        });
        assert.equal(replay.status, 400);
        assert.equal((await replay.json()).error, "invalid_grant");

        const revoked = await fetch(`${origin}/mcp`, {
            method: "POST",
            headers: { ...MCP_HEADERS, authorization: `Bearer ${issued.body.access_token}` },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 6,
                method: "tools/call",
                params: { name: "search", arguments: { query: "x" } },
            }),
        });
        assert.equal(revoked.status, 401);
        assert.match(revoked.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
    });
});

test("concurrent refresh of one token cannot both succeed", async () => {
    await withServer(async (server) => {
        const issued = await authorizeAndToken(server.port, "https://claude.ai/api/mcp/auth_callback");
        const store = await getOAuthStore();
        const options = {
            clientId: issued.client.client_id,
            canonicalResource: issued.resource,
            presentedResource: null,
        };
        const [first, second] = await Promise.all([
            store.rotateRefresh(issued.body.refresh_token, options),
            store.rotateRefresh(issued.body.refresh_token, options),
        ]);
        const winners = [first, second].filter((result) => result.ok);
        assert.ok(winners.length <= 1);
        for (const winner of winners) {
            assert.equal(await store.getAccess(winner.accessToken), null);
            const follow = await store.rotateRefresh(winner.refreshToken, options);
            assert.equal(follow.ok, false);
        }
        assert.equal(await store.getAccess(issued.body.access_token), null);
        const again = await store.rotateRefresh(issued.body.refresh_token, options);
        assert.equal(again.ok, false);
    });
});

test("every tools/list entry carries oauth securitySchemes", async () => {
    await withServer(async (server) => {
        const origin = `http://127.0.0.1:${server.port}`;
        const expected = [{ type: "oauth2", scopes: ["mcp"] }];
        const listed = await fetch(`${origin}/mcp`, {
            method: "POST",
            headers: MCP_HEADERS,
            body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
        });
        assert.equal(listed.status, 200);
        const tools = (await listed.json()).result.tools;
        assert.equal(tools.length, 22);
        for (const tool of tools) {
            assert.deepEqual(tool.securitySchemes, expected, tool.name);
            assert.deepEqual(tool._meta.securitySchemes, expected, tool.name);
        }

        const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`));
        const client = new Client({ name: "security-schemes", version: "0.0.1" });
        try {
            await client.connect(transport);
            const viaSdk = await client.listTools();
            assert.equal(viaSdk.tools.length, tools.length);
            for (const tool of viaSdk.tools) {
                assert.deepEqual(tool._meta.securitySchemes, expected, tool.name);
            }
        } finally {
            await client.close();
        }
    });
});

test("register and authorize key checks return 429 after the per-IP limit", async () => {
    const previous = {
        registerLimit: process.env.OAUTH_REGISTER_RATE_LIMIT,
        registerWindow: process.env.OAUTH_REGISTER_RATE_WINDOW_SEC,
        authorizeLimit: process.env.OAUTH_AUTHORIZE_RATE_LIMIT,
        authorizeWindow: process.env.OAUTH_AUTHORIZE_RATE_WINDOW_SEC,
    };
    process.env.OAUTH_REGISTER_RATE_LIMIT = "2";
    process.env.OAUTH_REGISTER_RATE_WINDOW_SEC = "3600";
    process.env.OAUTH_AUTHORIZE_RATE_LIMIT = "2";
    process.env.OAUTH_AUTHORIZE_RATE_WINDOW_SEC = "600";
    try {
        await withServer(async (server) => {
            const origin = `http://127.0.0.1:${server.port}`;
            const redirectUri = "https://claude.ai/api/mcp/auth_callback";
            const postRegister = (headers = {}) =>
                fetch(`${origin}/register`, {
                    method: "POST",
                    headers: { "content-type": "application/json", ...headers },
                    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "limit" }),
                });
            const first = await postRegister();
            assert.equal(first.status, 201);
            const client = await first.json();
            assert.equal((await postRegister()).status, 201);
            const limited = await postRegister({ "x-forwarded-for": "203.0.113.50, 10.0.0.4" });
            assert.equal(limited.status, 429);
            const retryAfter = Number(limited.headers.get("retry-after"));
            assert.equal(Number.isInteger(retryAfter), true);
            assert.ok(retryAfter >= 1 && retryAfter <= 3600);
            const payload = await limited.json();
            assert.equal(payload.error, "temporarily_unavailable");
            assert.equal(JSON.stringify(payload).includes("203.0.113.50"), false);

            let checks = 0;
            setApiKeyCheckerForTests(async (apiKey) => {
                checks += 1;
                assert.equal(apiKey, API_KEY);
                return { ok: true };
            });
            const { challenge } = pkce();
            const fields = {
                response_type: "code",
                client_id: client.client_id,
                redirect_uri: redirectUri,
                code_challenge: challenge,
                code_challenge_method: "S256",
                state: "rate-state",
                resource: `${origin}/mcp`,
                api_key: API_KEY,
                decision: "allow",
            };
            const postAuthorize = (headers = {}) =>
                fetch(`${origin}/authorize`, {
                    method: "POST",
                    redirect: "manual",
                    headers: {
                        "content-type": "application/x-www-form-urlencoded",
                        origin,
                        ...headers,
                    },
                    body: new URLSearchParams(fields),
                });
            assert.equal((await postAuthorize()).status, 302);
            assert.equal((await postAuthorize()).status, 302);
            const slowed = await postAuthorize({ "x-forwarded-for": "198.51.100.20" });
            assert.equal(slowed.status, 429);
            const authorizeRetry = Number(slowed.headers.get("retry-after"));
            assert.equal(Number.isInteger(authorizeRetry), true);
            assert.ok(authorizeRetry >= 1 && authorizeRetry <= 600);
            const html = await slowed.text();
            assert.match(html, /Too many sign-in attempts/);
            assert.equal(html.includes(API_KEY), false);
            assert.equal(checks, 2);
        });
    } finally {
        restoreEnv("OAUTH_REGISTER_RATE_LIMIT", previous.registerLimit);
        restoreEnv("OAUTH_REGISTER_RATE_WINDOW_SEC", previous.registerWindow);
        restoreEnv("OAUTH_AUTHORIZE_RATE_LIMIT", previous.authorizeLimit);
        restoreEnv("OAUTH_AUTHORIZE_RATE_WINDOW_SEC", previous.authorizeWindow);
    }
});

test("dynamic clients expire after 90 days", async () => {
    const previous = process.env.OAUTH_CLIENT_TTL_SEC;
    delete process.env.OAUTH_CLIENT_TTL_SEC;
    try {
        assert.equal(clientTtlSec(), 90 * 24 * 60 * 60);
        const writes = [];
        const store = new KvOAuthStore({
            async set(key, value, ttlSec) {
                writes.push({ key, value, ttlSec });
            },
            async get() {
                return null;
            },
            async getDel() {
                return null;
            },
            async del() {},
            async consumeAuthCode() {
                return { status: "missing" };
            },
            async commitAuthCode() {
                return "committed";
            },
            async claimRefresh() {
                return { status: "invalid" };
            },
            async increment() {
                return 1;
            },
        });
        await store.saveClient({
            clientId: "dsocid_ttl",
            clientName: "ttl",
            redirectUris: ["http://127.0.0.1:9/callback"],
            tokenEndpointAuthMethod: "none",
            createdAt: 1,
        });
        assert.equal(writes.length, 1);
        assert.equal(writes[0].ttlSec, 90 * 24 * 60 * 60);
        assert.equal(writes[0].key.includes("dsocid_ttl"), true);
        assert.notEqual(writes[0].ttlSec, 60 * 60 * 24 * 365 * 2);

        process.env.OAUTH_CLIENT_TTL_SEC = "7200";
        assert.equal(clientTtlSec(), 7200);
    } finally {
        restoreEnv("OAUTH_CLIENT_TTL_SEC", previous);
    }
});

test("vercel rate limits use the first x-forwarded-for hop", async () => {
    const previousVercel = process.env.VERCEL;
    process.env.VERCEL = "1";
    try {
        const store = memoryStoreForTests();
        const first = clientIp(
            new Request("https://mcp.desearch.ai/register", {
                headers: { "x-forwarded-for": "203.0.113.4, 10.0.0.2" },
            })
        );
        const second = clientIp(
            new Request("https://mcp.desearch.ai/register", {
                headers: { "x-forwarded-for": "198.51.100.7, 10.0.0.2" },
            })
        );
        const ignoresDirect = clientIp(
            new Request("https://mcp.desearch.ai/register", {
                headers: {
                    "x-forwarded-for": "203.0.113.4",
                    "x-desearch-remote-address": "198.51.100.9",
                },
            })
        );
        assert.equal(first, "203.0.113.4");
        assert.equal(second, "198.51.100.7");
        assert.equal(ignoresDirect, "203.0.113.4");
        assert.equal((await store.consumeRateLimit("register", first, 1, 3600)).allowed, true);
        const blocked = await store.consumeRateLimit("register", first, 1, 3600);
        assert.equal(blocked.allowed, false);
        assert.ok(blocked.retryAfterSec >= 1 && blocked.retryAfterSec <= 3600);
        assert.equal((await store.consumeRateLimit("register", second, 1, 3600)).allowed, true);

        delete process.env.VERCEL;
        assert.equal(
            clientIp(
                new Request("https://mcp.desearch.ai/register", {
                    headers: { "x-forwarded-for": "203.0.113.4" },
                })
            ),
            "unknown"
        );
        assert.equal(
            clientIp(
                new Request("https://mcp.desearch.ai/register", {
                    headers: {
                        "x-forwarded-for": "203.0.113.4",
                        "x-desearch-remote-address": "127.0.0.1",
                    },
                })
            ),
            "127.0.0.1"
        );
    } finally {
        restoreEnv("VERCEL", previousVercel);
    }
});

test("redis rate limit counter uses the store increment", async () => {
    const counts = new Map();
    const expires = new Map();
    const kv = redisKvForTests({
        async get() {
            return null;
        },
        async getDel() {
            return null;
        },
        async set() {},
        async del() {},
        async eval(script, options) {
            assert.match(script, /INCR/);
            assert.match(script, /EXPIRE/);
            const key = options.keys[0];
            const ttl = Number(options.arguments[0]);
            const next = (counts.get(key) ?? 0) + 1;
            counts.set(key, next);
            if (next === 1) {
                expires.set(key, ttl);
            }
            return next;
        },
        async consumeAuthCode() {
            return { status: "missing" };
        },
        async commitAuthCode() {
            return "committed";
        },
        async claimRefresh() {
            return { status: "invalid" };
        },
    });
    const store = new KvOAuthStore(kv);
    const first = await store.consumeRateLimit("register", "203.0.113.4", 1, 3600);
    const second = await store.consumeRateLimit("register", "203.0.113.4", 1, 3600);
    assert.equal(first.allowed, true);
    assert.equal(second.allowed, false);
    assert.ok(second.retryAfterSec >= 1 && second.retryAfterSec <= 3600);
    assert.deepEqual([...expires.values()], [3600]);
    assert.equal(counts.size, 1);
});
