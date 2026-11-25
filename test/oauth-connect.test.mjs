import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { startHttpServer } from "../build/http.js";
import { resetOAuthForTests, setApiKeyCheckerForTests } from "../build/oauth/http.js";
import { getOAuthStore, memoryStoreForTests } from "../build/oauth/store.js";

const SECRET = "connect-secret-for-tests-0123456789abcdef";
const CONSOLE = "https://console.example.test";
const PASTED_KEY = "dt_pasted_key_do_not_leak";
const MINTED_KEY = "dsr_" + "A1b2C3d4E5".repeat(4);
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

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

async function withServer(env, fn) {
    const names = [
        "OAUTH_ISSUER",
        "OAUTH_RESOURCE",
        "OAUTH_STORE",
        "OAUTH_ENCRYPTION_KEY",
        "DESEARCH_CONNECT_SECRET",
        "DESEARCH_CONSOLE_URL",
    ];
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    for (const name of names) {
        delete process.env[name];
    }
    process.env.OAUTH_STORE = "memory";
    process.env.OAUTH_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64url");
    Object.assign(process.env, env);
    resetOAuthForTests();
    setApiKeyCheckerForTests(async (apiKey) =>
        apiKey === PASTED_KEY ? { ok: true } : { ok: false, message: "That API key was rejected." }
    );
    const server = await startHttpServer({ host: "127.0.0.1", port: 0 });
    try {
        await fn(`http://127.0.0.1:${server.port}`);
    } finally {
        await server.close();
        setApiKeyCheckerForTests(null);
        resetOAuthForTests();
        for (const name of names) {
            restoreEnv(name, previous[name]);
        }
    }
}

const ON = { DESEARCH_CONNECT_SECRET: SECRET, DESEARCH_CONSOLE_URL: CONSOLE };

async function register(origin) {
    const response = await fetch(`${origin}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            client_name: "Claude",
            redirect_uris: [REDIRECT],
            token_endpoint_auth_method: "none",
        }),
    });
    assert.equal(response.status, 201);
    return response.json();
}

function authorizeFields(origin, client, challenge, state = "state-1") {
    return {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        scope: "mcp offline_access",
        resource: `${origin}/mcp`,
    };
}

async function postAuthorize(origin, fields) {
    return fetch(`${origin}/authorize`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", origin },
        body: new URLSearchParams(fields),
    });
}

/** Presses "Continue with Desearch" and returns the request id and the browser's cookie. */
async function startSignIn(origin) {
    const client = await register(origin);
    const { verifier, challenge } = pkce();
    const started = await postAuthorize(origin, {
        ...authorizeFields(origin, client, challenge),
        decision: "desearch",
    });
    assert.equal(started.status, 303);
    const location = new URL(started.headers.get("location"));
    assert.equal(location.origin, CONSOLE);
    assert.equal(location.pathname, "/connect");
    // The id rides in the fragment, which browsers keep out of requests and logs.
    assert.equal(location.search, "");
    const requestId = new URLSearchParams(location.hash.slice(1)).get("request");
    assert.match(requestId, /^dscr_[A-Za-z0-9_-]{43}$/);
    const setCookie = started.headers.get("set-cookie");
    assert.match(setCookie, /^__Host-dsc_[0-9a-f]{16}=/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Path=\//);
    assert.equal(/Domain=/i.test(setCookie), false);
    return { client, verifier, requestId, cookie: setCookie.split(";")[0] };
}

function complete(origin, body, secret = SECRET) {
    return fetch(`${origin}/connect/complete`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
        body: JSON.stringify(body),
    });
}

function describe(origin, requestId, secret = SECRET) {
    return fetch(`${origin}/connect/info`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
        body: JSON.stringify({ request_id: requestId }),
    });
}

/** Allows (or cancels) the sign-in as the console would and returns the URL it hands the browser. */
async function decide(origin, requestId, decision = "allow") {
    const done = await complete(origin, {
        request_id: requestId,
        decision,
        ...(decision === "allow" ? { api_key: MINTED_KEY } : {}),
    });
    assert.equal(done.status, 200);
    const body = await done.json();
    const returnUrl = new URL(body.return_url);
    assert.equal(returnUrl.origin + returnUrl.pathname, `${origin}/connect/return`);
    assert.equal(returnUrl.searchParams.get("request"), requestId);
    const token = returnUrl.searchParams.get("token");
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    return { body, token };
}

function comeBack(origin, requestId, cookie, token) {
    const url = new URL(`${origin}/connect/return`);
    url.searchParams.set("request", requestId);
    if (token) {
        url.searchParams.set("token", token);
    }
    return fetch(url, { redirect: "manual", headers: cookie ? { cookie } : {} });
}

test("without the shared secret the authorize page offers only the API key form", async () => {
    await withServer({}, async (origin) => {
        const client = await register(origin);
        const { challenge } = pkce();
        const url = new URL(`${origin}/authorize`);
        url.search = new URLSearchParams(authorizeFields(origin, client, challenge));
        const page = await fetch(url);
        assert.equal(page.status, 200);
        const html = await page.text();
        assert.match(html, /Desearch API key/);
        assert.equal(html.includes("Continue with Desearch"), false);
        assert.equal(page.headers.get("content-security-policy").includes("console"), false);

        assert.equal((await describe(origin, "x")).status, 503);
        const done = await complete(origin, { request_id: "x", decision: "deny" });
        assert.equal(done.status, 503);
    });
});

test("a weak secret, a missing console URL or a plain-http console leaves the sign-in off", async () => {
    for (const env of [
        { DESEARCH_CONNECT_SECRET: "too-short", DESEARCH_CONSOLE_URL: CONSOLE },
        { DESEARCH_CONNECT_SECRET: SECRET },
        { DESEARCH_CONNECT_SECRET: SECRET, DESEARCH_CONSOLE_URL: "http://console.example.test" },
        { DESEARCH_CONNECT_SECRET: SECRET, DESEARCH_CONSOLE_URL: "not a url" },
    ]) {
        await withServer(env, async (origin) => {
            const client = await register(origin);
            const { challenge } = pkce();
            const url = new URL(`${origin}/authorize`);
            url.search = new URLSearchParams(authorizeFields(origin, client, challenge));
            const html = await (await fetch(url)).text();
            assert.equal(html.includes("Continue with Desearch"), false);
            assert.equal((await describe(origin, "x")).status, 503);
        });
    }
});

test("the authorize page leads with Continue with Desearch and keeps the key form", async () => {
    await withServer(ON, async (origin) => {
        const client = await register(origin);
        const { challenge } = pkce();
        const url = new URL(`${origin}/authorize`);
        url.search = new URLSearchParams(authorizeFields(origin, client, challenge));
        const page = await fetch(url);
        assert.equal(page.status, 200);
        const html = await page.text();
        assert.match(html, /name="decision" value="desearch">Continue with Desearch</);
        assert.match(html, /Use an API key instead/);
        assert.match(html, /claude\.ai/);
        assert.equal(/<details open/.test(html), false);
        const csp = page.headers.get("content-security-policy");
        assert.match(csp, /form-action 'self' https:\/\/console\.example\.test https:\/\/claude\.ai/);
    });
});

test("sign-in on the console ends in a token that carries the key the console made", async () => {
    await withServer(ON, async (origin) => {
        const { client, verifier, requestId, cookie } = await startSignIn(origin);

        const info = await describe(origin, requestId);
        assert.equal(info.status, 200);
        const described = await info.json();
        assert.equal(described.status, "pending");
        assert.equal(described.client_name, "Claude");
        assert.equal(described.redirect_host, "claude.ai");
        assert.equal(described.loopback, false);
        assert.ok(Date.parse(described.expires_at) > Date.now());

        const { body: decided, token: returnToken } = await decide(origin, requestId);
        assert.equal(decided.status, "approved");
        assert.equal(JSON.stringify(decided).includes(MINTED_KEY), false);

        const back = await comeBack(origin, requestId, cookie, returnToken);
        assert.equal(back.status, 302);
        const location = new URL(back.headers.get("location"));
        assert.equal(location.origin + location.pathname, REDIRECT);
        assert.equal(location.searchParams.get("state"), "state-1");
        assert.equal(location.searchParams.get("iss"), origin);
        assert.equal(location.toString().includes(MINTED_KEY), false);
        assert.match(back.headers.get("set-cookie"), /Max-Age=0/);
        const code = location.searchParams.get("code");
        assert.ok(code?.startsWith("dsoc_"));

        const token = await fetch(`${origin}/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                code,
                redirect_uri: REDIRECT,
                client_id: client.client_id,
                code_verifier: verifier,
                resource: `${origin}/mcp`,
            }),
        });
        assert.equal(token.status, 200);
        const body = await token.json();
        assert.equal(body.scope, "mcp offline_access");
        assert.equal(JSON.stringify(body).includes(MINTED_KEY), false);

        const store = await getOAuthStore();
        const access = await store.getAccess(body.access_token);
        assert.equal(store.readApiKey(access.apiKeyCiphertext), MINTED_KEY);

        // The sign-in is used up: a second return gets no second code.
        const again = await comeBack(origin, requestId, cookie, returnToken);
        assert.equal(again.status, 400);
        assert.match(await again.text(), /expired/);
    });
});

test("someone who starts a sign-in and gets another person to allow it receives nothing", async () => {
    await withServer(ON, async (origin) => {
        // The attacker starts the sign-in and holds its cookie. The victim, signed
        // in to the console, opens the link the attacker sent and presses Allow.
        const { requestId, cookie: attackerCookie } = await startSignIn(origin);
        const { token: victimToken } = await decide(origin, requestId);

        // The attacker has no token, however often they try.
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const attacker = await comeBack(origin, requestId, attackerCookie);
            assert.equal(attacker.status, 403);
            assert.equal(attacker.headers.get("location"), null);
        }
        const guessed = await comeBack(origin, requestId, attackerCookie, "A".repeat(43));
        assert.equal(guessed.status, 403);

        // The victim's browser returns with the token but without the cookie: no code, and the sign-in ends.
        const victim = await comeBack(origin, requestId, "", victimToken);
        assert.equal(victim.status, 403);
        assert.equal(victim.headers.get("location"), null);
        assert.match(await victim.text(), /another browser/);

        // Even with the token in hand afterwards, the attacker's browser gets no code.
        const late = await comeBack(origin, requestId, attackerCookie, victimToken);
        assert.equal(late.status, 400);
        assert.equal(late.headers.get("location"), null);
        const store = await getOAuthStore();
        assert.equal(await store.getConnect(requestId), null);
    });
});

test("a stranger with neither cookie nor token cannot end someone's sign-in", async () => {
    await withServer(ON, async (origin) => {
        const { requestId, cookie } = await startSignIn(origin);
        const { token } = await decide(origin, requestId);

        assert.equal((await comeBack(origin, requestId, "")).status, 403);
        assert.equal((await comeBack(origin, requestId, cookie.replace(/=.*/, "=not-the-secret"))).status, 403);
        assert.equal((await comeBack(origin, requestId, "", "B".repeat(43))).status, 403);

        const owner = await comeBack(origin, requestId, cookie, token);
        assert.equal(owner.status, 302);
        assert.ok(new URL(owner.headers.get("location")).searchParams.get("code"));
    });
});

test("coming back before the console decided keeps the sign-in open", async () => {
    await withServer(ON, async (origin) => {
        const { requestId, cookie } = await startSignIn(origin);
        const early = await comeBack(origin, requestId, cookie);
        assert.equal(early.status, 409);
        assert.equal((await comeBack(origin, requestId, "")).status, 403);
        const { token } = await decide(origin, requestId);
        const later = await comeBack(origin, requestId, cookie, token);
        assert.equal(later.status, 302);
    });
});

test("a cancelled sign-in sends the client access_denied", async () => {
    await withServer(ON, async (origin) => {
        const { requestId, cookie } = await startSignIn(origin);
        const { body, token } = await decide(origin, requestId, "deny");
        assert.equal(body.status, "denied");
        const back = await comeBack(origin, requestId, cookie, token);
        assert.equal(back.status, 302);
        const location = new URL(back.headers.get("location"));
        assert.equal(location.searchParams.get("error"), "access_denied");
        assert.equal(location.searchParams.get("state"), "state-1");
        assert.equal(location.searchParams.get("code"), null);
    });
});

test("the server-to-server calls need the shared secret and take one decision", async () => {
    await withServer(ON, async (origin) => {
        const { requestId } = await startSignIn(origin);
        const allow = { request_id: requestId, decision: "allow", api_key: MINTED_KEY };

        assert.equal((await complete(origin, allow, "wrong-secret-0123456789abcdef0123456789")).status, 401);
        assert.equal((await fetch(`${origin}/connect/complete`, { method: "POST", body: JSON.stringify(allow) })).status, 401);
        assert.equal((await describe(origin, requestId, null)).status, 401);
        assert.equal((await describe(origin, requestId, "wrong-secret-0123456789abcdef0123456789")).status, 401);
        assert.equal((await describe(origin, "not-an-id")).status, 400);
        assert.equal((await describe(origin, "dscr_" + "x".repeat(43))).status, 404);
        // The id never travels in a URL: the old query form is gone.
        const viaQuery = await fetch(`${origin}/connect/info?request=${requestId}`, {
            headers: { authorization: `Bearer ${SECRET}` },
        });
        assert.equal(viaQuery.status, 405);

        assert.equal((await complete(origin, { ...allow, api_key: "has spaces in it, not a key" })).status, 400);
        assert.equal((await complete(origin, { request_id: requestId, decision: "allow" })).status, 400);
        assert.equal((await complete(origin, { ...allow, decision: "maybe" })).status, 400);
        assert.equal((await complete(origin, { ...allow, request_id: "dscr_" + "x".repeat(43) })).status, 404);
        assert.equal((await complete(origin, { ...allow, request_id: "not-an-id" })).status, 400);

        assert.equal((await complete(origin, allow)).status, 200);
        const second = await complete(origin, { request_id: requestId, decision: "deny" });
        assert.equal(second.status, 409);
        assert.equal((await second.json()).error, "already_decided");

        const wrongMethod = await fetch(`${origin}/connect/complete`, { headers: { authorization: `Bearer ${SECRET}` } });
        assert.equal(wrongMethod.status, 405);
    });
});

test("a key typed into the form wins over the Continue with Desearch button", async () => {
    await withServer(ON, async (origin) => {
        const client = await register(origin);
        const { challenge } = pkce();
        const fields = authorizeFields(origin, client, challenge);

        // Enter in the key field submits the first button, whose value is "desearch".
        const typed = await postAuthorize(origin, { ...fields, decision: "desearch", api_key: PASTED_KEY });
        assert.equal(typed.status, 302);
        assert.ok(new URL(typed.headers.get("location")).searchParams.get("code"));
        assert.equal(typed.headers.get("set-cookie"), null);

        const refused = await postAuthorize(origin, { ...fields, decision: "allow", api_key: "wrong" });
        assert.equal(refused.status, 400);
        const html = await refused.text();
        assert.match(html, /<details open/);
        assert.match(html, /That API key was rejected/);
        assert.match(html, /Continue with Desearch/);
    });
});

test("an expired sign-in is gone from the store", async () => {
    const store = memoryStoreForTests();
    const record = {
        clientId: "c",
        clientName: "Claude",
        redirectUri: REDIRECT,
        state: "s",
        codeChallenge: "x".repeat(43),
        resource: "https://mcp.example/mcp",
        scope: "mcp",
        browserHash: "h",
        status: "pending",
        expiresAt: Date.now() - 1,
    };
    await store.saveConnect("dscr_old", record);
    assert.equal(await store.getConnect("dscr_old"), null);
    assert.equal(await store.takeConnect("dscr_old"), null);

    await store.saveConnect("dscr_new", { ...record, expiresAt: Date.now() + 60_000 });
    assert.equal((await store.getConnect("dscr_new")).status, "pending");
    assert.equal(await store.claimConnectDecision("dscr_new"), true);
    assert.equal(await store.claimConnectDecision("dscr_new"), false);
    assert.equal((await store.takeConnect("dscr_new")).clientName, "Claude");
    assert.equal(await store.takeConnect("dscr_new"), null);
    assert.equal(await store.getConnect("dscr_new"), null);

    // An update keeps the time that is left; it never extends it.
    const soon = Date.now() + 2_000;
    await store.saveConnect("dscr_brief", { ...record, expiresAt: soon });
    await store.saveConnect("dscr_brief", { ...record, status: "approved", expiresAt: soon });
    assert.equal((await store.getConnect("dscr_brief")).expiresAt, soon);

    // Many callers at once: one gets the record.
    await store.saveConnect("dscr_race", { ...record, expiresAt: Date.now() + 60_000 });
    const takes = await Promise.all(Array.from({ length: 20 }, () => store.takeConnect("dscr_race")));
    assert.equal(takes.filter(Boolean).length, 1);
});
