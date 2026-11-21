import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const ENDPOINT = 'https://mcp.desearch.ai/mcp';

export function parseQuery(text) {
  let input;
  try { input = JSON.parse(text); } catch { throw new Error('invalid_query'); }
  if (!input || Array.isArray(input) || typeof input.query !== 'string' ||
      !input.query.trim() || input.query.length > 2000 ||
      Object.keys(input).some(key => key !== 'query')) throw new Error('invalid_query');
  return input.query.trim();
}

export async function run(action, { env = process.env, clientFactory, read = readFile } = {}) {
  if (!['discover', 'search'].includes(action)) throw new Error('invalid_action');
  let query;
  if (action === 'search') {
    if (!env.HERDR_PLUGIN_CONFIG_DIR) throw new Error('missing_config');
    let text;
    try { text = await read(join(env.HERDR_PLUGIN_CONFIG_DIR, 'query.json'), 'utf8'); }
    catch { throw new Error('missing_query'); }
    query = parseQuery(text);
  }
  const client = clientFactory ? clientFactory() : new Client({ name: 'desearch-herdr', version: '0.1.0' });
  const key = env.DESEARCH_API_KEY;
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    requestInit: { headers: key ? { 'x-api-key': key } : {} },
    reconnectionOptions: { maxRetries: 0 },
  });
  const options = { timeout: 30000 };
  try {
    await client.connect(transport, options);
    if (action === 'discover') {
      const { tools } = await client.listTools({}, options);
      return { tools: tools.map(({ name, title, annotations }) => ({ name, title, annotations })) };
    }
    // Exactly one protected, read-only call. The shared server owns search logic.
    const result = await client.callTool({ name: 'web-search', arguments: { query } }, undefined, options);
    if (result.isError) throw new Error('service_error');
    return result;
  } finally {
    await client.close().catch(() => {});
  }
}

export function serialize(value, key) {
  const output = JSON.stringify(value);
  return key ? output.split(key).join('[REDACTED]') : output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(serialize(await run(process.argv[2]), process.env.DESEARCH_API_KEY));
  } catch (error) {
    const local = ['invalid_query', 'invalid_action', 'missing_config', 'missing_query'];
    const code = local.includes(error.message) ? error.message : 'service_error';
    // Remote errors may contain credentials or headers. Never log them.
    console.error(JSON.stringify({ error: code, message: code === 'service_error'
      ? 'Desearch request failed. Check key, service and network. No retry was made.'
      : 'Use a query.json file containing only a nonempty query string (up to 2000 characters).' }));
    process.exitCode = 1;
  }
}
