const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { runtime } = require('../handler');
const originalFetch = global.fetch;
const originalTimeout = AbortSignal.timeout;
afterEach(() => { global.fetch = originalFetch; AbortSignal.timeout = originalTimeout; });
const context = { runtimeArgs: { DESEARCH_API_KEY: 'test-secret-sentinel' } };
function server({ status, result, sse = false } = {}) {
  const calls = [];
  global.fetch = async (url, options) => {
    assert.equal(String(url), 'https://mcp.desearch.ai/mcp');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    assert.equal(new Headers(options.headers).get('x-api-key'), context.runtimeArgs.DESEARCH_API_KEY);
    if (options.method === 'GET') return new Response(null, { status: 405 });
    const message = JSON.parse(options.body);
    calls.push(message);
    if (!('id' in message)) return new Response(null, { status: 202 });
    if (message.method === 'tools/call' && status) return new Response('test-secret-sentinel upstream diagnostics', { status });
    const payload = { jsonrpc: '2.0', id: message.id, result: message.method === 'initialize' ? {
      protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' },
    } : result ?? { content: [{ type: 'text', text: 'A source https://example.com/ test-secret-sentinel' }] } };
    return sse && message.method === 'tools/call'
      ? new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      : Response.json(payload);
  };
  return calls;
}
test('malformed inputs and missing key make no network request', async () => {
  global.fetch = () => { throw new Error('unexpected network request'); };
  for (const input of [null, {}, { query: 4 }, { query: '' }, { query: ' ' }, { query: 'x'.repeat(2001) }, { query: 'ok', extra: true }]) {
    assert.match(await runtime.handler.call(context, input), /input error/);
  }
  assert.match(await runtime.handler.call({}, { query: 'valid' }), /configuration error/);
});
for (const sse of [false, true]) test(`MCP ${sse ? 'SSE' : 'JSON'} success forwards one trimmed search and redacts key`, async () => {
  const calls = server({ sse });
  const text = await runtime.handler.call(context, { query: ' public query ' });
  assert.match(text, /https:\/\/example.com/);
  assert.ok(!text.includes(context.runtimeArgs.DESEARCH_API_KEY));
  assert.deepEqual(calls.filter(c => c.method === 'tools/call').map(c => c.params), [{ name: 'web-search', arguments: { query: 'public query' } }]);
});
for (const status of [401, 403, 429, 503]) test(`HTTP ${status} fails once without diagnostics or retries`, async () => {
  const calls = server({ status });
  const text = await runtime.handler.call(context, { query: 'valid' });
  assert.match(text, /request failed/);
  assert.ok(!text.includes(context.runtimeArgs.DESEARCH_API_KEY));
  assert.equal(calls.filter(c => c.method === 'tools/call').length, 1);
});
test('MCP isError returns a safe failure once', async () => {
  const calls = server({ result: { isError: true, content: [{ type: 'text', text: 'test-secret-sentinel' }] } });
  assert.match(await runtime.handler.call(context, { query: 'valid' }), /search failed/);
  assert.equal(calls.filter(c => c.method === 'tools/call').length, 1);
});
test('network failure is bounded to one request and no diagnostic leakage', async () => {
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error('test-secret-sentinel'); };
  assert.match(await runtime.handler.call(context, { query: 'valid' }), /request failed/);
  assert.equal(calls, 1);
});
test('deadline aborts a stalled transport with no retry', async () => {
  let calls = 0;
  AbortSignal.timeout = () => originalTimeout(15);
  global.fetch = async (_url, options) => {
    calls++;
    await new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      setTimeout(resolve, 100);
    });
    throw new Error('must abort');
  };
  assert.match(await runtime.handler.call(context, { query: 'valid' }), /request failed/);
  assert.equal(calls, 1);
});
