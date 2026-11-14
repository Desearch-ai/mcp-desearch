import assert from 'node:assert/strict';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (name) => readFileSync(path.join(root, name), 'utf8');

test('native HTTP declaration has only the hosted endpoint and a key reference', () => {
  assert.deepEqual(JSON.parse(read('.mcp.json')), {
    mcpServers: { desearch: {
      type: 'http', url: 'https://mcp.desearch.ai/mcp',
      headers: { 'x-api-key': '${DESEARCH_API_KEY}' },
    } },
  });
});

test('Jan metadata declares the setup key and a conventional skill', () => {
  const metadata = read('plugin.toml');
  for (const line of [
    'name = "desearch"', 'version = "0.1.0"', '[setup.env]',
    'DESEARCH_API_KEY = "https://console.desearch.ai/api-keys"',
  ]) assert.ok(metadata.includes(line), line);
  assert.match(read('skills/desearch/SKILL.md'), /^---\nname: desearch\ndescription: .+\n---\n/);
  assert.ok(!metadata.includes('[[tools]]'));
  assert.ok(!metadata.includes('hooks'));
});

test('payload contains no symlinks or executable runtime', () => {
  function visit(dir) {
    for (const name of readdirSync(dir)) {
      const entry = path.join(dir, name);
      const stat = lstatSync(entry);
      assert.ok(!stat.isSymbolicLink(), entry);
      if (stat.isDirectory()) visit(entry);
      else if (!entry.includes(`${path.sep}test${path.sep}`)) {
        assert.ok(!/\.(?:js|mjs|sh|py|ts)$/.test(name), entry);
      }
    }
  }
  visit(root);
});
