// RFC-349 回归防护 —— MCP runtime playground 的 `loadMcp` 必须用**进程内**守护
// 身份，而不是 legacy daemon-token。
//
// 为什么这条测试存在：RFC-349 的 `8637cf2d5 feat(database): compose
// provider-selected daemon` 把 runtime-test worker 的 MCP 读取改成
//   `resolveIdentity(authRuntime, token, Buffer.from(token), identityAccess)`
// —— 那是给**外部 HTTP 调用方**出示启动 token 用的分支，按设计在首个管理员完成
// bootstrap 之后就关闭。于是真实安装（bootstrap 已完成）里 worker 抛
// `mcp-runtime-test-authority-not-admitted`，该 turn 永远停在飞行中：既不出
// terminal 状态、也不出 issue 面板。CI 全绿只是因为既有 rfc238 测试建库时走的是
// **默认 bootstrap 档**——它同时把 bootstrap 标成已完成**并**把这个 db 加进
// `allowLegacyDaemonTestAccess` 白名单，恰好绕开了这条分支。
// （此处刻意不写出那个建库函数的字面名字：RFC-359 的单引擎账本守卫是**按文本扫**的，
//   注释也算它的输入，写出来会被记成一个并不存在的调用点。）
//
// 本用例用 `bootstrap: 'required'`（=> 无 legacy 白名单），走真实
// bootstrap + 登录，再跑一整回合；`loadMcp` 一旦回到 token 判据就会重新挂死并
// 让这条红。守卫的是 Playwright 的 mcp-runtime-playground /
// mcp-acl-session-termination 两条 e2e 所依赖的同一条产品路径。

import { afterEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { McpRuntimeTestSessionDtoSchema } from '@agent-workflow/shared'
import {
  describeEachProviderHttpApplication,
  type ProviderHttpApplicationScope,
} from './helpers/providerHttpApplicationScope'
import { runtimes } from '../src/db/schema'
import { DrizzleRuntimeRegistryPersistence } from '../src/platform/runtime-registry/infrastructure/runtimeRegistryPersistence'
import { seedBuiltinRuntimes } from '../src/services/runtimeRegistry'
import {
  emptySystemAgentOutputEvidence,
  type SystemAgentRunOptions,
  type SystemAgentRunResult,
} from '../src/services/systemAgentRun'

const DAEMON_TOKEN = 'rfc349-daemon-identity-token'
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

// RFC-359 AC-6 —— `runFn` 按用例新建、注入口是注册期参数，照例用稳定转发闭包。
// `bootstrap: 'required'` 搬到作用域参数上：它既保留「首个管理员未创建」的初态，也**不**
// 把库加入 legacy daemon-token 白名单——与真实安装一致，两个引擎同样处理。
// `appHome` 不必再传（作用域把 `AGENT_WORKFLOW_HOME` 指向它现建的目录）。
let currentRunFn: ((opts: SystemAgentRunOptions) => Promise<SystemAgentRunResult>) | undefined

const SCOPE_OPTIONS = {
  token: DAEMON_TOKEN,
  opencodeVersion: null,
  dbVersion: 1,
  tempPrefix: 'rfc349-daemon-identity-',
  bootstrap: 'required',
  mcpRuntimeTestDependencies: {
    runFn: (opts: SystemAgentRunOptions): Promise<SystemAgentRunResult> => {
      if (currentRunFn === undefined) throw new Error('rfc349 runFn not installed')
      return currentRunFn(opts)
    },
  },
} as const

async function bootstrappedApp(
  scope: ProviderHttpApplicationScope,
): Promise<{ app: Hono; sessionToken: string }> {
  const db = scope.harness.db
  await seedBuiltinRuntimes(new DrizzleRuntimeRegistryPersistence(db))
  // 中立面没有 bun:sqlite 的同步终结符——改成 await。
  await db.update(runtimes).set({ model: 'openai/test-model' }).where(eq(runtimes.name, 'opencode'))

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

  currentRunFn = runFn
  const app = (await scope.open()).app

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

describeEachProviderHttpApplication(
  'RFC-349 MCP runtime playground daemon identity',
  SCOPE_OPTIONS,
  (scope) => {
    test('a queued turn still loads its MCP after first-admin bootstrap closes the daemon token', async () => {
      const { app, sessionToken } = await bootstrappedApp(scope)
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
          await (
            await req(`/api/mcps/${mcp.id}/runtime-test-sessions/${receipt.sessionId}`)
          ).json(),
        )
      }

      expect(session.turns).toHaveLength(1)
      // `mcp-config-changed` 是「MCP 读不回来」的旧掩体码：worker 读不到 MCP 时会
      // 用它收场。这里必须是干净的成功回合。
      expect(session.turns[0]?.failureCode ?? null).toBeNull()
      expect(session.turns[0]?.status).toBe('succeeded')
    }, 20_000)
  },
)
