import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import challenge from "../api/openai-apps-challenge.js";
import { handleMcpHttpRequest } from "../build/http.js";

const pathname = "/.well-known/openai-apps-challenge";

async function withToken(value, fn) {
    const previous = process.env.OPENAI_APPS_CHALLENGE_TOKEN;
    if (value === undefined) delete process.env.OPENAI_APPS_CHALLENGE_TOKEN;
    else process.env.OPENAI_APPS_CHALLENGE_TOKEN = value;
    try {
        await fn();
    } finally {
        if (previous === undefined) delete process.env.OPENAI_APPS_CHALLENGE_TOKEN;
        else process.env.OPENAI_APPS_CHALLENGE_TOKEN = previous;
    }
}

function request(method = "GET", path = pathname) {
    return new Request(`https://mcp.desearch.ai${path}`, { method });
}

test("unconfigured and placeholder challenge tokens return the unknown-route response", async () => {
    for (const value of [undefined, "", " \n ", " REPLACE_WITH_OPENAI_APPS_CHALLENGE_TOKEN "]) {
        await withToken(value, async () => {
            const response = await handleMcpHttpRequest(request());
            const unknown = await handleMcpHttpRequest(request("GET", "/unknown"));
            assert.equal(response.status, 404);
            assert.equal(await response.text(), await unknown.text());
        });
    }
});

test("challenge GET serves the exact trimmed env token without authentication", async () => {
    await withToken("  verification-token-123\n", async () => {
        for (const path of [pathname, "/api/openai-apps-challenge"]) {
            const response = await handleMcpHttpRequest(request("GET", path));
            assert.equal(response.status, 200);
            assert.equal(await response.text(), "verification-token-123");
            assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
            assert.equal(response.headers.get("cache-control"), "no-store");
        }
        const wrapped = await challenge.fetch(request("GET", "/api/openai-apps-challenge"));
        assert.equal(wrapped.status, 200);
        assert.equal(await wrapped.text(), "verification-token-123");
    });
});

test("challenge HEAD has no body and unsupported methods return 405", async () => {
    await withToken("verification-token", async () => {
        const head = await handleMcpHttpRequest(request("HEAD"));
        assert.equal(head.status, 200);
        assert.equal(await head.text(), "");
        assert.equal(head.headers.get("content-type"), "text/plain; charset=utf-8");
        assert.equal(head.headers.get("cache-control"), "no-store");
        for (const method of ["POST", "PUT", "DELETE"]) {
            const response = await handleMcpHttpRequest(request(method));
            assert.equal(response.status, 405);
            assert.equal(response.headers.get("allow"), "GET, HEAD");
        }
    });
});

test("challenge OPTIONS follows public route CORS handling", async () => {
    await withToken(undefined, async () => {
        const response = await handleMcpHttpRequest(request("OPTIONS"));
        const health = await handleMcpHttpRequest(request("OPTIONS", "/health"));
        assert.equal(response.status, 204);
        assert.equal(await response.text(), "");
        assert.deepEqual([...response.headers], [...health.headers]);
    });
});

test("Vercel routes the challenge to its API entry point", () => {
    const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
    assert.ok(config.rewrites.some(({ source, destination }) =>
        source === pathname && destination === "/api/openai-apps-challenge"));
    assert.ok(existsSync(new URL("../api/openai-apps-challenge.js", import.meta.url)));
});
