// RFC-359 AC-1（第 10 刀）—— `resume` 的**唯一**测试装配点。
//
// 为什么存在：`resume` 曾经有两份实现（`services/task.ts` 的 `resumeTask` 与
// `childTaskLifecycleParticipant` 的那份），各自有测试、各自都绿，谁也没跟谁比过。
// 合成一份之后行为套件也只该有一个装配点——否则下一次分叉会从测试侧长出来
//（同 `retry` 那一刀留下的 `tests/helpers/retryEngine.ts`）。
//
// 它把共用实现包成既有套件熟悉的调用形状（`resume(taskId) => Task`），并把两处
// 「退役那份用 `StartTaskDeps` 表达、共用那份不认识」的东西显式化：
//   · **收尾模式**：`awaitScheduler: true` → `completionMode: 'await-settle'`；
//   · **活跃度**：缺省就是生产那一份（进程级注册表），要造「已经有人在跑」的判据自己传。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  createRuntimeSessionLeaseOperations,
  createTaskExecutionPersistence,
} from '@/modules/task-execution/composition/taskExecutionPersistence'
import { createDatabaseTaskDriverLifecyclePort } from '@/modules/task-execution/infrastructure/taskDriverLifecycle'
import { composeLegacyTaskActivityParticipant } from '@/modules/task-execution/infrastructure/taskExecutionRuntimeParticipants'
import { resumeTaskProjection } from '@/modules/task-execution/infrastructure/childTaskLifecycleParticipant'
import { finishClaimedWebhookWorkspacePrune } from '@/platform/persistence/sqlite/systemWorkspaceGc'
import { getTask } from '@/services/task'
import { createLogger } from '@/util/log'
import { NotFoundError } from '@/util/errors'
import type { Task } from '@agent-workflow/shared'

export interface ResumeEngineOptions {
  readonly appHome?: string
  /** 引擎驱动面。既有套件普遍交 `createTaskExecutionTestTopology(...).schedulerDriver`。 */
  readonly schedulerDriver: Parameters<typeof resumeTaskProjection>[2]['schedulerDriver']
  /** 透传给 `resolveTaskDriveConfig` 的运行期配置（`binaryOverride` / 超时 / 并发等）。 */
  readonly runConfig?: Record<string, unknown>
  /** 退役那份的 `awaitScheduler: true` 就是这一格。 */
  readonly awaitScheduler?: boolean
  /**
   * 进程内活跃度。**缺省就是生产那一份**（`composeLegacyTaskActivityParticipant`）——
   * 退役那份读的也是它，所以「调度器挂起期间 resume → 409」这类判据不必额外接线就仍成立。
   */
  readonly isActive?: (taskId: string) => boolean
  readonly actorUserId?: string
}

export interface ResumeEngine {
  readonly appHome: string
  /** 与退役那份 `resumeTask(db, taskId, deps)` 同形：复活之后把任务行重读一遍还回来。 */
  resume(taskId: string): Promise<Task>
}

export function createResumeEngine(
  db: ProviderNeutralDatabase,
  options: ResumeEngineOptions,
): ResumeEngine {
  const appHome = options.appHome ?? mkdtempSync(join(tmpdir(), 'aw-resume-engine-'))
  const log = createLogger('task')
  return {
    appHome,
    async resume(taskId) {
      await resumeTaskProjection(
        {
          db,
          persistence: createTaskExecutionPersistence(db),
          runtimeSessionLeases: createRuntimeSessionLeaseOperations(db),
          log,
          activity:
            options.isActive === undefined
              ? composeLegacyTaskActivityParticipant()
              : { isActive: options.isActive, awaitReleasedSettled: async () => {} },
          lifecycle: createDatabaseTaskDriverLifecyclePort({
            db,
            log,
            finalizeWorkspace: async (id: string) => {
              await finishClaimedWebhookWorkspacePrune(
                db as unknown as Parameters<typeof finishClaimedWebhookWorkspacePrune>[0],
                id,
              )
            },
          }),
        },
        {
          taskId,
          runtime: {
            ...(options.actorUserId === undefined ? {} : { actorUserId: options.actorUserId }),
            runConfig: { appHome, ...(options.runConfig ?? {}) },
          },
        } as unknown as Parameters<typeof resumeTaskProjection>[1],
        { schedulerDriver: options.schedulerDriver } as unknown as Parameters<
          typeof resumeTaskProjection
        >[2],
        options.awaitScheduler === true ? { completionMode: 'await-settle' } : {},
      )
      const task = await getTask(db, taskId)
      if (task === null) throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
      return task
    },
  }
}
