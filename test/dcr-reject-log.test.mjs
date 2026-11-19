import assert from "node:assert/strict";
import test from "node:test";
import { startHttpServer } from "../build/http.js";
import { resetOAuthForTests } from "../build/oauth/http.js";
import { publicOrigin, canonicalResource } from "../build/oauth/metadata.js";
import { redirectForLog, rejectedRedirectLog, userAgentFamily } from "../build/oauth/register-log.js";

const ENV_NAMES = [
    "OAUTH_ISSUER",
    "OAUTH_RESOURCE",
    "OAUTH_STORE",
    "OAUTH_ENCRYPTION_KEY",
    "VERCEL",
    "VERCEL_ENV",
    "VERCEL_URL",
    "VERCEL_BRANCH_URL",
    "OAUTH_PREVIEW_ISSUER_FROM_HOST",
    "NODE_ENV",
];

async function withEnv(values, fn) {
    const saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
    for (const name of ENV_NAMES) {
        delete process.env[name];
    }
    Object.assign(process.env, values);
    try {
        return await fn();
    } finally {
        for (const name of ENV_NAMES) {
            if (saved[name] === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = saved[name];
            }
        }
    }
}

async function withServer(fn) {
    await withEnv(
        { OAUTH_STORE: "memory", OAUTH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url") },
        async () => {
            resetOAuthForTests();
            const server = await startHttpServer({ host: "127.0.0.1", port: 0 });
            try {
                await fn(server);
            } finally {
                await server.close();
                resetOAuthForTests();
            }
        }
    );
}

async function captureWarnings(fn) {
    const lines = [];
    const original = console.warn;
    console.warn = (...args) => lines.push(args.map(String).join(" "));
    try {
        await fn();
    } finally {
        console.warn = original;
    }
    return lines;
}

function register(port, body, userAgent = "python-httpx/0.27.0") {
    return fetch(`http://127.0.0.1:${port}/register`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": userAgent },
        body: JSON.stringify(body),
    });
}

test("redirectForLog keeps origin and path only", () => {
    assert.equal(
        redirectForLog("https://user:pw@api.example.com/oauth/callback?state=secret&code=abc#frag"),
        "https://api.example.com/oauth/callback"
    );
    assert.equal(redirectForLog("https://www.example.com/cb"), "https://www.example.com/cb");
    assert.equal(redirectForLog("http://localhost:4312/cb?x=1"), "http://localhost:4312/cb");
    assert.equal(redirectForLog("com.example.app:/oauth?token=t"), "com.example.app:/oauth");
    assert.equal(redirectForLog(42), "<not a string>");
    assert.equal(redirectForLog(null), "<not a string>");
    assert.equal(redirectForLog("not a url?token=t"), "not a url");
    assert.equal(redirectForLog("https://u:p@[bad/x?token=t"), "https://[bad/x");
    assert.equal(redirectForLog("?only=query"), "<unparsable>");
    assert.ok(redirectForLog(`https://a.example/${"x".repeat(500)}`).length <= 200);
    assert.equal(redirectForLog("https://a.example/p\u0000ath"), "https://a.example/p%00ath");
});

test("userAgentFamily keeps the first product token", () => {
    assert.equal(userAgentFamily("python-httpx/0.27.0"), "python-httpx");
    assert.equal(userAgentFamily("Mozilla/5.0 (Macintosh)"), "Mozilla");
    assert.equal(userAgentFamily("node"), "node");
    assert.equal(userAgentFamily(null), "none");
    assert.equal(userAgentFamily(""), "none");
    assert.equal(userAgentFamily("<<<"), "other");
});

test("rejectedRedirectLog has only the agreed fields", () => {
    const entry = rejectedRedirectLog(["https://x.example/cb?a=1"], "Studio\n", "node/22");
    assert.deepEqual(Object.keys(entry).sort(), ["client_name", "event", "rejected", "ua_family"]);
    assert.deepEqual(entry, {
        event: "dcr_redirect_rejected",
        rejected: ["https://x.example/cb"],
        client_name: "Studio",
        ua_family: "node",
    });
    assert.equal(rejectedRedirectLog([], 7, null).client_name, "");
    assert.equal(rejectedRedirectLog(new Array(25).fill("https://x.example/cb"), "", null).rejected.length, 10);
});

test("/register logs one line for a rejected callback, without query, fragment or other body fields", async () => {
    await withServer(async (server) => {
        let response;
        const lines = await captureWarnings(async () => {
            response = await register(server.port, {
                redirect_uris: ["https://api.unlisted.example/oauth/callback?state=s3cret&code=c0de#frag"],
                client_name: "Unlisted Studio",
                client_secret: "never-log-this",
                software_statement: "never-log-this-either",
            });
        });
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error, "invalid_redirect_uri");
        assert.equal(lines.length, 1);
        const line = lines[0];
        assert.deepEqual(JSON.parse(line), {
            event: "dcr_redirect_rejected",
            rejected: ["https://api.unlisted.example/oauth/callback"],
            client_name: "Unlisted Studio",
            ua_family: "python-httpx",
        });
        for (const forbidden of ["?", "#", "s3cret", "c0de", "never-log-this", "state=", "code="]) {
            assert.ok(!line.includes(forbidden), `log contains ${forbidden}`);
        }
    });
});

test("/register logs only the rejected entries of a mixed list and still returns 400", async () => {
    await withServer(async (server) => {
        let response;
        const lines = await captureWarnings(async () => {
            response = await register(server.port, {
                redirect_uris: ["https://claude.ai/api/mcp/auth_callback", "https://evil.example/cb?x=1", 5],
            });
        });
        assert.equal(response.status, 400);
        assert.equal(lines.length, 1);
        const entry = JSON.parse(lines[0]);
        assert.deepEqual(entry.rejected, ["https://evil.example/cb", "<not a string>"]);
        assert.equal(entry.client_name, "");
    });
});

test("/register does not log allowed callbacks or other 400s", async () => {
    await withServer(async (server) => {
        const responses = [];
        const lines = await captureWarnings(async () => {
            responses.push(await register(server.port, { redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }));
            responses.push(await register(server.port, { redirect_uris: [] }));
            responses.push(
                await register(server.port, {
                    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
                    token_endpoint_auth_method: "client_secret_post",
                })
            );
        });
        assert.deepEqual(
            responses.map((response) => response.status),
            [201, 400, 400]
        );
        assert.deepEqual(lines, []);
    });
});

const previewHost = "mcp-desearch-git-branch-team.vercel.app";
const deploymentHost = "mcp-desearch-abc123-team.vercel.app";
const previewEnv = {
    VERCEL: "1",
    VERCEL_ENV: "preview",
    VERCEL_URL: deploymentHost,
    VERCEL_BRANCH_URL: previewHost,
    OAUTH_ISSUER: "https://mcp.desearch.ai",
    OAUTH_PREVIEW_ISSUER_FROM_HOST: "1",
};

test("preview opt-in: the issuer follows a Vercel-assigned preview host", async () => {
    await withEnv(previewEnv, () => {
        for (const host of [previewHost, deploymentHost]) {
            const request = new Request(`https://${host}/.well-known/oauth-authorization-server`);
            assert.equal(publicOrigin(request), `https://${host}`);
            assert.equal(canonicalResource(request), `https://${host}/mcp`);
        }
    });
});

test("preview opt-in never applies to a host Vercel did not assign, without the flag, or in production", async () => {
    const foreign = new Request("https://evil.example/.well-known/oauth-authorization-server");
    await withEnv(previewEnv, () => assert.equal(publicOrigin(foreign), "https://mcp.desearch.ai"));

    const own = new Request(`https://${previewHost}/.well-known/oauth-authorization-server`);
    await withEnv({ ...previewEnv, OAUTH_PREVIEW_ISSUER_FROM_HOST: "true" }, () =>
        assert.equal(publicOrigin(own), "https://mcp.desearch.ai")
    );
    const { OAUTH_PREVIEW_ISSUER_FROM_HOST: _flag, ...noFlag } = previewEnv;
    await withEnv(noFlag, () => assert.equal(publicOrigin(own), "https://mcp.desearch.ai"));
    await withEnv({ ...previewEnv, VERCEL_ENV: "production" }, () =>
        assert.equal(publicOrigin(own), "https://mcp.desearch.ai")
    );
    await withEnv({ ...previewEnv, VERCEL_ENV: "production", OAUTH_ISSUER: "" }, () =>
        assert.throws(() => publicOrigin(own), /OAUTH_ISSUER is required/)
    );
    await withEnv({ ...previewEnv, VERCEL_URL: "", VERCEL_BRANCH_URL: "" }, () =>
        assert.equal(publicOrigin(own), "https://mcp.desearch.ai")
    );
});
