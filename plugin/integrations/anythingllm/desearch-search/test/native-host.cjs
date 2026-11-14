// Real AnythingLLM loader and AIbitat dispatch; deterministic model selection only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setTimeout: wait } = require('node:timers/promises');

async function main() {
  const server = path.resolve(process.argv[2]);
  assert.ok(process.env.STORAGE_DIR && path.isAbsolute(process.env.STORAGE_DIR), 'absolute empty STORAGE_DIR required');
  assert.ok(process.env.DESEARCH_API_KEY, 'secret-manager environment key required');
  assert.equal(process.env.NODE_ENV, 'production');
  assert.equal(process.env.DISABLE_TELEMETRY, 'true');
  const root = path.resolve(__dirname, '..');
  const skills = path.join(process.env.STORAGE_DIR, 'plugins', 'agent-skills');
  fs.mkdirSync(skills, { recursive: true });
  assert.equal(fs.readdirSync(skills).length, 0, 'clean skill directory required');
  execFileSync('tar', ['-xzf', path.join(root, 'desearch-search.tgz'), '-C', skills]);
  const ImportedPlugin = require(path.join(server, 'utils/agents/imported'));
  const AIbitat = require(path.join(server, 'utils/agents/aibitat'));
  const originalFetch = global.fetch;
  const key = process.env.DESEARCH_API_KEY;
  let mode = 'live';
  let calls = [];
  global.fetch = async (url, options = {}) => {
    // Ignore unrelated upstream host model metadata requests in MCP counters.
    if (String(url) !== 'https://mcp.desearch.ai/mcp') return originalFetch(url, options);
    const message = options.body ? JSON.parse(options.body) : {};
    const entry = { method: message.method || options.method, status: null };
    calls.push(entry);
    if (mode === 'network') throw new Error('injected network outage');
    if (mode === 'service' && message.method === 'tools/call') {
      entry.status = 503;
      return new Response('upstream unavailable', { status: 503 });
    }
    const response = await originalFetch(url, options);
    entry.status = response.status;
    return response;
  };
  const host = new AIbitat();
  async function invoke(input, runtimeKey = key) {
    calls = [];
    const plugin = ImportedPlugin.loadPluginByHubId('desearch-search');
    // Exercise the actual native settings parser without persisting the secret.
    plugin.config.setup_args.DESEARCH_API_KEY.value = runtimeKey;
    host.use(plugin.plugin(plugin.parseCallOptions()));
    host.providerInstance = {
      resetCumulativeUsage() {}, getCumulativeUsage() { return {}; },
      async isModelLoaded() { return true; },
      async complete() { return { functionCall: { name: 'desearch-search', arguments: input } }; },
    };
    host.skipHandleExecution = true;
    const result = await host.handleExecution([{ role: 'user', content: 'execute selected search' }]);
    assert.equal(typeof result, 'string');
    assert.ok(!result.includes(key), 'result leaked credential');
    assert.ok(!fs.readFileSync(path.join(skills, 'desearch-search/plugin.json'), 'utf8').includes(key), 'credential persisted');
    return result;
  }
  const toolCalls = () => calls.filter(c => c.method === 'tools/call');
  try {
    assert.ok(ImportedPlugin.listImportedPlugins().some(p => p.hubId === 'desearch-search'));
    assert.equal(ImportedPlugin.activeImportedPlugins().length, 0);
    assert.ok(ImportedPlugin.validateImportedPluginHandler('desearch-search'));
    ImportedPlugin.updateImportedPlugin('desearch-search', { active: true });
    assert.deepEqual(ImportedPlugin.activeImportedPlugins(), ['@@desearch-search']);
    console.log('PASS native discovery, disabled default, enable, handler validation');

    const started = Date.now();
    console.log('OBSERVATION_START', new Date(started).toISOString());
    const query1 = 'Desearch hosted MCP documentation web-search';
    const first = await invoke({ query: query1 });
    assert.ok(!first.startsWith('Desearch request failed') && !first.startsWith('Desearch search failed'), 'first live search failed');
    assert.match(first, /https?:\/\//);
    assert.equal(toolCalls().length, 1);
    console.log(JSON.stringify({ cycle: 1, query: query1, calls, result: first }));

    assert.match(await invoke({ query: 'valid public search' }, ''), /configuration error/);
    assert.equal(calls.length, 0);
    console.log('PASS missing configured key: zero requests');
    assert.match(await invoke({ query: '' }), /input error/);
    assert.equal(calls.length, 0);
    console.log('PASS malformed native input: zero requests');

    const invalid = await invoke({ query: 'Desearch official documentation' }, 'invalid-t594-key');
    assert.match(invalid, /failed/);
    assert.equal(toolCalls().length, 1);
    console.log('PASS invalid key at protected action', JSON.stringify(calls));

    // Public discovery is insufficient: explicitly call a protected tool without a key.
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'native-host-auth-check', version: '0.1.0' });
    calls = [];
    await client.connect(new StreamableHTTPClientTransport(new URL('https://mcp.desearch.ai/mcp'), { reconnectionOptions: { maxRetries: 0 } }));
    let denied = false;
    try { const result = await client.callTool({ name: 'web-search', arguments: { query: 'Desearch official documentation' } }); denied = result.isError === true; }
    catch { denied = toolCalls().some(c => [401, 403].includes(c.status)); }
    finally { await client.close(); }
    assert.ok(denied, 'keyless protected call must fail');
    assert.equal(toolCalls().length, 1);
    console.log('PASS absent key at protected action', JSON.stringify(calls));

    mode = 'service';
    assert.match(await invoke({ query: 'Desearch official documentation' }), /request failed/);
    assert.equal(toolCalls().length, 1);
    console.log('PASS injected service 503: one protected call, zero retries');
    mode = 'network';
    assert.match(await invoke({ query: 'Desearch official documentation' }), /request failed/);
    assert.equal(calls.length, 1);
    console.log('PASS injected network outage: one request, zero retries');
    mode = 'live';

    while (Date.now() - started < 300_000) {
      console.log('OBSERVING', Math.floor((Date.now() - started) / 1000), 'seconds');
      await wait(Math.min(30_000, 300_000 - (Date.now() - started)));
    }
    const query2 = 'AnythingLLM custom agent skills developer guide';
    const second = await invoke({ query: query2 });
    assert.ok(!second.startsWith('Desearch request failed') && !second.startsWith('Desearch search failed'), 'second live search failed');
    assert.match(second, /https?:\/\//);
    assert.equal(toolCalls().length, 1);
    console.log(JSON.stringify({ cycle: 2, query: query2, calls, result: second }));
    console.log('OBSERVATION_END', new Date().toISOString(), 'elapsed_ms', Date.now() - started, 'successful_cycles', 2);

    ImportedPlugin.updateImportedPlugin('desearch-search', { active: false });
    assert.equal(ImportedPlugin.activeImportedPlugins().length, 0);
    host.removeFunction('desearch-search');
    assert.ok(!host.functions.has('desearch-search'));
    assert.ok(ImportedPlugin.deletePlugin('desearch-search'));
    assert.equal(ImportedPlugin.listImportedPlugins().length, 0);
    assert.ok(!ImportedPlugin.validateImportedPluginHandler('desearch-search'));
    console.log('PASS native disable, runtime disconnect, removal, rediscovery empty');
  } finally {
    global.fetch = originalFetch;
    if (fs.existsSync(path.join(skills, 'desearch-search'))) ImportedPlugin.deletePlugin('desearch-search');
  }
}
main().catch(error => {
  console.error('FAIL native-host smoke', error.name);
  console.error(error.stack.split('\n').filter(line => line.trimStart().startsWith('at ')).join('\n'));
  process.exitCode = 1;
});
