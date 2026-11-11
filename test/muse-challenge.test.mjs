import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import verification from "../api/muse-challenge.js";
import { handleMcpHttpRequest } from "../build/http.js";

const pathname = "/.well-known/muse-challenge/a68cf22bcf914c4484bf5adb84ba1401604f2374615d870b51ef7414a681fd7e";
const alias = "/api/muse-challenge";
const expected = "muse-challenge=a68cf22bcf914c4484bf5adb84ba1401604f2374615d870b51ef7414a681fd7e";

function request(method = "GET", path = pathname) {
    return new Request(`https://mcp.desearch.ai${path}`, { method });
}

test("Muse challenge GET serves the exact plain text without authentication", async () => {
    for (const path of [pathname, alias]) {
        for (const handler of [handleMcpHttpRequest, verification.fetch]) {
            const response = await handler(request("GET", path));
            assert.equal(response.status, 200);
            assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
            assert.equal(response.headers.get("cache-control"), "no-store");
            const body = await response.text();
            assert.equal(body, expected);
        }
    }
});

test("Muse challenge HEAD has no body and unsupported methods return 405", async () => {
    for (const path of [pathname, alias]) {
        for (const handler of [handleMcpHttpRequest, verification.fetch]) {
            const head = await handler(request("HEAD", path));
            assert.equal(head.status, 200);
            assert.equal(await head.text(), "");
            assert.equal(head.headers.get("content-type"), "text/plain; charset=utf-8");
            assert.equal(head.headers.get("cache-control"), "no-store");
            for (const method of ["POST", "PUT", "DELETE"]) {
                const response = await handler(request(method, path));
                assert.equal(response.status, 405);
                assert.equal(response.headers.get("allow"), "GET, HEAD");
            }
        }
    }
});

test("Muse challenge OPTIONS follows public route CORS handling", async () => {
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

test("Vercel routes Muse challenge verification to its API entry point", () => {
    const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
    assert.ok(config.rewrites.some(({ source, destination }) =>
        source === pathname && destination === alias));
    assert.ok(existsSync(new URL("../api/muse-challenge.js", import.meta.url)));
});

test("unknown Muse challenge tokens remain 404", async () => {
    for (const path of ["/.well-known/muse-challenge/deadbeef", `${pathname}/`, `${pathname}/extra`]) {
        const response = await handleMcpHttpRequest(request("GET", path));
        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), { error: "Not found" });
    }
});
