// Deterministic model fixture; Jan itself installs/discovers/calls real MCP tools.
// No MCP client library or substitute search implementation is used here.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const jan = process.env.JAN_BIN;
const key = process.env.DESEARCH_API_KEY;
assert.ok(jan && path.isAbsolute(jan), 'Set JAN_BIN to the absolute Jan Agent binary path');
assert.ok(key, 'Set DESEARCH_API_KEY through your secret manager');
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), 'desearch-jan-'));
const project = path.join(temp, 'project');
const data = path.join(temp, 'data');
const fixture = path.join(temp, 'desearch');
await Promise.all([mkdir(project), mkdir(data), mkdir(fixture)]);
const env = { ...process.env, JAN_DATA_FOLDER: data, JAN_CLI_NO_UPDATE_CHECK: '1' };
// No key is forwarded to the local model fixture or included in a task prompt.
delete env.DESEARCH_API_KEY;
const sanitize = (text) => String(text).split(key).join('[REDACTED]');
const record = (name, result) => console.log(JSON.stringify({ at: new Date().toISOString(), name, result }));
async function run(bin, args, cwd = root, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 90000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      const result = { code, stdout: sanitize(stdout), stderr: sanitize(stderr) };
      if (code !== 0 && !options.allowFailure) reject(new Error(JSON.stringify(result)));
      else resolve(result);
    });
  });
}
let phase;
let calls = [];
let catalog = [];
const model = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fixture', object: 'model', owned_by: 'local-test' }] }));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    catalog = (request.tools || []).map((t) => t.function?.name || t.name);
    const messages = request.messages || [];
    const result = [...messages].reverse().find((m) => m.role === 'tool');
    let message;
    if (result) {
      calls.push(result.content);
      message = { role: 'assistant', content: 'Native Jan tool cycle complete.' };
    } else {
      const name = catalog.find((n) => phase.skill ? /skill_read$/.test(n) : n === 'web-search');
      if (!name) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'No expected MCP tool advertised; connection failed or unavailable.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      const args = phase.skill ? { name: 'desearch:desearch' } : phase.args;
      message = { role: 'assistant', content: null, tool_calls: [{
        id: 'jan_fixture_call', type: 'function', function: { name, arguments: JSON.stringify(args) },
      }] };
    }
    if (request.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = { ...message };
      if (delta.tool_calls) delta.tool_calls = delta.tool_calls.map((t, index) => ({ index, ...t }));
      res.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }
  } catch (error) {
    res.writeHead(500); res.end(sanitize(error.message));
  }
});
await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${model.address().port}/v1`;
async function cycle(name, spec) {
  phase = spec; calls = []; catalog = [];
  const output = await run(jan, ['cli', 'agent', 'run', '--project', project,
    '--provider', 'openai', '--api-key', 'local-fixture-only', '--base-url', baseURL,
    '--model', 'fixture', '--max-turns', '3', '--output-format', 'json',
    'Execute the single predetermined public read/search test tool call.']);
  const result = { calls, catalog: catalog.filter((n) => /desearch|skill_read|web-search/.test(n)), host: output };
  record(name, result);
  return result;
}
let server;
async function configure(value, url = server.url) {
  const args = ['cli', 'mcp', 'add', 'desearch:desearch', '--type', server.type, '--url', url, '--active'];
  if (value !== undefined) args.push('--header', `x-api-key=${value}`);
  return run(jan, args);
}
try {
  record('version', await run(jan, ['--version']));
  // Export the committed subtree to a git root, exactly as documented.
  const archive = path.join(temp, 'jan.tar');
  await run('git', ['archive', '--format=tar', '--output', archive, 'HEAD:plugin/integrations/jan'], path.resolve(root, '../../..'));
  await run('tar', ['-xf', archive, '-C', fixture]);
  await run('git', ['init', '--quiet'], fixture);
  await run('git', ['add', '.'], fixture);
  await run('git', ['-c', 'user.name=Jan test fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Local install fixture'], fixture);
  server = JSON.parse(await readFile(path.join(fixture, '.mcp.json'), 'utf8')).mcpServers.desearch;
  record('install', await run(jan, ['plugin', 'install', `file://${fixture}`, '--project', project]));
  record('list', await run(jan, ['plugin', 'list', '--project', project]));
  record('no-implicit-activation', await run(jan, ['cli', 'mcp', 'list']));
  const skill = await cycle('skill-discovery', { skill: true });
  assert.match(JSON.stringify(skill.calls), /Desearch in Jan/);
  await configure(key);
  const configMode = (await import('node:fs/promises')).stat;
  assert.equal((await configMode(path.join(data, 'mcp_config.json'))).mode & 0o777, 0o600);
  const start = Date.now(); record('observation-start', new Date(start).toISOString());
  const first = await cycle('search-1', { args: { query: 'Jan Agent plugin documentation' } });
  assert.equal(first.calls.length, 1);
  assert.match(JSON.stringify(first.calls), /https?:/);
  const second = await cycle('search-2', { args: { query: 'Desearch MCP hosted HTTP documentation' } });
  assert.equal(second.calls.length, 1);
  assert.match(JSON.stringify(second.calls), /https?:/);
  const malformed = await cycle('malformed', { args: { query: 42 } });
  assert.match(JSON.stringify(malformed.calls), /error|invalid|expected/i);
  await configure(undefined);
  const missing = await cycle('missing-key', { args: { query: 'Jan Agent documentation' } });
  assert.match(JSON.stringify(missing.calls), /unauthorized|401|api.key|authentication/i);
  await configure('invalid-jan-fixture-key');
  const invalid = await cycle('invalid-key', { args: { query: 'Jan Agent documentation' } });
  assert.match(JSON.stringify(invalid.calls), /unauthorized|401|invalid|api.key|authentication/i);
  // Closed loopback port: no credential is sent to another external service.
  await configure(undefined, 'http://127.0.0.1:1/mcp');
  phase = { args: { query: 'Jan Agent documentation' } }; calls = [];
  const failure = await run(jan, ['cli', 'agent', 'run', '--project', project,
    '--provider', 'openai', '--api-key', 'local-fixture-only', '--base-url', baseURL,
    '--model', 'fixture', '--max-turns', '1', '--output-format', 'json', 'Check the test connection.'], root, { allowFailure: true });
  record('network-failure', failure);
  assert.match(JSON.stringify(failure), /failed|connect|refused/i);
  await configure(key);
  const remaining = 300000 - (Date.now() - start);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  const final = await cycle('observation-end-search', { args: { query: 'Jan Agent skills documentation' } });
  assert.equal(final.calls.length, 1);
  assert.match(JSON.stringify(final.calls), /https?:/);
  record('observation-complete', { start: new Date(start).toISOString(), end: new Date().toISOString(), durationMs: Date.now() - start, successfulSearchCycles: 3, automaticRetries: 0 });
  record('disable', await run(jan, ['cli', 'mcp', 'disable', 'desearch:desearch']));
  record('remove-server', await run(jan, ['cli', 'mcp', 'remove', 'desearch:desearch']));
  const removed = await run(jan, ['cli', 'mcp', 'list']); record('servers-after-removal', removed);
  assert.ok(!removed.stdout.includes('desearch:desearch'));
  record('remove-plugin', await run(jan, ['plugin', 'remove', 'desearch', '--project', project]));
  const plugins = await run(jan, ['plugin', 'list', '--project', project]); record('plugins-after-removal', plugins);
  assert.ok(!plugins.stdout.includes('desearch'));
} finally {
  // Never leave a test key in the Jan data folder, including on failed checks.
  await run(jan, ['cli', 'mcp', 'remove', 'desearch:desearch'], root, { allowFailure: true }).catch(() => {});
  await run(jan, ['plugin', 'remove', 'desearch', '--project', project], root, { allowFailure: true }).catch(() => {});
  model.close();
  await rm(temp, { recursive: true, force: true });
}
