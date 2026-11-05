// RFC-030 T3 — guards that @modelcontextprotocol/sdk resolves and exposes the
// classes modules/resource-catalog/infrastructure/mcpProbe.ts depends on. If a future bun.lock prune drops
// the dep, this fails at the test layer before runtime probe attempts crash.

import { describe, expect, test } from 'bun:test'

describe('@modelcontextprotocol/sdk resolution', () => {
  test('Client + StdioClientTransport + StreamableHTTPClientTransport + SSEClientTransport import', async () => {
    const [{ Client }, stdio, streamable, sse] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/stdio.js'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
      import('@modelcontextprotocol/sdk/client/sse.js'),
    ])
    expect(typeof Client).toBe('function')
    expect(typeof stdio.StdioClientTransport).toBe('function')
    expect(typeof streamable.StreamableHTTPClientTransport).toBe('function')
    expect(typeof sse.SSEClientTransport).toBe('function')
  })

  test('auth error class is exported (UnauthorizedError used for auth-required mapping)', async () => {
    const mod = await import('@modelcontextprotocol/sdk/client/auth.js')
    expect(typeof mod.UnauthorizedError).toBe('function')
  })
})
