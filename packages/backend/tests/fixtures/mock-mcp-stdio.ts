#!/usr/bin/env bun
// RFC-030 T7 — fixture stdio MCP server used by mcp-probe-stdio-integration.test.ts.
//
// Modes (selected via process.argv[2]):
//   "ok"           — registers 4 tools, 1 resource, 1 prompt and serves them
//   "crash"        — exits 1 immediately (probe sees connect-failed-ish)
//   "hang"         — never starts the protocol handshake
//   "no-resources" — like "ok" but listResources throws MethodNotFound
//
// Kept intentionally tiny: no zod schemas on tools, no external deps. The
// probe service only cares that listTools / listResources / listPrompts
// return a well-formed envelope.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const mode = process.argv[2] ?? 'ok'

if (mode === 'crash') {
  process.stderr.write('mock-mcp-stdio: crash mode requested\n')
  process.exit(1)
}

if (mode === 'hang') {
  await new Promise<never>(() => {})
}

const server = new McpServer(
  { name: 'mock-mcp-stdio', version: '0.1.0' },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
)

// Four tools — distinct names so the integration test can pin the count.
server.tool('query', 'Run a SQL query', async () => ({
  content: [{ type: 'text', text: 'ok' }],
}))
server.tool('explain', async () => ({ content: [{ type: 'text', text: 'ok' }] }))
server.tool('schema', async () => ({ content: [{ type: 'text', text: 'ok' }] }))
server.tool('ping', async () => ({ content: [{ type: 'text', text: 'ok' }] }))

if (mode !== 'no-resources') {
  server.resource('docs', 'file:///docs/README.md', async () => ({
    contents: [{ uri: 'file:///docs/README.md', text: 'hello' }],
  }))
}

server.prompt('summarize', async () => ({
  messages: [{ role: 'user', content: { type: 'text', text: 'summarize this' } }],
}))

const transport = new StdioServerTransport()
await server.connect(transport)
