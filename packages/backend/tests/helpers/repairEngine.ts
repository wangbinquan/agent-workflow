// RFC-359 AC-1（第 8 刀）—— 修复引擎的**唯一**测试装配点。
//
// 为什么存在：修复这件事曾经有两份实现（`platform/persistence/sqlite/taskLifecycleRepair.ts`
// 与 `taskRouteRepairOperations.ts`），各自有测试、各自都绿，谁也不知道它们同不同
// 答案。第 8 刀把它们合成一份之后，行为套件也只该有一个装配点——否则下一次分叉会从测试侧长出来。
//
// 它把合并后那份实现包成**既有行为套件熟悉的两个入口**（`listRepairOptionsForAlert` /
// `applyRepairOption`），于是 13 个 `lifecycle-repair-*.test.ts` 换一行 import 就能在
// `describeEachProvider` 的两条 lane 上跑——覆盖面从「一份实现 × SQLite 内存库」变成
// 「一份实现 × 两个真引擎」。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildActor, type Actor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  createClarifyRepairParticipant,
  createReviewRepairParticipant,
} from '@/modules/collaboration/composition'
import { createCollaborationRuntimeMechanics } from '@/modules/collaboration/infrastructure/collaborationRuntimeMechanics'
import type { ActiveTaskExecutionParticipant } from '@/modules/task-execution/application/ports/taskExecutionRuntimeParticipants'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import {
  createTaskRouteRepairOperations,
  type TaskRepairOperations,
} from '@/modules/task-execution/infrastructure/taskRouteRepairOperations'
import type { TaskRouteLifecycleAlertNotice } from '@/modules/task-execution/public/taskRoutes'

type Dependencies = Parameters<typeof createTaskRouteRepairOperations>[0]

/** 没被这条用例驱动到的依赖一律炸——「悄悄用了个空实现」是假绿的常见来源。 */
export function unusedDependency<T extends object>(methods: Partial<T> = {}): T {
  return new Proxy(methods, {
    get(target, key) {
      if (Reflect.has(target, key)) return Reflect.get(target, key)
      throw new Error(`这条用例没有声明这个修复依赖：${String(key)}`)
    },
  }) as T
}

export interface RepairEngineOptions {
  /** 复活类修复会调它。默认记录调用但不真跑——行为套件断言的是库里的状态转移。 */
  readonly resume?: (taskId: string) => Promise<void>
  readonly isActive?: (taskId: string) => boolean
  readonly now?: () => number
  readonly appHome?: string
  /**
   * 评审派发（`S1.recreate-doc-version` / `S3.resurrect-review-run` 走它）。默认取**真**的
   * 那一份——classic 那份实现是直接 import `services/review` 的 `dispatchReviewNode`，
   * 注入真实现才让既有断言比的还是同一件事。
   */
  readonly collaborationRuntime?: Dependencies['collaborationRuntime']
}

export interface RepairEngine {
  readonly repairs: TaskRepairOperations
  readonly persistence: ReturnType<typeof createTaskExecutionPersistence>
  readonly appHome: string
  /** 被 `resume` 复活过的任务，按调用顺序。 */
  readonly resumedTaskIds: readonly string[]
  listRepairOptionsForAlert(input: {
    readonly taskId: string
    readonly alertId: string
    readonly actorUserId?: string | null
  }): Promise<Awaited<ReturnType<TaskRepairOperations['repairOptions']>>>
  applyRepairOption(input: {
    readonly taskId: string
    readonly alertId: string
    readonly optionId: string
    readonly actorUserId?: string | null
    readonly onAlert?: (row: TaskRouteLifecycleAlertNotice, transition: 'new' | 'promoted') => void
    readonly onResolved?: (taskId: string) => void
  }): Promise<Awaited<ReturnType<TaskRepairOperations['applyRepair']>>>
}

/**
 * 修复的归属只落审计列（RFC-099），从不进 agent prompt——所以测试里用一个最小 actor
 * 承载 `actorUserId` 即可，不需要真建用户行。
 */
function actorFor(userId: string | null): Actor {
  return buildActor({
    user: {
      id: userId ?? 'repair-null-actor',
      username: userId ?? 'repair-null-actor',
      displayName: userId ?? 'repair-null-actor',
      role: 'admin',
      status: 'active',
    },
    source: 'session',
  } as unknown as Parameters<typeof buildActor>[0])
}

export function createRepairEngine(
  db: ProviderNeutralDatabase,
  options: RepairEngineOptions = {},
): RepairEngine {
  const appHome = options.appHome ?? mkdtempSync(join(tmpdir(), 'aw-repair-engine-'))
  const persistence = createTaskExecutionPersistence(db)
  const resumedTaskIds: string[] = []
  const activity: ActiveTaskExecutionParticipant = {
    isActive: options.isActive ?? (() => false),
    awaitReleasedSettled: async () => {},
  }
  const repairs = createTaskRouteRepairOperations({
    db,
    persistence,
    activity,
    resumeTaskAs: async (_actor: Actor, taskId: string) => {
      resumedTaskIds.push(taskId)
      await options.resume?.(taskId)
    },
    collaborationRuntime: options.collaborationRuntime ?? createCollaborationRuntimeMechanics(db),
    clarify: createClarifyRepairParticipant(db),
    review: createReviewRepairParticipant(db),
    appHome,
    ...(options.now === undefined ? {} : { now: options.now }),
  } as unknown as Dependencies)
  return {
    repairs,
    persistence,
    appHome,
    resumedTaskIds,
    async listRepairOptionsForAlert(input) {
      return await repairs.repairOptions({
        actor: actorFor(input.actorUserId ?? null),
        taskId: input.taskId,
        alertId: input.alertId,
      })
    },
    async applyRepairOption(input) {
      return await repairs.applyRepair({
        actor: actorFor(input.actorUserId ?? null),
        taskId: input.taskId,
        alertId: input.alertId,
        optionId: input.optionId,
        onAlert: input.onAlert ?? (() => {}),
        onResolved: input.onResolved ?? (() => {}),
      })
    },
  }
}
