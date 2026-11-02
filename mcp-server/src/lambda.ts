/**
 * Remote MCP endpoint (Streamable HTTP, stateless, JSON responses) running on AWS Lambda
 * behind the internal Application Load Balancer at path /mcp.
 *
 * Authentication: the caller sends `Authorization: Bearer <Cube JWT>`. The token is passed
 * through to Cube unchanged, so Cube verifies it and applies the caller's security context.
 * The Lambda itself never holds the Cube API secret.
 */
import type { ALBEvent, ALBResult } from 'aws-lambda';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CubeClient } from './cube-client.js';
import { createCubeMcpServer } from './server.js';

const CUBE_API_URL = process.env.CUBE_API_URL!;
const MAX_BODY_BYTES = 1024 * 1024;

const jsonRpcError = (statusCode: number, message: string, extraHeaders: Record<string, string> = {}): ALBResult => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', ...extraHeaders },
  body: JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }),
  isBase64Encoded: false,
});

export async function handler(event: ALBEvent): Promise<ALBResult> {
  const headers = Object.fromEntries(
    Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v ?? '']),
  );

  const auth = headers['authorization'] ?? '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return jsonRpcError(401, 'Missing Authorization: Bearer <Cube JWT> header', { 'WWW-Authenticate': 'Bearer' });
  }

  if (event.httpMethod !== 'POST') {
    // Stateless server: no standalone SSE stream (GET) and no sessions to delete (DELETE).
    return jsonRpcError(405, 'Method not allowed', { Allow: 'POST' });
  }

  const rawBody = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '';
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) {
    return jsonRpcError(413, 'Request body too large');
  }

  const url = `https://${headers['host'] ?? 'localhost'}${event.path}`;
  const request = new Request(url, {
    method: 'POST',
    headers: {
      'content-type': headers['content-type'] || 'application/json',
      accept: headers['accept'] || 'application/json, text/event-stream',
      ...(headers['mcp-protocol-version'] ? { 'mcp-protocol-version': headers['mcp-protocol-version'] } : {}),
    },
    body: rawBody,
  });

  const server = createCubeMcpServer(new CubeClient({ baseUrl: CUBE_API_URL, token, timeoutMs: 25_000 }));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    const body = await response.text();
    const outHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      outHeaders[k] = v;
    });
    return {
      statusCode: response.status,
      headers: outHeaders,
      body,
      isBase64Encoded: false,
    };
  } catch (err) {
    console.error('MCP request failed', err);
    return jsonRpcError(500, 'Internal server error');
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}
