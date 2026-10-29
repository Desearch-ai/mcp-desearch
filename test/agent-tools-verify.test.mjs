import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import organization from "../api/agent-tools.js";
import verification from "../api/agent-tools-verify.js";
import { AGENT_TOOLS_VERIFY_TOKEN } from "../build/agent-tools-verify.js";
import { handleMcpHttpRequest } from "../build/http.js";

const pathname = "/.well-known/agent-tools-verify.txt";
const alias = "/api/agent-tools-verify";

function request(method = "GET", path = pathname) {
    return new Request(`https://mcp.desearch.ai${path}`, { method });
}

test("verification GET serves the source token with a single trailing newline without authentication", async () => {
    for (const path of [pathname, alias]) {
        for (const handler of [handleMcpHttpRequest, verification.fetch]) {
            const response = await handler(request("GET", path));
            assert.equal(response.status, 200);
            assert.ok((await response.text()) === AGENT_TOOLS_VERIFY_TOKEN + "\n", "verification body matches the source token and trailing newline");
            assert.ok(response.headers.get("content-type")?.startsWith("text/plain"));
            assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
            assert.equal(response.headers.get("cache-control"), "no-store");
        }
    }
});

test("verification HEAD has no body and unsupported methods return 405", async () => {
    for (const path of [pathname, alias]) {
        const head = await handleMcpHttpRequest(request("HEAD", path));
        assert.equal(head.status, 200);
        assert.equal(await head.text(), "");
        assert.equal(head.headers.get("content-type"), "text/plain; charset=utf-8");
        assert.equal(head.headers.get("cache-control"), "no-store");
        for (const method of ["POST", "PUT", "DELETE"]) {
            const response = await handleMcpHttpRequest(request(method, path));
            assert.equal(response.status, 405);
            assert.equal(response.headers.get("allow"), "GET, HEAD");
        }
    }
});

test("verification OPTIONS follows public route CORS handling", async () => {
    for (const path of [pathname, alias]) {
        const response = await handleMcpHttpRequest(request("OPTIONS", path));
        const health = await handleMcpHttpRequest(request("OPTIONS", "/health"));
        assert.equal(response.status, 204);
        assert.equal(await response.text(), "");
        assert.deepEqual([...response.headers], [...health.headers]);
    }
});

test("Vercel routes verification to its API entry point", () => {
    const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
    assert.ok(config.rewrites.some(({ source, destination }) =>
        source === pathname && destination === alias));
    assert.ok(existsSync(new URL("../api/agent-tools-verify.js", import.meta.url)));
});

const organizationPathname = "/.well-known/agent-tools.txt";
const organizationAlias = "/api/agent-tools";

test("organization GET serves the exact token without a trailing newline", async () => {
    for (const path of [organizationPathname, organizationAlias]) {
        for (const handler of [handleMcpHttpRequest, organization.fetch]) {
            const response = await handler(request("GET", path));
            assert.equal(response.status, 200);
            assert.ok(response.headers.get("content-type")?.startsWith("text/plain"));
            assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
            assert.equal(await response.text(), "at_verify_gLV2Bm0Bsys8C0oKURWhJrhk");
            assert.equal(response.headers.get("cache-control"), "no-store");
        }
    }
});

test("organization HEAD and unsupported methods mirror verification handling", async () => {
    for (const path of [organizationPathname, organizationAlias]) {
        const head = await handleMcpHttpRequest(request("HEAD", path));
        assert.equal(head.status, 200);
        assert.equal(await head.text(), "");
        for (const method of ["POST", "PUT", "DELETE"]) {
            const response = await handleMcpHttpRequest(request(method, path));
            assert.equal(response.status, 405);
            assert.equal(response.headers.get("allow"), "GET, HEAD");
        }
        const options = await handleMcpHttpRequest(request("OPTIONS", path));
        assert.equal(options.status, 204);
    }
});

test("Vercel routes organization verification to its API entry point", () => {
    const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
    assert.ok(config.rewrites.some(({ source, destination }) =>
        source === organizationPathname && destination === organizationAlias));
    assert.ok(existsSync(new URL("../api/agent-tools.js", import.meta.url)));
});
