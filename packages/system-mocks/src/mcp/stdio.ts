#!/usr/bin/env bun

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { createMockMcpServer } from './server'

const mode =
  (process.argv[2] === 'mcp-stdio' ? process.argv[3] : process.argv[2]) ??
  process.env.AW_SYSTEM_MOCK_MCP_MODE ??
  'ok'

if (mode === 'crash') {
  process.stderr.write('system mock MCP: crash mode requested\n')
  process.exit(1)
}
if (mode === 'hang') {
  await new Promise(() => {})
}

const server = createMockMcpServer('system-mock-mcp-stdio')
const transport = new StdioServerTransport()
await server.connect(transport)
