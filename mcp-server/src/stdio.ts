/**
 * Local MCP server over stdio. Usage:
 *   CUBE_API_URL=https://dxxxx.cloudfront.net CUBE_API_TOKEN=eyJ... node dist/stdio.mjs
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CubeClient } from './cube-client.js';
import { createCubeMcpServer } from './server.js';

const baseUrl = process.env.CUBE_API_URL;
const token = process.env.CUBE_API_TOKEN;
if (!baseUrl || !token) {
  console.error('CUBE_API_URL and CUBE_API_TOKEN environment variables are required.');
  process.exit(1);
}

const server = createCubeMcpServer(new CubeClient({ baseUrl, token, timeoutMs: 120_000 }));
await server.connect(new StdioServerTransport());
console.error(`cube-mcp-server connected to ${baseUrl}`);
