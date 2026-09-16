// RFC-359 AC-1（plan §5hn 批次二 ①）—— RFC-287 G7「延后仓库准备」在两个引擎上的落差。
//
// **这条用例钉的是一处已知缺陷的当前形状，不是契约。** 它会在缺陷修好时自己变红，
// 那正是它存在的理由（同 §5hn 批次二 ③ 的 `spaceNodes` 那条：先钉住、再销账）。
//
// RFC-287 G7 是**已定的产品行为**：JSON body 启动（以及沿用同一套语义的定时 / webhook 触发）
// 把仓库准备推迟到任务行落库之后——「今天物化在落行之前，于是『克隆超时 / 远端不可达』
// 这类失败**不留任何记录**——用户点了启动，转半天圈，最后得到一个 HTTP 错误，
// 任务列表里什么都没有」（`services/task.ts` 该分支原文）。
//
// 实测（2026-09-17，两条启动路各一次，远端 `https://example.invalid/nope.git`）：
//
// | | JSON `POST /api/tasks` | `POST /api/scheduled-tasks/:id/run-now` |
// | --- | --- | --- |
// | SQLite     | **201**，`tasks` 一行 `pending`（可重试） | **201**，`tasks` 一行 `pending` |
// | PostgreSQL | **400 `repo-clone-failed`**，`tasks` **零行** | **400 `repo-clone-failed`**，零行 |
//
// 成因：`deferRepoPreparation` 这条路**整个只存在于 SQLite 那一侧**
//（`grep -rln deferRepoPreparation src` → `services/task.ts` 与它的三个调用方），
// PostgreSQL 的根启动内核在插入任务行**之前**无条件 `workspace.prepare(...)` 全量物化。
// 也就是说 **G7 在 PostgreSQL 上根本没实现**：同一个「远端拉不动」的场景，
// SQLite 用户看到一行可重试的任务，PostgreSQL 用户什么都看不到。
//
// 销账动作：把延后准备接进根启动内核（占位行 + `runTask` 第 0 步物化），
// 届时下面两条按 provider 分叉的断言会红，改成两侧相等即可。
import { beforeEach, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { ulid } from 'ulid'

import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'
import { seedTestDefaultOpencodeRuntime } from './helpers/executionRuntimeFixture'
import { tasks } from '@/db/schema'

const TOKEN = 'i'.repeat(64)
/**
 * 立刻 connection-refused 的本机地址——**刻意不走公网**：用例要的是「克隆失败」这个
 * 分支，不是 DNS / TLS 的某种超时，更不该让判据依赖 CI runner 的出网能力
 *（本仓有 `RUN_GIT_NETWORK` 门控的用例，正是为了把真出网的那些隔离出去）。
 * 端口 1 上不会有监听者，git 秒失败，两个引擎观察到的是同一个确定分支。
 */
const UNREACHABLE_REPO = 'http://127.0.0.1:1/nope.git'
const SPEC = { kind: 'daily', at: '09:00', timezone: 'UTC' } as const

async function req(app: Hono, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${TOKEN}`)
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return app.request(path, { ...init, headers })
}

describeEachProviderHttpApplication(
  'RFC-359 AC-1 —— RFC-287 G7 延后仓库准备的两个引擎落差（已知缺陷，钉住待销）',
  {
    token: TOKEN,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    tempPrefix: 'aw-rfc359-deferred-prep-parity-',
  },
  (scope) => {
    let app: Hono

    beforeEach(async () => {
      await seedTestDefaultOpencodeRuntime(scope.harness.db)
      ;({ app } = await scope.open())
    })

    async function createWorkflow(): Promise<string> {
      const suffix = ulid().slice(-8).toLowerCase()
      const res = await req(app, '/api/workflows', {
        method: 'POST',
        body: JSON.stringify({
          name: `defer-wf-${suffix}`,
          description: '',
          definition: { $schema_version: 1, inputs: [], nodes: [], edges: [] },
        }),
      })
      expect(res.status, await res.clone().text()).toBe(201)
      return ((await res.json()) as { id: string }).id
    }

    test('JSON POST /api/tasks：远端拉不动时 SQLite 留下可重试的任务行，PostgreSQL 什么都不留', async () => {
      const workflowId = await createWorkflow()
      const res = await req(app, '/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          workflowId,
          name: 'rfc359 deferred prep',
          repoUrl: UNREACHABLE_REPO,
        }),
      })
      const rows = await scope.harness.db.select().from(tasks)

      if (scope.harness.capabilities.provider === 'sqlite') {
        // G7 的正向行为：先落行、后准备。
        expect(res.status, await res.clone().text()).toBe(201)
        expect(rows, 'G7：任务行必须先落库，准备失败才有处可记').toHaveLength(1)
        expect(rows[0]?.status, 'G7 明确不新增状态：占位行就是 pending').toBe('pending')
      } else {
        // **已知缺陷**：PostgreSQL 没有延后准备这条路，克隆在插入之前同步做。
        expect(res.status, await res.clone().text()).toBe(400)
        expect(
          ((await res.json()) as { code?: string }).code,
          'PostgreSQL 上仓库准备仍是同步的，失败码应当是 clone 原文',
        ).toBe('repo-clone-failed')
        expect(
          rows,
          'PostgreSQL 上这次失败一行都不留——这正是 G7 要消灭的形状，销账时本条会红',
        ).toHaveLength(0)
      }
    })

    test('定时 run-now：同一处落差在定时触发上也成立', async () => {
      const workflowId = await createWorkflow()
      const created = await req(app, '/api/scheduled-tasks', {
        method: 'POST',
        body: JSON.stringify({
          name: 'defer-sched',
          launchKind: 'workflow',
          launchPayload: {
            workflowId,
            name: 'rfc359 deferred prep sched',
            repoUrl: UNREACHABLE_REPO,
          },
          scheduleSpec: SPEC,
          enabled: false,
        }),
      })
      expect(created.status, await created.clone().text()).toBe(201)
      const schedule = (await created.json()) as { id: string }

      const fired = await req(app, `/api/scheduled-tasks/${schedule.id}/run-now`, {
        method: 'POST',
      })
      const rows = await scope.harness.db.select().from(tasks)

      if (scope.harness.capabilities.provider === 'sqlite') {
        expect(fired.status, await fired.clone().text()).toBe(201)
        expect(rows, '定时触发与手动启动同一套语义（G7 原话）').toHaveLength(1)
      } else {
        expect(fired.status, await fired.clone().text()).toBe(400)
        expect(rows, 'PostgreSQL 上定时触发同样一行不留').toHaveLength(0)
      }
    })
  },
)
