// RFC-359 AC-1（第 9 刀）—— `retry` 的**唯一**测试装配点。
//
// 为什么存在：`retry` 曾经有两份实现（`services/task.ts` 的 `retryNode` 与
// `postgresqlTaskRouteOperations.ts` 的那份），各自有测试、各自都绿，谁也没跟谁比过。
// 合成一份之后行为套件也只该有一个装配点——否则下一次分叉会从测试侧长出来（同修复那一刀）。
//
// 它把共用实现包成既有套件熟悉的调用形状，并把两个端口（复活 / 级联取消）暴露成可注入项：
// 合并前那条「让子任务取消 CAS 永远赢不了」的并发用例靠的是被测代码内部的
// `childCancelBeforeStatusCas`，现在那个缝就是 `cancelChildTaskForCascade` 本身——
// 注入点从实现内部挪到了依赖面上，比原来更正当。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildActor, type Actor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { composeLegacyTaskActivityParticipant } from '@/modules/task-execution/infrastructure/sqliteTaskExecutionRuntimeParticipants'
import { retryNodeProjection } from '@/modules/task-execution/infrastructure/postgresqlTaskRouteOperations'
import { retryRepositoryPreparation, type StartTaskDeps } from '@/services/task'
import { runTaskWithRealTestTopology } from './taskExecutionTestTopology'
import type { Task } from '@agent-workflow/shared'

export interface RetryEngineOptions {
  readonly appHome?: string
  /**
   * 进程内活跃度。**缺省就是生产那一份**（`composeLegacyTaskActivityParticipant`，读
   * `services/task.ts` 的进程级注册表）——退役那份 `retryNode` 读的也是它，所以
   * 「调度器挂起期间重试 → 409 `task-still-running`（active scheduler）」这类判据
   * 不必额外接线就仍然成立。缺省换成「永远不活跃」会让它们**静默降级**到后面那道
   * 状态门上：错误码相同、文案不同，用例改断言就过，判别力却没了。
   */
  readonly isActive?: (taskId: string) => boolean
  /**
   * 复活。**缺省会忠实地把任务从 `interrupted` 推到 `pending`**，但不起任何进程。
   *
   * 「忠实」包含**清掉上一次失败的三个错误字段**（`errorSummary` / `errorMessage` /
   * `failedNodeId`）——生产的 resume 就是这么写的（`childTaskLifecycleParticipant`
   * 的准入 CAS；退役那份 `retryNode` 在自己的准入 CAS 里一并清）。不清的话任务能跑到 `done`
   * 却还挂着上一轮的 `errorSummary`，于是所有「终态 + 无错」的既有断言都读到
   * `done:boom` / `done:task canceled` 这种半截状态。
   *
   * 这一步不能省：共用实现把任务先推到 `interrupted`（一个可 resume 的中转态），
   * 再交给 `resumeTaskAs` 收尾——空桩会让任务停在 `interrupted`，于是所有
   * 「重试之后任务回到 pending」的既有断言都读到一个**半截**的状态。
   * 传自定义实现即完全接管（并发用例这么用）。
   */
  readonly resume?: (taskId: string) => Promise<void>
  /**
   * 端到端套件用这个：给一份 `StartTaskDeps`，复活就把任务真的**驱动起来**。
   *
   * 做两件事：把任务从 `interrupted` 推回 `pending`，再**后台**驱动引擎（不等它跑完）。
   *
   * 两处刻意的选择，都是实撞出来的：
   *   · **不用 `resumeTask`**——它会再做一次自己的回滚，于是「pre_snapshot 已丢」的夹具
   *     会多 escalate 一次 `snapshot-lost`；那不是被测行为，是测试装配引入的第二次回滚
   *     （`rfc096-retry-cascade-inherit` 实撞）。
   *   · **不用任务驱动协调器 / schedulerDriver**——它们都要一个**已登记的 intent**
   *     （合并前 `retryNode` 在自己的 CAS 里建那个 intent），测试凭空造一个 id 只会撞
   *     `task-execution-owner-conflict`。裸引擎入口没有这个前置。
   * 与 `resume` 二选一；两个都给时 `resume` 优先。
   */
  readonly resumeWith?: StartTaskDeps
  /** 级联取消一个子任务。缺省是空操作；并发用例在这里注入搅动。 */
  readonly cancelChildTaskForCascade?: (childTaskId: string, parentTaskId: string) => Promise<void>
  /**
   * `__repo_prep__` 的自有重试路径。不给、但给了 `resumeWith` 时，默认走**真的**
   * `retryRepositoryPreparation`（与合并前 `retryNode` 内部那一句同形）。
   */
  readonly repositoryPreparationRetry?: (taskId: string) => Promise<void>
  readonly now?: () => number
}

export interface RetryEngine {
  readonly appHome: string
  /** 被复活过的任务，按调用顺序。 */
  readonly resumedTaskIds: readonly string[]
  retry(input: {
    readonly taskId: string
    readonly nodeRunId: string
    readonly cascade?: boolean
    readonly actorUserId?: string | null
  }): Promise<Task>
}

/** 先把任务推回可跑状态，再后台驱动引擎——不等它跑完（合并前那一步也是 background）。 */
async function driveInBackground(
  db: ProviderNeutralDatabase,
  taskId: string,
  deps: StartTaskDeps,
  now?: () => number,
): Promise<void> {
  const persistence = createTaskExecutionPersistence(db)
  const moved = await persistence.runtimeLifecycle.trySet({
    taskId,
    to: 'pending',
    allowedFrom: ['interrupted'],
    allowTerminal: true,
    now: now?.() ?? Date.now(),
    extra: { finishedAt: null, errorSummary: null, errorMessage: null, failedNodeId: null },
    reason: 'test-retry-engine:resume',
  })
  if (!moved) throw new Error(`test retry engine: could not resume task '${taskId}'`)
  void runTaskWithRealTestTopology({
    taskId,
    db: db as unknown as Parameters<typeof runTaskWithRealTestTopology>[0]['db'],
    ...(deps.appHome === undefined ? {} : { appHome: deps.appHome }),
    ...(deps.binaryOverride === undefined ? {} : { binaryOverride: deps.binaryOverride }),
  } as unknown as Parameters<typeof runTaskWithRealTestTopology>[0]).catch(() => {
    // 后台驱动失败由用例自己的终态断言反映，这里吞掉避免未捕获拒绝。
  })
}

function actorFor(userId: string | null): Actor {
  return buildActor({
    user: {
      id: userId ?? 'retry-null-actor',
      username: userId ?? 'retry-null-actor',
      displayName: userId ?? 'retry-null-actor',
      role: 'admin',
      status: 'active',
    },
    source: 'session',
  } as unknown as Parameters<typeof buildActor>[0])
}

export function createRetryEngine(
  db: ProviderNeutralDatabase,
  options: RetryEngineOptions = {},
): RetryEngine {
  const appHome = options.appHome ?? mkdtempSync(join(tmpdir(), 'aw-retry-engine-'))
  const persistence = createTaskExecutionPersistence(db)
  const resumedTaskIds: string[] = []
  return {
    appHome,
    resumedTaskIds,
    async retry(input) {
      return await retryNodeProjection(
        {
          db,
          persistence,
          activity:
            options.isActive === undefined
              ? composeLegacyTaskActivityParticipant()
              : { isActive: options.isActive, awaitReleasedSettled: async () => {} },
          repositoryPreparationRetry: {
            retry: async (taskId: string) => {
              if (options.repositoryPreparationRetry !== undefined) {
                await options.repositoryPreparationRetry(taskId)
                return
              }
              if (options.resumeWith !== undefined) {
                await retryRepositoryPreparation(
                  db as unknown as Parameters<typeof retryRepositoryPreparation>[0],
                  taskId,
                  options.resumeWith,
                )
              }
            },
          },
          resumeTaskAs: async (_actor, taskId) => {
            resumedTaskIds.push(taskId)
            if (options.resume !== undefined) {
              await options.resume(taskId)
              return
            }
            if (options.resumeWith !== undefined) {
              await driveInBackground(db, taskId, options.resumeWith, options.now)
              return
            }
            // `interrupted` 是终态，要显式 `allowTerminal`——退役那份实现的准入 CAS
            // 原注写的就是这句「All four terminal sources are deliberate — allowTerminal」。
            // 不带它 `trySet` 会**静默返回 false**（它不抛），任务停在 interrupted。
            const resumed = await persistence.runtimeLifecycle.trySet({
              taskId,
              to: 'pending',
              allowedFrom: ['interrupted'],
              allowTerminal: true,
              now: options.now?.() ?? Date.now(),
              extra: {
                finishedAt: null,
                errorSummary: null,
                errorMessage: null,
                failedNodeId: null,
              },
              reason: 'test-retry-engine:resume',
            })
            if (!resumed) {
              throw new Error(
                `test retry engine: could not resume task '${taskId}' from interrupted`,
              )
            }
          },
          cancelChildTaskForCascade: async (childTaskId, parentTaskId) => {
            await options.cancelChildTaskForCascade?.(childTaskId, parentTaskId)
          },
          ...(options.now === undefined ? {} : { now: options.now }),
        },
        {
          actor: actorFor(input.actorUserId ?? null),
          taskId: input.taskId,
          nodeRunId: input.nodeRunId,
          cascade: input.cascade ?? true,
        },
      )
    },
  }
}
