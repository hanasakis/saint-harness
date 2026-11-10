import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { testProviderConnection } from '../electron/provider-test';
import type { ProviderConfig } from '../shared/types';

async function fixture(handler: http.RequestListener, run: (baseUrl: string) => Promise<void>) {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${(server.address() as { port: number }).port}`); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('connection test uses each provider API path and authentication without a conversation request', async () => {
  const calls: { path?: string; method?: string; key?: string; version?: string }[] = [];
  await fixture((req, res) => {
    calls.push({ path: req.url, method: req.method, key: String(req.headers['x-api-key'] || req.headers.authorization || ''), version: req.headers['anthropic-version'] as string });
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
  }, async baseUrl => {
    for (const id of ['anthropic','openai','deepseek','custom'] as const) {
      const provider: ProviderConfig = { id, name: id, baseUrl: baseUrl + (id === 'openai' || id === 'custom' ? '/v1/' : '/'), modelId: 'test-model' };
      const result = await testProviderConnection(provider, 'test-key');
      assert.equal(result.ok, true); assert.equal(result.modelCount, 1); assert.ok(result.elapsedMs >= 0);
      assert.equal(calls.at(-1)?.path, id === 'deepseek' ? '/models' : '/v1/models');
      assert.equal(calls.at(-1)?.method, 'GET');
      assert.equal(calls.at(-1)?.key, id === 'anthropic' ? 'test-key' : 'Bearer test-key');
    }
    assert.equal(calls[0].version, '2023-06-01');
    assert.equal((await testProviderConnection({id:'custom',name:'local',baseUrl,modelId:'test-model'}, '')).ok, true);
    assert.equal(calls.at(-1)?.key, '');
  });
});

test('HTTP errors are actionable and do not expose reflected credentials; redirects are not followed', async () => {
  let status = 401; let calls = 0;
  await fixture((_req, res) => { calls++; res.writeHead(status, {Location:'/credential-target'}); res.end('reflected-secret-key'); }, async baseUrl => {
    for (const code of [401,403,404,405,429,503,302]) {
      status = code;
      const result = await testProviderConnection({id:'openai',name:'OpenAI',baseUrl}, 'reflected-secret-key');
      assert.equal(result.ok, false); assert.ok(!JSON.stringify(result).includes('reflected-secret-key'));
      assert.match(result.message, code === 302 ? /重定向/ : new RegExp(String(code)));
    }
    assert.equal(calls, 7);
  });
});

test('successful HTTP responses must contain available models, including the requested custom model', async () => {
  let body = '<html>login</html>';
  await fixture((_req, res) => res.end(body), async baseUrl => {
    const provider: ProviderConfig = {id:'custom',name:'local',baseUrl,modelId:'wanted'};
    for (const payload of ['<html>login</html>', 'null', '{}', '{"data":[{}]}', '{"data":[]}', '{"data":[{"id":"other"}]}']) {
      body = payload; assert.equal((await testProviderConnection(provider, '')).ok, false);
    }
    body = '{"data":[{"id":"wanted"}]}'; assert.equal((await testProviderConnection(provider, '')).ok, true);
    body = 'x'.repeat(2 * 1024 * 1024 + 1); assert.match((await testProviderConnection(provider, '')).message, /过大/);
  });
});

test('connection testing times out both before headers and during body streaming and validates input', async () => {
  let headers = false;
  await fixture((_req,res) => { if (headers) { res.writeHead(200); res.write('{"data":'); } }, async baseUrl => {
    const provider: ProviderConfig = {id:'openai',name:'OpenAI',baseUrl};
    assert.match((await testProviderConnection(provider, 'test', 50)).message, /超时/);
    headers = true; assert.match((await testProviderConnection(provider, 'test', 50)).message, /超时/);
    assert.match((await testProviderConnection(provider, '')).message, /API Key/);
    assert.match((await testProviderConnection({...provider,id:'custom'}, '')).message, /模型 ID/);
    for (const invalid of ['ftp://example.com', 'https://user:pass@example.com', 'https://example.com?key=secret']) {
      assert.match((await testProviderConnection({...provider,baseUrl:invalid}, 'test')).message, /有效/);
    }
  });
});
