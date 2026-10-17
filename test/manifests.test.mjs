import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { SERVER_VERSION } from "../build/server.js";

function fileUrl(path) {
    return new URL(`../${path}`, import.meta.url);
}

function json(path) {
    return JSON.parse(readFileSync(fileUrl(path), "utf8"));
}

test("every manifest carries the package version", () => {
    const { version } = json("package.json");
    const server = json("server.json");
    assert.equal(SERVER_VERSION, version);
    // The marketplace CI gate deletes the npm lockfile before it installs.
    if (existsSync(fileUrl("package-lock.json"))) {
        const lock = json("package-lock.json");
        assert.equal(lock.version, version);
        assert.equal(lock.packages[""].version, version);
    }
    assert.equal(server.version, version);
    assert.deepEqual(
        server.packages.map((entry) => entry.version),
        [version]
    );
    assert.equal(json("gemini-extension.json").version, version);
    assert.equal(json("plugin/.claude-plugin/plugin.json").version, version);
    assert.equal(json("plugin/.cursor-plugin/plugin.json").version, version);
});

test("server.json description fits the MCP Registry limit", () => {
    // ServerDetail.description has maxLength 100 in the 2025-12-11 server schema.
    const { description } = json("server.json");
    assert.ok(description.length <= 100, `${description.length} characters`);
});
