// RFC-359 AC-1（plan §5hm）—— attach 与评审变更必须在**两个引擎上**走同一个临界区。
//
// 为什么这条测试存在：`withTaskReviewMutationLock` 是按 task 排队的进程内 FIFO，
// 用途见 `services/reviewMutationCoordinator.ts:1-7`——评审决策会改动兄弟评审行，
// 任务取消会经生命周期终态钩子封掉所有未决评审行，两者共用一个临界区。
// SQLite 的 `attachTaskDriver` 整个包在这个锁里（`taskDriverLifecycle.ts`），
// 而 `postgresqlTaskDriverLifecycle.ts` **一句都没有**：PG 上 attach 可以与
// 「取消正在封评审行」交错，SQLite 上不会。同一件事，一侧有判据、另一侧没有——
// 正是本 RFC 要消灭的形态。
//
// 判据用的是 attach 的**提前返回**那条路（任务已终态 ⇒ `not-attached`）：
// 它在 SQLite 上位于锁内、在 PG 上位于锁外，所以不必真认领任务就能把顺序差异照出来。
// 断言的是**顺序**，不是时序——`review-exit` 由本用例显式释放，不靠 sleep 赛跑。
//
// 合一之前这条在 PostgreSQL 上是**红**的（缺口真实存在的证据）；
// 合一之后两个引擎都必须绿。重入面的逐条勘察见 plan §5hm 第 1 步。
import { expect, test } from 'bun:test'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { tasks, workflows } from '@/db/schema'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { createProviderTaskExecutionModule } from '@/modules/task-execution/composition'
import type { TaskDriverLifecyclePort } from '@/modules/task-execution/application/drive/taskDriveCoordinator'
import type { TaskExecutionTopologyLogger } from '@/modules/task-execution/application/ports/taskExecutionTopology'
import {
  createDatabaseTaskDriverLifecyclePort,
  createTaskDriverLifecyclePort,
} from '@/modules/task-execution/infrastructure/taskDriverLifecycle'
import { withTaskReviewMutationLock } from '@/services/reviewMutationCoordinator'
import { describeEachProvider } from './helpers/eachProvider'

const silentLog: TaskExecutionTopologyLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLog,
}

async function seedTerminalTask(db: ProviderNeutralDatabase): Promise<string> {
  const workflowId = `wf_${ulid()}`
  await db.insert(workflows).values({
    id: workflowId,
    name: workflowId,
    definition: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
  })
  const taskId = `task_${ulid()}`
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/rfc359-attach-lock',
    worktreePath: '/tmp/rfc359-attach-lock',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    // 终态 ⇒ attach 走提前返回（`not-attached`），不必真认领。
    status: 'done',
    inputs: '{}',
    startedAt: 1,
    finishedAt: 2,
  })
  return taskId
}

describeEachProvider('RFC-359 AC-1 —— attach 与评审变更共用一个临界区', (harness) => {
  test('评审变更持锁期间，attach 必须排队等它，不得插进去', async () => {
    const db = harness.db
    const taskId = await seedTerminalTask(db)
    const persistence = createTaskExecutionPersistence(db)
    // RFC-359 AC-1（plan §5hm）：**两个引擎装同一个端口实现**，差别只剩认领方式——
    // PG 绑实例模块的 `claimPersisted`，SQLite 绑进程级单例的 `claim({ db, intentId })`。
    const lifecycle: TaskDriverLifecyclePort =
      harness.capabilities.provider === 'postgresql'
        ? (() => {
            const module = createProviderTaskExecutionModule({
              daemonGeneration: `rfc359-attach-lock-${ulid()}`,
              persistence,
            })
            return createTaskDriverLifecyclePort({
              db,
              module,
              claim: (intentId) => module.claimPersisted({ intentId }),
              persistence,
              log: silentLog,
              finalizeWorkspace: async () => {},
            })
          })()
        : createDatabaseTaskDriverLifecyclePort({
            db,
            log: silentLog,
            finalizeWorkspace: async () => {},
          })

    const order: string[] = []
    let releaseReview: () => void = () => {}
    const reviewHeld = new Promise<void>((resolve) => {
      releaseReview = resolve
    })
    // 同步取号：`withTaskReviewMutationLock` 在发出的那一刻就定下排队位置。
    const review = withTaskReviewMutationLock(taskId, async () => {
      order.push('review-enter')
      await reviewHeld
      order.push('review-exit')
    })

    const attach = lifecycle
      .attach({ taskId, intentId: `intent_${ulid()}`, controller: new AbortController() })
      .then((outcome) => {
        order.push('attach')
        return outcome
      })

    // 给 attach **充分**的机会跑完（它只是一次 select + 提前返回，200ms 绰绰有余），
    // 然后才放行评审侧。这段等待只用来让「违规的交错」可被观察到；
    // 合规那一侧由锁本身保证，等多久都不会变——所以它不是「靠 sleep 赛跑」。
    await new Promise((resolve) => setTimeout(resolve, 200))
    order.push('review-released')
    releaseReview()
    const [, outcome] = await Promise.all([review, attach])

    expect(outcome.kind, '终态任务本来就不该 attach 上').toBe('not-attached')
    expect(order[0], '评审侧应当先进临界区').toBe('review-enter')
    expect(
      order.indexOf('attach') > order.indexOf('review-exit'),
      `attach 插进了评审临界区——这个引擎的 attach 没走评审变更锁（plan §5hm）。实际顺序：${order.join(' → ')}`,
    ).toBe(true)
  })
})
