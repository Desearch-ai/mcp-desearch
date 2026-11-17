const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const ENDPOINT = 'https://mcp.desearch.ai/mcp';
const TIMEOUT_MS = 60_000;

module.exports.runtime = {
  title: 'Desearch Search',
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  async handler(input) {
    if (!input || typeof input.query !== 'string' || !input.query.trim() ||
        input.query.length > 2000 || Object.keys(input).some(key => key !== 'query')) {
      return 'Desearch input error: supply only a non-empty query string (maximum 2000 characters).';
    }
    const key = this.runtimeArgs?.DESEARCH_API_KEY;
    if (typeof key !== 'string' || !key.trim()) {
      return 'Desearch configuration error: set DESEARCH_API_KEY in the skill settings.';
    }

    const deadline = AbortSignal.timeout(TIMEOUT_MS);
    const client = new Client({ name: 'desearch-anythingllm-skill', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
      requestInit: { headers: { 'x-api-key': key.trim() } },
      reconnectionOptions: { maxRetries: 0 },
      // Never follow a redirect with the key or allow a caller to change the destination.
      fetch: (url, options = {}) => fetch(url, {
        ...options,
        redirect: 'error',
        signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
      }),
    });
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: 'web-search', arguments: { query: input.query.trim() },
      }, undefined, { timeout: TIMEOUT_MS });
      // Do not reflect service diagnostics, headers, or transport errors into agent logs.
      if (result.isError) return 'Desearch search failed. Check the API key, balance and service status. No retry was made.';
      const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
      return text.split(key.trim()).join('[REDACTED]') || 'Desearch returned no text results.';
    } catch {
      return 'Desearch request failed. Check the API key, network and service status. No retry was made.';
    } finally {
      await client.close().catch(() => {});
    }
  },
};
