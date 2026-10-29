// RFC-349 —— 割接窗口内不许有任何请求落在「已经不成立」的那份 composition 上。
//
// 这份守卫的由来是托管取证跑（真外置 PostgreSQL，`postgresql-evidence`）：
// `createPostgresqlDatabaseClient` 一构造就把**进程级**表投影改指到 PostgreSQL，
// 而候选 composition 要构建几百毫秒；这段时间里 `current` 还是 SQLite 那份，
// 于是每一条豁免了维护门的控制面请求（迁移状态轮询、健康检查）都拿 PostgreSQL
// 限定名去 bun:sqlite 上执行，实测 531 毫秒里 40 次
// `no such table: agent_workflow.user_sessions`。
//
// 三条性质：
//   1. 换 composition 期间，写请求、业务请求与 WebSocket 升级挂起，换完由**接手的那份**回答，
//      不 500。只读的迁移观察（`GET /api/database*`、健康检查、维护状态）不等：RFC-395 I-b
//      起表随会话句柄绑定，送出的那份与自己的 client 一致；而 epoch 2 组装 PostgreSQL 的耗时
//      随数据量增长，周取证语料上状态轮询被这道栅栏卡了 4.9 秒（运行 40893688180，超过
//      2.5 秒的门；本机 small 语料实测栅栏 664 毫秒、状态最慢 657 毫秒），违背 RFC-349
//      「割接期间迁移状态保持可读」；
//   2. 换完（成功或失败）都要把 provider 选择钉回真正在服务的那份，否则割接
//      失败后源 session 恢复服务、投影却留在 PostgreSQL，整个 daemon 全炸；
//      （RFC-395 I-b 起表随会话句柄绑定、进程级投影已删除，这条现在只锁 controller
//      对「正在服务的那份」的上报。）
//   3. `/api/maintenance/status` 是运维盯迁移用的端点，必须豁免维护门——它自己
//      不碰数据库，拦了只是让调用方在最需要看的窗口里瞎掉。

import { describe, expect, test } from 'bun:test'

import {
  createDaemonProviderRuntimeRouter,
  type DaemonProviderListenerRuntimeSession,
  type DaemonProviderRuntimeWebSocketHandlers,
  type DaemonProviderWebSocketMessage,
} from '../src/bootstrap/daemonProviderRuntimeRouter'
import {
  createDaemonProviderRuntimeSession,
  type DaemonProviderRuntimeAdmission,
} from '../src/bootstrap/daemonProviderRuntimeSession'
import { createDaemonProviderSessionController } from '../src/bootstrap/daemonProviderSession'
import { createDatabaseMigrationDaemonAdmission } from '../src/modules/system-operations/infrastructure/databaseMigrationDaemonAdmission'

interface TestWebSocket {
  readonly id: string
}

const noOpAdmission: DaemonProviderRuntimeAdmission = Object.freeze({
  closeWriterAdmission() {},
  openWriterAdmission() {},
  closeWebSocketAdmission() {},
  openWebSocketAdmission() {},
})

type TestSession = DaemonProviderListenerRuntimeSession<TestWebSocket>

const websocketHandlers: DaemonProviderRuntimeWebSocketHandlers<TestWebSocket> = Object.freeze({
  open(_webSocket: TestWebSocket) {},
  message(_webSocket: TestWebSocket, _message: DaemonProviderWebSocketMessage) {},
  close(_webSocket: TestWebSocket) {},
})

async function testSession(
  provider: 'sqlite' | 'postgresql',
  generationId: string,
): Promise<TestSession> {
  return await createDaemonProviderRuntimeSession({
    provider,
    generationId,
    runtime: {
      fetch: () => new Response(`${provider}:fetch`),
      tryUpgrade: () => false,
      websocketHandlers,
    },
    admission: noOpAdmission,
    shutdownIdentity() {},
    closeProvider() {},
  })
}

describe('RFC-349 provider handover fence', () => {
  test('mid-switch writes, business reads and upgrades wait for the incoming composition; migration observation does not', async () => {
    const sqlite = await testSession('sqlite', 'sqlite-1')
    const postgresql = await testSession('postgresql', 'pg-1')
    let releaseCompose: () => void = () => {}
    const composing = new Promise<void>((resolve) => {
      releaseCompose = resolve
    })
    const controller = createDaemonProviderSessionController({
      initial: sqlite,
      factory: {
        async create() {
          await composing
          return postgresql
        },
      },
    })
    const router = createDaemonProviderRuntimeRouter<TestWebSocket>(controller)

    await controller.pauseBackgroundWriters({
      operationId: 'op-1',
      provider: 'sqlite',
      generationId: 'sqlite-1',
    })
    const switching = controller.switchProviderComposition({
      operationId: 'op-1',
      provider: 'postgresql',
      generationId: 'pg-1',
    })
    expect(controller.handover()).not.toBeNull()

    // Read-only migration observation is answered right away by the outgoing session,
    // which keeps running the operation until the target is composed. The listener asks
    // `tryUpgrade` before `fetch` for every request, so both must pass it (the evidence run
    // stalled in `tryUpgrade` while only `fetch` let it through).
    for (const path of ['/api/database/migrations/dbm_1', '/api/database', '/api/health']) {
      const request = new Request(`http://localhost${path}`)
      expect(await router.tryUpgrade(request, { upgrade: () => true } as never)).toBe(false)
      expect(await (await router.fetch(request)).text()).toBe('sqlite:fetch')
    }

    // Issued while the target is still being composed: a write to the migration control
    // plane and a business read both wait and are answered by the incoming composition.
    let settled = false
    const inFlight = Promise.all([
      router.fetch(
        new Request('http://localhost/api/database/migrations/dbm_1/rollback', { method: 'POST' }),
      ),
      router.fetch(new Request('http://localhost/api/tasks')),
    ]).then((responses) => {
      settled = true
      return responses
    })
    await Bun.sleep(20)
    expect(settled).toBe(false)

    // A WebSocket upgrade authenticates too, so it is fenced the same way.
    let upgradeSettled = false
    const upgrade = Promise.resolve(
      router.tryUpgrade(new Request('http://localhost/ws/tasks'), {
        upgrade: () => true,
      } as never),
    ).then((result) => {
      upgradeSettled = true
      return result
    })
    await Bun.sleep(20)
    expect(upgradeSettled).toBe(false)

    releaseCompose()
    await switching
    expect(await Promise.all((await inFlight).map((response) => response.text()))).toEqual([
      'postgresql:fetch',
      'postgresql:fetch',
    ])
    expect(await upgrade).toBe(false)
    expect(controller.handover()).toBeNull()
  })

  test('a failed switch leaves provider selection pinned to the session that keeps serving', async () => {
    const sqlite = await testSession('sqlite', 'sqlite-1')
    const selected: string[] = []
    const controller = createDaemonProviderSessionController({
      initial: sqlite,
      factory: {
        async create() {
          throw new Error('target-composition-failed')
        },
      },
      onCurrentSelected: (session) => selected.push(session.provider),
    })
    const router = createDaemonProviderRuntimeRouter<TestWebSocket>(controller)

    await controller.pauseBackgroundWriters({
      operationId: 'op-1',
      provider: 'sqlite',
      generationId: 'sqlite-1',
    })
    await expect(
      controller.switchProviderComposition({
        operationId: 'op-1',
        provider: 'postgresql',
        generationId: 'pg-1',
      }),
    ).rejects.toThrow('target-composition-failed')

    expect(selected).toEqual(['sqlite'])
    expect(controller.handover()).toBeNull()
    expect(await (await router.fetch(new Request('http://localhost/api/health'))).text()).toBe(
      'sqlite:fetch',
    )
  })

  test('the maintenance status endpoint stays reachable while the source is frozen', async () => {
    const admission = createDatabaseMigrationDaemonAdmission({
      pauseBackgroundWriters: async () => {},
      switchProviderComposition: async () => {},
      resumeBackgroundWriters: async () => {},
      initialProvider: 'sqlite',
      initialGenerationId: 'dbg_legacy_sqlite',
    })
    const ok = async () => new Response('ok')

    await admission.migration.freezeAndDrain({
      operationId: 'dbm_1',
      sourceGenerationId: 'dbg_legacy_sqlite',
      timeoutMs: 1_000,
    })
    expect(admission.live().phase).toBe('frozen')

    expect((await admission.runBusinessRequest(new Request('http://x/api/tasks'), ok)).status).toBe(
      503,
    )
    for (const path of [
      '/api/maintenance/status',
      '/api/health',
      '/api/database',
      '/api/database/migrations/dbm_1',
    ]) {
      const response = await admission.runBusinessRequest(new Request(`http://x${path}`), ok)
      expect(`${path}:${response.status}`).toBe(`${path}:200`)
    }
    admission.stop()
  })
})
