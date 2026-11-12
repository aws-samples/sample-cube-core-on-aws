import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Mock Cube API: /meta returns one view, /load answers "Continue wait" once before returning data.
let loadCalls = 0;
const seenAuth: string[] = [];
const cube = http.createServer((req, res) => {
  seenAuth.push(String(req.headers.authorization));
  res.setHeader('Content-Type', 'application/json');
  if (req.headers.authorization !== 'good-token') {
    res.statusCode = 403;
    return res.end(JSON.stringify({ error: 'Invalid token' }));
  }
  if (req.url?.startsWith('/cubejs-api/v1/meta')) {
    return res.end(JSON.stringify({
      cubes: [{ name: 'orders_view', type: 'view', measures: [{ name: 'orders_view.count', type: 'number' }], dimensions: [{ name: 'orders_view.created_at', type: 'time' }], segments: [] }],
    }));
  }
  if (req.url === '/cubejs-api/v1/load') {
    loadCalls++;
    if (loadCalls === 1) return res.end(JSON.stringify({ error: 'Continue wait' }));
    return res.end(JSON.stringify({ results: [{ data: [{ 'orders_view.count': '42' }], usedPreAggregations: {} }] }));
  }
  res.statusCode = 404;
  res.end('{}');
});

let handler: typeof import('../src/lambda.js').handler;

before(async () => {
  await new Promise<void>((r) => cube.listen(0, '127.0.0.1', r));
  process.env.CUBE_API_URL = `http://127.0.0.1:${(cube.address() as AddressInfo).port}`;
  ({ handler } = await import('../src/lambda.js'));
});
after(() => cube.close());

const call = (body: unknown, token = 'good-token') =>
  handler({
    httpMethod: 'POST',
    path: '/mcp',
    headers: {
      host: 'example.cloudfront.net',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    isBase64Encoded: false,
    queryStringParameters: {},
    requestContext: { elb: { targetGroupArn: 'arn' } },
  } as any);

test('rejects requests without a bearer token', async () => {
  const res = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, '');
  assert.equal(res.statusCode, 401);
});

test('rejects initialize / tools/list with a token Cube does not accept', async () => {
  for (const method of ['initialize', 'tools/list']) {
    const res = await call({ jsonrpc: '2.0', id: 1, method, params: {} }, 'bad-token');
    assert.equal(res.statusCode, 401, method);
  }
  seenAuth.length = 0; // later tests assert that only the good token reached Cube
});

test('initialize + tools/list', async () => {
  const init = await call({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  });
  assert.equal(init.statusCode, 200);
  assert.equal(JSON.parse(init.body!).result.serverInfo.name, 'cube-core');

  const list = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = JSON.parse(list.body!).result.tools.map((t: any) => t.name).sort();
  assert.deepEqual(names, ['cube_describe_model', 'cube_generate_sql', 'cube_list_models', 'cube_query']);
});

test('cube_query polls "Continue wait" and passes the token through', async () => {
  const res = await call({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'cube_query', arguments: { measures: ['orders_view.count'] } },
  });
  const payload = JSON.parse(JSON.parse(res.body!).result.content[0].text);
  assert.equal(payload.data[0]['orders_view.count'], '42');
  assert.equal(loadCalls, 2);
  assert.ok(seenAuth.every((a) => a === 'good-token'));
});

test('Cube auth errors surface as tool errors', async () => {
  const res = await call({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'cube_list_models', arguments: {} },
  }, 'bad-token');
  const result = JSON.parse(res.body!).result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /403/);
});
