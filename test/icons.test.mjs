import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { handleMcpHttpRequest, startHttpServer } from "../build/http.js";
import { FAVICON_ICO_BASE64, ICON_512_PNG_BASE64, ICON_64_PNG_BASE64 } from "../build/icons-data.js";

const INIT_BODY = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "icons", version: "0.0.1" },
    },
};

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const PNG_PATHS = {
    "/icon-512.png": 512,
    "/icon-64.png": 64,
    "/favicon.png": 64,
};

const ICON_PATHS = [...Object.keys(PNG_PATHS), "/favicon.ico"];

function request(method, path) {
    return new Request(`https://mcp.desearch.ai${path}`, { method });
}

function pngSize(bytes) {
    assert.deepEqual([...bytes.subarray(0, 8)], PNG_MAGIC);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.equal(new TextDecoder().decode(bytes.subarray(12, 16)), "IHDR");
    return { width: view.getUint32(16), height: view.getUint32(20) };
}

function assertIconHeaders(response, contentType, length) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), contentType);
    assert.equal(response.headers.get("cache-control"), "public, max-age=86400");
    assert.equal(response.headers.get("cross-origin-resource-policy"), "cross-origin");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("content-length"), String(length));
}

test("initialize serverInfo carries title, websiteUrl and absolute https PNG icons", async () => {
    const response = await handleMcpHttpRequest(
        new Request("https://mcp.desearch.ai/mcp", {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
            body: JSON.stringify(INIT_BODY),
        })
    );
    assert.equal(response.status, 200);
    const { serverInfo } = (await response.json()).result;
    assert.equal(serverInfo.name, "Desearch");
    assert.equal(serverInfo.title, "Desearch");
    assert.equal(serverInfo.websiteUrl, "https://www.desearch.ai");
    assert.deepEqual(serverInfo.icons, [
        { src: "https://mcp.desearch.ai/icon-512.png", mimeType: "image/png", sizes: ["512x512"] },
        { src: "https://mcp.desearch.ai/icon-64.png", mimeType: "image/png", sizes: ["64x64"] },
    ]);
    for (const icon of serverInfo.icons) {
        assert.equal(new URL(icon.src).protocol, "https:");
    }
});

test("GET serves each PNG icon with the right size and no auth", async () => {
    for (const [path, size] of Object.entries(PNG_PATHS)) {
        const response = await handleMcpHttpRequest(request("GET", path));
        const bytes = new Uint8Array(await response.arrayBuffer());
        assertIconHeaders(response, "image/png", bytes.byteLength);
        assert.deepEqual(pngSize(bytes), { width: size, height: size }, path);
    }
});

test("GET /favicon.ico serves an ICO with 16, 32, 48 and 64 pixel images", async () => {
    const response = await handleMcpHttpRequest(request("GET", "/favicon.ico"));
    const bytes = new Uint8Array(await response.arrayBuffer());
    assertIconHeaders(response, "image/x-icon", bytes.byteLength);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.equal(view.getUint16(0, true), 0);
    assert.equal(view.getUint16(2, true), 1);
    const count = view.getUint16(4, true);
    const sizes = [];
    for (let i = 0; i < count; i++) {
        sizes.push(bytes[6 + i * 16]);
    }
    assert.deepEqual(sizes.sort((a, b) => a - b), [16, 32, 48, 64]);
});

test("HEAD returns icon headers with no body, other methods return 405", async () => {
    for (const path of ICON_PATHS) {
        const get = await handleMcpHttpRequest(request("GET", path));
        const length = (await get.arrayBuffer()).byteLength;
        const head = await handleMcpHttpRequest(request("HEAD", path));
        assertIconHeaders(head, get.headers.get("content-type"), length);
        assert.equal((await head.arrayBuffer()).byteLength, 0);
        for (const method of ["POST", "PUT", "DELETE"]) {
            const response = await handleMcpHttpRequest(request(method, path));
            assert.equal(response.status, 405, `${method} ${path}`);
            assert.equal(response.headers.get("allow"), "GET, HEAD");
        }
    }
});

test("unknown paths still return 404", async () => {
    for (const path of ["/icon-128.png", "/icon.png", "/favicon.svg", "/api/icon"]) {
        const response = await handleMcpHttpRequest(request("GET", path));
        assert.equal(response.status, 404, path);
    }
});

test("local HTTP server serves icons and keeps the HEAD content length", async () => {
    const server = await startHttpServer({ host: "127.0.0.1", port: 0 });
    try {
        const base = `http://127.0.0.1:${server.port}`;
        const get = await fetch(`${base}/icon-512.png`);
        const bytes = new Uint8Array(await get.arrayBuffer());
        assertIconHeaders(get, "image/png", bytes.byteLength);
        assert.deepEqual(pngSize(bytes), { width: 512, height: 512 });
        const head = await fetch(`${base}/icon-512.png`, { method: "HEAD" });
        assertIconHeaders(head, "image/png", bytes.byteLength);
    } finally {
        await server.close();
    }
});

test("Vercel serves each icon as a static file from public/ with icon headers", async () => {
    const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
    const contentTypes = {
        "/icon-512.png": "image/png",
        "/icon-64.png": "image/png",
        "/favicon.png": "image/png",
        "/favicon.ico": "image/x-icon",
    };
    const served = {
        "/icon-512.png": ICON_512_PNG_BASE64,
        "/icon-64.png": ICON_64_PNG_BASE64,
        "/favicon.png": ICON_64_PNG_BASE64,
        "/favicon.ico": FAVICON_ICO_BASE64,
    };
    for (const path of ICON_PATHS) {
        const file = new URL(`../public${path}`, import.meta.url);
        assert.ok(existsSync(file), `public${path}`);
        const bytes = new Uint8Array(readFileSync(file));
        if (path in PNG_PATHS) {
            const size = PNG_PATHS[path];
            assert.deepEqual(pngSize(bytes), { width: size, height: size }, path);
        } else {
            assert.deepEqual([...bytes.subarray(0, 4)], [0, 0, 1, 0], path);
        }
        assert.deepEqual(bytes, new Uint8Array(Buffer.from(served[path], "base64")), path);
        const response = await handleMcpHttpRequest(request("GET", path));
        assert.deepEqual(bytes, new Uint8Array(await response.arrayBuffer()), path);

        assert.ok(!config.rewrites.some(({ source }) => source === path), `rewrite for ${path}`);
        const entry = config.headers.find(({ source }) => source === path);
        assert.ok(entry, `headers for ${path}`);
        const headers = Object.fromEntries(entry.headers.map(({ key, value }) => [key.toLowerCase(), value]));
        assert.equal(headers["access-control-allow-origin"], "*", path);
        assert.equal(headers["cross-origin-resource-policy"], "cross-origin", path);
        assert.equal(headers["cache-control"], "public, max-age=86400", path);
        assert.equal(headers["content-type"], contentTypes[path], path);
    }
    assert.ok(!existsSync(new URL("../api/icon.js", import.meta.url)));
});
