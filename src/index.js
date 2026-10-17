#!/usr/bin/env node
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

// .env next to the repo, not the client's cwd; dotenv v16 prints nothing
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('trading-mcp server running on stdio');
}

main().catch((err) => {
  console.error('Fatal error starting trading-mcp:', err);
  process.exit(1);
});
