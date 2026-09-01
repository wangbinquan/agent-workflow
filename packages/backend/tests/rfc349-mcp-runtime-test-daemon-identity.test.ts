// RFC-349 回归防护 —— MCP runtime playground 的 `loadMcp` 必须用**进程内**守护
// 身份，而不是 legacy daemon-token。
//
// 为什么这条测试存在：RFC-349 的 `8637cf2d5 feat(database): compose
// provider-selected daemon` 把 runtime-test worker 的 MCP 读取改成
//   `resolveIdentity(authRuntime, token, Buffer.from(token), identityAccess)`
// —— 那是给**外部 HTTP 调用方**出示启动 token 用的分支，按设计在首个管理员完成
// bootstrap 之后就关闭。于是真实安装（bootstrap 已完成）里 worker 抛
// `mcp-runtime-test-authority-not-admitted`，该 turn 永远停在飞行中：既不出
// terminal 状态、也不出 issue 面板。CI 全绿只是因为既有 rfc238 测试用
// `createInMemoryDb(...)`——它同时把 bootstrap 标成已完成**并**把这个 db 加进
// `allowLegacyDaemonTestAccess` 白名单，恰好绕开了这条分支。
//
// 本用例用 `bootstrap: 'required'` 的 db（=> 无 legacy 白名单），走真实
// bootstrap + 登录，再跑一整回合；`loadMcp` 一旦回到 token 判据就会重新挂死并
// 让这条红。守卫的是 Playwright 的 mcp-runtime-playground /
// mcp-acl-session-termination 两条 e2e 所依赖的同一条产品路径。

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { McpRuntimeTestSessionDtoSchema } from '@agent-workflow/shared'
import { loadConfig } from '../src/config'
import { createInMemoryDb } from '../src/db/client'
import { runtimes } from '../src/db/schema'
import { SqliteRuntimeRegistryPersistence } from '../src/platform/runtime-registry/infrastructure/sqliteRuntimeRegistryPersistence'
import { seedBuiltinRuntimes } from '../src/services/runtimeRegistry'
import {
  emptySystemAgentOutputEvidence,
  type SystemAgentRunOptions,
  type SystemAgentRunResult,
} from '../src/services/systemAgentRun'
import { createApp } from '../src/server'

const DAEMON_TOKEN = 'rfc349-daemon-identity-token'
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const ADMIN = {
  username: 'rfc349_admin',
  displayName: 'RFC-349 Administrator',
  email: 'rfc349-admin@example.com',
  password: 'Rfc349Administrator123!',
} as const
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function bootstrappedApp(): Promise<{ app: Hono; sessionToken: string }> {
  const root = mkdtempSync(join(tmpdir(), 'rfc349-daemon-identity-'))
  tempDirs.push(root)
  const configPath = join(root, 'config.json')
  loadConfig(configPath)
  // `bootstrap: 'required'` 是关键：它既保留「首个管理员未创建」的初态，也**不**
  // 把这个 db 加入 legacy daemon-token 白名单——与真实安装一致。
  const db = createInMemoryDb(MIGRATIONS, { bootstrap: 'required' })
  await seedBuiltinRuntimes(new SqliteRuntimeRegistryPersistence(db))
  db.update(runtimes).set({ model: 'openai/test-model' }).where(eq(runtimes.name, 'opencode')).run()

  const runFn = async (opts: SystemAgentRunOptions): Promise<SystemAgentRunResult> => {
    await opts.onSpawned?.({
      pid: 7331,
      spawnedAt: Date.now(),
      spawnBinaryPath: '/mock/opencode',
    })
    await opts.eventSink?.setRootSessionId('rfc349-native-session')
    await opts.eventSink?.markTerminal('complete')
    return {
      status: 'ok',
      exitCode: 0,
      eventText: '',
      stderrTail: '',
      durationMs: 3,
      capturedSessionId: 'rfc349-native-session',
      scratchDir: join(opts.scratchParent, opts.scratchName ?? 'unknown'),
      scratchRetained: true,
      outputEvidence: emptySystemAgentOutputEvidence(),
    }
  }

  const app = createApp({
    token: DAEMON_TOKEN,
    configPath,
    opencodeVersion: null,
    dbVersion: 1,
    db,
    mcpRuntimeTestDependencies: { appHome: root, runFn },
  })

  const bootstrap = await app.request('/api/auth/bootstrap/admin', {
    method: 'POST',
    headers: { Authorization: `Bearer ${DAEMON_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(ADMIN),
  })
  expect(bootstrap.status, await bootstrap.text().catch(() => '')).toBe(201)

  const login = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ADMIN.username, password: ADMIN.password }),
  })
  expect(login.status).toBe(200)
  const { sessionToken } = (await login.json()) as { sessionToken: string }
  return { app, sessionToken }
}

describe('RFC-349 MCP runtime playground daemon identity', () => {
  test('a queued turn still loads its MCP after first-admin bootstrap closes the daemon token', async () => {
    const { app, sessionToken } = await bootstrappedApp()
    const req = async (path: string, init: RequestInit = {}): Promise<Response> => {
      const headers = new Headers(init.headers)
      headers.set('Authorization', `Bearer ${sessionToken}`)
      if (init.body !== undefined) headers.set('content-type', 'application/json')
      return await app.request(path, { ...init, headers })
    }

    // 前提断言：bootstrap 之后 legacy daemon token 对普通业务面确实已经关闭。
    // 这正是让旧实现挂死的那条门；它必须仍然关着，否则本用例是空洞绿。
    const withDaemonToken = await app.request('/api/mcps', {
      headers: { Authorization: `Bearer ${DAEMON_TOKEN}` },
    })
    expect(withDaemonToken.status).toBe(401)

    const created = await req('/api/mcps', {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc349-daemon-identity-fixture',
        description: '',
        type: 'local',
        config: { command: ['/mock/mcp'] },
        enabled: true,
      }),
    })
    expect(created.status).toBe(201)
    const mcp = (await created.json()) as { id: string; operationConfigHash: string }

    const start = await req(`/api/mcps/${mcp.id}/runtime-test-sessions`, {
      method: 'POST',
      body: JSON.stringify({
        expectedMcpConfigHash: mcp.operationConfigHash,
        runtimeName: 'opencode',
        message: 'rfc349 daemon identity turn',
        clientCreateId: 'rfc349-create-1',
        clientMessageId: 'rfc349-message-1',
      }),
    })
    expect(start.status).toBe(202)
    const receipt = (await start.json()) as { sessionId: string; acceptedTurnId: string }

    const deadline = Date.now() + 5_000
    let session = McpRuntimeTestSessionDtoSchema.parse(
      await (await req(`/api/mcps/${mcp.id}/runtime-test-sessions/${receipt.sessionId}`)).json(),
    )
    while (session.inFlightTurnId !== null) {
      if (Date.now() >= deadline) {
        throw new Error(
          'the runtime-test turn never left the in-flight state — the worker could not admit its ' +
            'daemon identity (mcp-runtime-test-authority-not-admitted)',
        )
      }
      await new Promise((wait) => setTimeout(wait, 5))
      session = McpRuntimeTestSessionDtoSchema.parse(
        await (await req(`/api/mcps/${mcp.id}/runtime-test-sessions/${receipt.sessionId}`)).json(),
      )
    }

    expect(session.turns).toHaveLength(1)
    // `mcp-config-changed` 是「MCP 读不回来」的旧掩体码：worker 读不到 MCP 时会
    // 用它收场。这里必须是干净的成功回合。
    expect(session.turns[0]?.failureCode ?? null).toBeNull()
    expect(session.turns[0]?.status).toBe('succeeded')
  }, 20_000)
})
