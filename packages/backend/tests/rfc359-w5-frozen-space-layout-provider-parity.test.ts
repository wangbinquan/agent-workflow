// RFC-359 AC-6 —— 「从源任务重放」这条路在两个引擎上必须给出同一种拒绝。
//
// 为什么这条测试存在，以及它**不是**在锁什么（这段是有意写下来的，防止下一个人重走我这趟弯路）：
//
// 本轮放宽 `TaskRouteWorkspaceDependencies.db` 时，`tsc` 指到这里一处调用，
// 顺着看见 `services/task.ts` 的 `loadFrozenSpaceLayout` 是**同步**函数、用 bun:sqlite 的同步终结符
// `.all()`。而实测（本轮 probe）同一句 `.all()` 在 SQLite 上交回**数组**、在 PostgreSQL 上交回
// **Promise**（`length` 为 `undefined`）。于是我判断：PG 上 `rows.length === 0` 恒假、
// 「源任务没有冻结快照」这条校验被跳过、紧接着 `rows.filter(...)` 抛 TypeError——一个真缺陷。
//
// **这个判断是错的，写了这条用例才发现。** `taskRouteWorkspaceParticipant.ts` 有**自己的**
// `async function loadFrozenSpaceLayout`（同文件第 66 行），根本没用 `services/task.ts` 那份；
// 它 `await` 取行，行为正确。两个引擎跑下来都是同一个 `source-task-not-replayable`。
//
// 那么真正的发现是另一件事：**同一段逻辑被写了两遍**，而两遍的**用户可见文案不一样**——
//   · legacy 那份（`services/task.ts`，SQLite 启动路在用）：
//     `has N repo(s) with no cached mirror id; … (relaunch by picking a repo or repo group instead)`
//     ——报个数，还告诉你该怎么办；
//   · 内核那份（本文件调用的这个，PostgreSQL 启动路在用）：
//     `has a repo with no cached mirror id; …` ——没有计数，也没有那句指引。
// 同一个失败原因，换个数据库跑，用户读到的话不同。这正是 plan §5gv 那道「启动面合一」要消掉的东西
// （详见 plan §5gy）。
//
// 这条用例锁住的是**内核那条路在两个引擎上同形**：它此前唯一的 PostgreSQL 覆盖
// （`rfc349-repository-preparation-postgresql-adapter`）用的是手搓假池、而且喂 `scratch: true`
// 的任务——那条路径压根走不到这里（plan §5gn 清点的那类缺口）。
// 判据选「源任务没有任何 task_repos 行」，因为它**零夹具**就能把「正确拒绝」与
// 「把 Promise 当数组用」两种结局分开：后者会以 `is not a function` 现形。

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTaskWorkspaceMaterializer } from '@/modules/task-execution/infrastructure/taskRouteWorkspaceParticipant'

import { describeEachProvider } from './helpers/eachProvider'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describeEachProvider('RFC-359 —— 冻结空间布局的重放拒绝在两个引擎上同形', (harness) => {
  test('源任务没有冻结仓快照时，抛的是 source-task-not-replayable 而不是 TypeError', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc359-frozen-layout-'))
    roots.push(appHome)
    const materializer = createTaskWorkspaceMaterializer({
      db: harness.db as never,
      appHome,
    })

    const attempt = materializer.prepare({
      taskId: 'task-replay-target',
      task: {
        workflowId: 'workflow-1',
        name: 'Replay from a source task that has no frozen repos',
        inputs: {},
        sourceTaskId: 'task-without-frozen-repos',
      } as never,
      gitCommitIdentity: { name: 'Owner', email: 'owner@example.test' },
    })

    // 关键：**错误的种类**要一致。PG 上原来是 `rows.filter is not a function`。
    const error = await attempt.then(
      () => null,
      (caught: unknown) => caught,
    )
    expect(error, '应当拒绝这次重放，而不是成功').not.toBeNull()
    const message = error instanceof Error ? error.message : String(error)
    expect(
      message,
      '两个引擎必须给出同一个用户可见拒绝；出现 `filter is not a function` ' +
        '说明同步 `.all()` 又把 PostgreSQL 的 Promise 当数组用了',
    ).not.toMatch(/is not a function/)
    expect(
      (error as { code?: string }).code ?? message,
      '拒绝的判据应当是「源任务不可重放」',
    ).toMatch(/source-task-not-replayable/)
  })
})
