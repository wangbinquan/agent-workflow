import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { eq } from 'drizzle-orm'
import { buildActor, SYSTEM_USER_ID } from '../src/auth/actor'
import { createInMemoryDb } from '../src/db/client'
import {
  mcps,
  mcpRuntimeTestSessions,
  mcpRuntimeTestTurns,
  nodeRuns,
  runtimes,
  tasks,
} from '../src/db/schema'
import { getMcpById } from '../src/services/mcp'
import { McpRuntimeTestService } from '../src/services/mcpRuntimeTest'
import { mcpOperationConfigHashOf } from '../src/services/mcpOperationRevision'
import { ContainmentCoordinator } from '../src/services/sandbox'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_RUNTIME = resolve(import.meta.dir, 'fixtures', 'rfc238', 'mock-claude-runtime.js')
const tempDirs: string[] = []

const actor = buildActor({
  user: {
    id: SYSTEM_USER_ID,
    username: SYSTEM_USER_ID,
    displayName: 'System',
    role: 'admin',
    status: 'active',
  },
  source: 'daemon',
})

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))
  }
}

async function allocateLoopbackPort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolveListen, rejectListen) => {
    probe.once('error', rejectListen)
    probe.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolveListen)
  })
  const address = probe.address()
  const port = typeof address === 'object' && address !== null ? address.port : null
  await new Promise<void>((resolveClose, rejectClose) => {
    probe.close((error) => (error === undefined ? resolveClose() : rejectClose(error)))
  })
  if (port === null) throw new Error('failed to allocate loopback port')
  return port
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('RFC-238 real process multi-turn fixture', () => {
  test('Claude resumes one native session and calls exactly the mounted stateful MCP', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc238-real-e2e-'))
    tempDirs.push(root)
    const runtimeBinary = join(root, 'bin', 'mock-claude')
    mkdirSync(join(root, 'bin'), { recursive: true, mode: 0o700 })
    copyFileSync(MOCK_RUNTIME, runtimeBinary)
    chmodSync(runtimeBinary, 0o500)
    const requests: Array<{
      method: string
      authorization: string | null
      params: Record<string, unknown>
    }> = []
    let counter = 0
    const port = await allocateLoopbackPort()
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port,
      async fetch(request) {
        const authorization = request.headers.get('authorization')
        if (authorization !== 'Bearer rfc238-fixture-secret') {
          return Response.json({ error: 'unauthorized' }, { status: 401 })
        }
        const rpc = (await request.json()) as {
          id: number
          method: string
          params?: Record<string, unknown>
        }
        const params = rpc.params ?? {}
        requests.push({ method: rpc.method, authorization, params })
        if (rpc.method === 'initialize') {
          return Response.json({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'rfc238-fixture', version: '1' },
            },
          })
        }
        if (rpc.method === 'tools/list') {
          return Response.json({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              tools: [
                {
                  name: 'stateful_increment',
                  description: 'increments fixture state',
                  inputSchema: { type: 'object' },
                },
              ],
            },
          })
        }
        if (rpc.method === 'tools/call') {
          counter += 1
          return Response.json({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    counter,
                    previousTurnCount: (
                      params.arguments as { previousTurnCount?: number } | undefined
                    )?.previousTurnCount,
                  }),
                },
              ],
            },
          })
        }
        return Response.json(
          {
            jsonrpc: '2.0',
            id: rpc.id,
            error: { code: -32601, message: 'method not found' },
          },
          { status: 404 },
        )
      },
    })
    const previousApiKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'rfc238-test-only'
    try {
      const db = createInMemoryDb(MIGRATIONS)
      db.insert(runtimes)
        .values({
          id: 'runtime-claude-fixture',
          name: 'claude-fixture',
          protocol: 'claude-code',
          binaryPath: runtimeBinary,
          model: 'mock-model',
          enabled: true,
        })
        .run()
      db.insert(mcps)
        .values({
          id: 'mcp-fixture',
          name: 'stateful_fixture',
          description: '',
          type: 'remote',
          config: JSON.stringify({
            url: `http://127.0.0.1:${server.port}/mcp`,
            headers: { Authorization: 'Bearer rfc238-fixture-secret' },
          }),
          enabled: true,
          ownerUserId: SYSTEM_USER_ID,
          visibility: 'private',
        })
        .run()
      const mcp = await getMcpById(db, 'mcp-fixture')
      if (mcp === null) throw new Error('fixture MCP missing')
      const service = new McpRuntimeTestService({
        db,
        configPath: join(root, 'config.json'),
        appHome: root,
        containmentCoordinator: new ContainmentCoordinator({
          provider: {
            mode: 'off',
            status: { mechanism: null, available: false, detail: null },
            appHome: root,
          },
        }),
      })

      const created = await service.create(actor, mcp, {
        expectedMcpConfigHash: mcpOperationConfigHashOf(mcp),
        runtimeName: 'claude-fixture',
        message: 'first real turn',
        clientCreateId: 'real-create-1',
        clientMessageId: 'real-message-1',
      })
      await waitFor(
        async () => (await service.get(actor, mcp.id, created.sessionId)).inFlightTurnId === null,
      )
      const nativeSessionId = db
        .select({ id: mcpRuntimeTestSessions.runtimeSessionId })
        .from(mcpRuntimeTestSessions)
        .where(eq(mcpRuntimeTestSessions.id, created.sessionId))
        .get()?.id
      expect(nativeSessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      )

      let session = await service.get(actor, mcp.id, created.sessionId)
      await service.message(actor, mcp, session.id, {
        message: 'second real turn',
        clientMessageId: 'real-message-2',
        expectedSessionVersion: session.sessionVersion,
      })
      await waitFor(
        async () => (await service.get(actor, mcp.id, created.sessionId)).inFlightTurnId === null,
      )
      session = await service.get(actor, mcp.id, created.sessionId)

      expect(session.status).toBe('active')
      expect(session.turns.map((turn) => turn.status)).toEqual(['succeeded', 'succeeded'])
      expect(
        db
          .select({ id: mcpRuntimeTestSessions.runtimeSessionId })
          .from(mcpRuntimeTestSessions)
          .where(eq(mcpRuntimeTestSessions.id, created.sessionId))
          .get()?.id,
      ).toBe(nativeSessionId)
      expect(requests.map((request) => request.method)).toEqual([
        'initialize',
        'tools/list',
        'tools/call',
        'initialize',
        'tools/list',
        'tools/call',
      ])
      expect(
        requests
          .filter((request) => request.method === 'tools/call')
          .map(
            (request) =>
              (
                request.params.arguments as {
                  previousTurnCount?: number
                }
              ).previousTurnCount,
          ),
      ).toEqual([0, 1])
      expect(requests.every((request) => request.authorization !== null)).toBe(true)

      const rendered = JSON.stringify(await service.sessionView(actor, mcp.id, session.id))
      expect(rendered).toContain('first real turn')
      expect(rendered).toContain('second real turn')
      expect(rendered).toContain('mcp__stateful_fixture__stateful_increment')
      expect(rendered).toContain('counter=1')
      expect(rendered).toContain('counter=2')
      const turnReceipts = db
        .select({
          raw: mcpRuntimeTestTurns.rawCommandDigest,
          wrapped: mcpRuntimeTestTurns.spawnCommandDigest,
          binary: mcpRuntimeTestTurns.spawnBinaryPath,
        })
        .from(mcpRuntimeTestTurns)
        .where(eq(mcpRuntimeTestTurns.sessionId, session.id))
        .all()
      expect(turnReceipts).toHaveLength(2)
      for (const receipt of turnReceipts) {
        expect(receipt.raw).toMatch(/^[0-9a-f]{64}$/)
        expect(receipt.wrapped).toMatch(/^[0-9a-f]{64}$/)
        expect(receipt.binary).toContain('/runtime-bin/claude')
      }
      expect(db.select().from(tasks).all()).toHaveLength(0)
      expect(db.select().from(nodeRuns).all()).toHaveLength(0)

      const ended = await service.end(actor, mcp.id, session.id)
      expect(ended.session.status).toBe('ended')
      expect(ended.session.cleanupState).toBe('complete')
    } finally {
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previousApiKey
      server.stop(true)
    }
  }, 15_000)
})
