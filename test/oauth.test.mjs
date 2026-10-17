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
import { getOAuthStore } from "../build/oauth/store.js";

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
        headers: { "content-type": "application/x-www-form-urlencoded" },
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
        const search = tools.result.tools.find((tool) => tool.name === "search");
        assert.deepEqual(search.securitySchemes, [{ type: "oauth2", scopes: ["mcp"] }]);

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
            headers: { "content-type": "application/x-www-form-urlencoded" },
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
            headers: { "content-type": "application/x-www-form-urlencoded" },
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

test("key validation treats 422 and 402 as a real key and 401 or 403 as a rejection", async () => {
    const previous = process.env.DESEARCH_API_BASE;
    process.env.DESEARCH_API_BASE = "https://api.desearch.ai";
    try {
        const calls = [];
        const fakeFetch = async (url, init) => {
            calls.push({ url: String(url), authorization: init.headers.Authorization });
            const status = init.headers.Authorization.endsWith("ok")
                ? 422
                : init.headers.Authorization.endsWith("empty")
                  ? 402
                  : init.headers.Authorization.endsWith("forbid")
                    ? 403
                    : 401;
            return new Response("{}", { status });
        };
        assert.equal((await validateDesearchApiKey("dt_ok", fakeFetch)).ok, true);
        assert.equal((await validateDesearchApiKey("dsr_empty", fakeFetch)).ok, true);
        assert.equal((await validateDesearchApiKey("dt_nope", fakeFetch)).ok, false);
        assert.equal((await validateDesearchApiKey("fake-forbid", fakeFetch)).ok, false);
        assert.equal(calls.length, 4);
        assert.match(calls[0].url, /\/twitter\/trends\?woeid=1&count=1$/);
        assert.equal(calls[0].authorization, "dt_ok");
    } finally {
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
            new Request("https://example.vercel.app/api/oauth-protected-resource-mcp")
        );
        assert.equal((await nested.json()).resource, "https://mcp.desearch.ai/mcp");
    } finally {
        restoreEnv("OAUTH_ISSUER", previousIssuer);
    }
});
