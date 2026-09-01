import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
import { McpRuntimeTestService } from '../src/services/mcpRuntimeTest'
import { mcpOperationConfigHashOf } from '../src/services/mcpOperationRevision'
import { composeSqliteMcpRuntimeTestProvider } from '../src/modules/resource-catalog/composition/mcpRuntimeTestPersistence'
import { SqliteRuntimeRegistryPersistence } from '../src/platform/runtime-registry/infrastructure/sqliteRuntimeRegistryPersistence'
import {
  composeMcpServiceBindingForTest,
  getMcpByIdForTest as getMcpById,
} from './helpers/mcpServiceBinding'

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

/**
 * RFC-254 T31 — the internal poll budget must fit INSIDE the test's own budget,
 * not undercut it.
 *
 * This helper defaulted to 5 s while the test that uses it declares 15 s, so
 * the outer allowance could never be reached: a real Claude turn that ran a
 * little long failed here as `condition timed out` rather than as a timeout,
 * which reads like a product assertion. 12 s leaves headroom under the 15 s
 * while still failing well before it — and Windows, where process spawning is
 * slower, would have inherited the tighter one.
 */
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('RFC-238 real process multi-turn fixture', () => {
  // RFC-254 T31: POSIX-form-mock E2E. The mock runtime (`mock-claude-runtime.js`)
  // is copied to an EXTENSIONLESS `bin/mock-claude` and relies on a POSIX
  // `#!`-style launch; win32 cannot spawn an extensionless JS file, so turn 1
  // never responds and turn 2 raises `ConflictError`. This is a test-fixture
  // limitation, not a product defect: production spawns a real `.exe` via
  // snapshotExecutableExtension (covered by rfc254-snapshot-executable-extension),
  // and the platform-agnostic session/MCP logic is covered by the other rfc238
  // suites that run on win32. A win32-runnable mock is E2E-infra follow-up.
  // Registered in test-suite-policy.
  test.skipIf(process.platform === 'win32')(
    'Claude resumes one native session and calls exactly the mounted stateful MCP',
    async () => {
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
      // RFC-312 门禁实撞（2026-08-19）：这里原先走「node 探一个临时端口 → close() →
      // 再拿这个号 Bun.serve」，probe 关闭到重新绑定之间有真实窗口，4 个并发 shard 下
      // 会被别的进程抢走——本用例因此偶发红在 `code-host-http-error … HTTP 503`，而本文件
      // 的桩对任何请求都只回 201、根本产不出 503（判据：503 来自占了同一端口的别人）。
      // 原注释称「Bun 1.3.13 在 macOS 上拒绝 Bun.serve({ port: 0 })」——**实测已不成立**
      // （同版本 bun 上 `Bun.serve({port:0})` 正常返回分配到的端口），故改为让 Bun 自己要
      // 端口、下游一律读 `server.port`：绑定与占用不可分割，窗口从根上消失。
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
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
      const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
      process.env.ANTHROPIC_API_KEY = 'rfc238-test-only'
      // RFC-276: the product no longer manufactures a private Claude config
      // directory. Model an operator-provided directory and prove that natural
      // environment inheritance keeps the mock's native session across turns.
      process.env.CLAUDE_CONFIG_DIR = join(root, 'operator-claude-config')
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
        const mcpBinding = composeMcpServiceBindingForTest(db, { actor })
        const mcp = await getMcpById(mcpBinding, 'mcp-fixture')
        if (mcp === null) throw new Error('fixture MCP missing')
        const runtimeRegistry = new SqliteRuntimeRegistryPersistence(db)
        const service = new McpRuntimeTestService({
          ...composeSqliteMcpRuntimeTestProvider(db),
          loadMcp: (mcpId) => getMcpById(mcpBinding, mcpId),
          loadRuntime: (name) => runtimeRegistry.getRuntime(name),
          configPath: join(root, 'config.json'),
          appHome: root,
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
            binary: mcpRuntimeTestTurns.spawnBinaryPath,
          })
          .from(mcpRuntimeTestTurns)
          .where(eq(mcpRuntimeTestTurns.sessionId, session.id))
          .all()
        expect(turnReceipts).toHaveLength(2)
        for (const receipt of turnReceipts) {
          expect(receipt.binary).toBe(runtimeBinary)
        }
        expect(db.select().from(tasks).all()).toHaveLength(0)
        expect(db.select().from(nodeRuns).all()).toHaveLength(0)

        const ended = await service.end(actor, mcp.id, session.id)
        expect(ended.session.status).toBe('ended')
        expect(ended.session.cleanupState).toBe('complete')
      } finally {
        if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
        else process.env.ANTHROPIC_API_KEY = previousApiKey
        if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
        else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir
        server.stop(true)
      }
    },
    15_000,
  )
})
