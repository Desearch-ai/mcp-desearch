import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import verification from "../api/mcpbundles.js";
import { handleMcpHttpRequest } from "../build/http.js";

const pathname = "/.well-known/mcpbundles.json";
const alias = "/api/mcpbundles";
const expected = { maintainers: [{ email: "dev@desearch.ai" }] };

function request(method = "GET", path = pathname) {
    return new Request(`https://mcp.desearch.ai${path}`, { method });
}

test("MCPBundles GET serves the exact JSON without authentication", async () => {
    for (const path of [pathname, alias]) {
        for (const handler of [handleMcpHttpRequest, verification.fetch]) {
            const response = await handler(request("GET", path));
            assert.equal(response.status, 200);
            assert.equal(response.headers.get("content-type"), "application/json");
            assert.equal(response.headers.get("cache-control"), "no-store");
            const body = await response.text();
            assert.equal(body, JSON.stringify(expected));
            assert.deepEqual(JSON.parse(body), expected);
        }
    }
});

test("MCPBundles HEAD has no body and unsupported methods return 405", async () => {
    for (const path of [pathname, alias]) {
        for (const handler of [handleMcpHttpRequest, verification.fetch]) {
            const head = await handler(request("HEAD", path));
            assert.equal(head.status, 200);
            assert.equal(await head.text(), "");
            assert.equal(head.headers.get("content-type"), "application/json");
            assert.equal(head.headers.get("cache-control"), "no-store");
            for (const method of ["POST", "PUT", "DELETE"]) {
                const response = await handler(request(method, path));
                assert.equal(response.status, 405);
                assert.equal(response.headers.get("allow"), "GET, HEAD");
            }
        }
    }
});

test("MCPBundles OPTIONS follows public route CORS handling", async () => {
    for (const path of [pathname, alias]) {
        for (const handler of [handleMcpHttpRequest, verification.fetch]) {
            const response = await handler(request("OPTIONS", path));
            const health = await handleMcpHttpRequest(request("OPTIONS", "/health"));
            assert.equal(response.status, 204);
            assert.equal(await response.text(), "");
            assert.deepEqual([...response.headers], [...health.headers]);
        }
    }
});

test("Vercel routes MCPBundles verification to its API entry point", () => {
    const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
    assert.ok(config.rewrites.some(({ source, destination }) =>
        source === pathname && destination === alias));
    assert.ok(existsSync(new URL("../api/mcpbundles.js", import.meta.url)));
});
