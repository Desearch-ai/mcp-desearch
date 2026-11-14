import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, run, serialize } from '../action.mjs';

test('malformed and boundary input stays local', async () => {
  for (const value of ['null', '[]', '{}', '{', '{"query":" "}', '{"query":1}',
    JSON.stringify({ query: 'a'.repeat(2001) }), '{"query":"x","key":"secret"}']) {
    assert.throws(() => parseQuery(value), /invalid_query/);
  }
  assert.equal(parseQuery('{"query":" web search "}'), 'web search');
  assert.equal(parseQuery(JSON.stringify({ query: 'a'.repeat(2000) })).length, 2000);
  await assert.rejects(run('search', { env: {}, clientFactory: () => assert.fail('network') }), /missing_config/);
  await assert.rejects(run('other'), /invalid_action/);
});

function fixture({ fail = false, errorResult = false } = {}) {
  const calls = [];
  return { calls, client: {
    async connect(transport) { calls.push(['connect', transport]); },
    async listTools() { calls.push(['list']); return { tools: [{ name: 'web-search', title: 'Web Search', annotations: { readOnlyHint: true } }] }; },
    async callTool(request) { calls.push(['call', request]); if (fail) throw Error('secret'); return { isError: errorResult, content: [{ type: 'text', text: 'result' }] }; },
    async close() { calls.push(['close']); },
  } };
}

test('host action calls only web-search once and disconnects', async () => {
  const f = fixture();
  await run('search', { env: { HERDR_PLUGIN_CONFIG_DIR: '/config' }, clientFactory: () => f.client, read: async () => '{"query":"public docs"}' });
  assert.deepEqual(f.calls.map(c => c[0]), ['connect', 'call', 'close']);
  assert.deepEqual(f.calls[1][1], { name: 'web-search', arguments: { query: 'public docs' } });
});

test('service and transport errors never retry and always close', async () => {
  for (const options of [{ fail: true }, { errorResult: true }]) {
    const f = fixture(options);
    await assert.rejects(run('search', { env: { HERDR_PLUGIN_CONFIG_DIR: '/config' }, clientFactory: () => f.client, read: async () => '{"query":"public docs"}' }));
    assert.deepEqual(f.calls.map(c => c[0]), ['connect', 'call', 'close']);
  }
});

test('discovery preserves shared-server annotations and key is redacted', async () => {
  const f = fixture();
  const result = await run('discover', { env: {}, clientFactory: () => f.client });
  assert.equal(result.tools[0].annotations.readOnlyHint, true);
  assert.deepEqual(f.calls.map(c => c[0]), ['connect', 'list', 'close']);
  assert.equal(serialize({ text: 'secret secret' }, 'secret'), '{"text":"[REDACTED] [REDACTED]"}');
});
