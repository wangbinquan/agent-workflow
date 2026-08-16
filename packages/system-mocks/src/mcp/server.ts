import type { IncomingMessage, ServerResponse } from 'node:http'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

import { writeJson } from '../core/http'

export class McpHttpMock {
  readonly #sse = new Map<string, { server: McpServer; transport: SSEServerTransport }>()

  async handle(input: {
    request: IncomingMessage
    response: ServerResponse
    url: URL
    body: Buffer
  }): Promise<boolean> {
    if (input.url.pathname === '/mcp' && input.request.method === 'POST') {
      const server = createMockMcpServer('system-mock-mcp-http')
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      try {
        await server.connect(transport)
        const parsed = input.body.length === 0 ? undefined : JSON.parse(input.body.toString('utf8'))
        await transport.handleRequest(input.request, input.response, parsed)
      } catch (error) {
        if (!input.response.headersSent) {
          writeJson(input.response, 500, {
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : String(error),
            },
          })
        }
      } finally {
        await transport.close().catch(() => {})
        await server.close().catch(() => {})
      }
      return true
    }
    if (input.url.pathname === '/mcp/sse' && input.request.method === 'GET') {
      const server = createMockMcpServer('system-mock-mcp-sse')
      const transport = new SSEServerTransport('/mcp/messages', input.response)
      this.#sse.set(transport.sessionId, { server, transport })
      transport.onclose = () => {
        this.#sse.delete(transport.sessionId)
        void server.close().catch(() => {})
      }
      await server.connect(transport)
      return true
    }
    if (input.url.pathname === '/mcp/messages' && input.request.method === 'POST') {
      const sessionId = input.url.searchParams.get('sessionId') ?? ''
      const session = this.#sse.get(sessionId)
      if (session === undefined) {
        writeJson(input.response, 404, { error: 'unknown MCP SSE session' })
        return true
      }
      const parsed = input.body.length === 0 ? undefined : JSON.parse(input.body.toString('utf8'))
      await session.transport.handlePostMessage(input.request, input.response, parsed)
      return true
    }
    return false
  }

  async close(): Promise<void> {
    const sessions = [...this.#sse.values()]
    this.#sse.clear()
    await Promise.all(
      sessions.flatMap(({ server, transport }) => [
        transport.close().catch(() => {}),
        server.close().catch(() => {}),
      ]),
    )
  }
}

export function createMockMcpServer(name = 'system-mock-mcp'): McpServer {
  const server = new McpServer(
    { name, version: '1.0.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  )
  server.tool('ping', 'Return a deterministic pong', async () => ({
    content: [{ type: 'text', text: 'pong' }],
  }))
  server.tool('echo', 'Echo the supplied input', async () => ({
    content: [{ type: 'text', text: 'system mock echo' }],
  }))
  server.tool('query', 'Return deterministic query data', async () => ({
    content: [{ type: 'text', text: JSON.stringify({ rows: [{ id: 1, value: 'mock' }] }) }],
  }))
  server.tool('fail', 'Return a deterministic MCP tool error', async () => ({
    isError: true,
    content: [{ type: 'text', text: 'system mock tool failure' }],
  }))
  server.resource('docs', 'file:///system-mock/README.md', async () => ({
    contents: [
      {
        uri: 'file:///system-mock/README.md',
        mimeType: 'text/markdown',
        text: '# System mock MCP resource\n',
      },
    ],
  }))
  server.prompt('summarize', async () => ({
    messages: [
      { role: 'user', content: { type: 'text', text: 'Summarize the system mock resource.' } },
    ],
  }))
  return server
}
