import { composeHumanGateOpenParticipantFactory } from '@/modules/collaboration/composition'
import { epoch2RuntimeTestPorts } from './epoch2RuntimePorts'
import { o2Ports } from './o2Closure'
// RFC-359 AC-1（第 11 刀）—— `cancel` 的**唯一**测试装配点。
//
// 为什么存在：`cancel` 曾经有两份实现（`services/task.ts` 的 `cancelTask` 与
// `childTaskLifecycleParticipant` 的 `cancelCascade`），各自有测试、各自都绿，
// 谁也没跟谁比过。合成一份之后行为套件也只该有一个装配点——否则下一次分叉会从测试侧长出来
//（同 `retry` / `resume` 两刀留下的 `retryEngine.ts` / `resumeEngine.ts`）。
//
// 它把共用实现包成既有套件熟悉的调用形状（`cancel(db, taskId, opts?) => Task`），
// 并保留唯一的测试接缝：
//   · **CAS 注入点**（`beforeStatusCas`）——生产从不传；只有锁「CAS 被别的生命周期写者持续
//     挤掉时必须报 starved、而不是把失败当成功」的那条回归判据传；
// RFC-388: live controllers use the execution module registry and its normal stop tickets.
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { taskExecutionModule } from '@/services/taskExecutionParticipants'
import { cancelTaskProjection } from '@/modules/task-execution/infrastructure/childTaskLifecycleParticipant'
import { getTask } from '@/services/task'
import { NotFoundError } from '@/util/errors'
import { createLogger } from '@/util/log'
import type { Task } from '@agent-workflow/shared'

const log = createLogger('task')

export interface CancelEngineOptions {
  /** RFC-243 §4.3——父级联取消。落 `canceled-by-parent-cascade` 标记。 */
  readonly cascadeFromParent?: boolean
  /** 级联来源的确切父任务 id；缺省取被取消者自己（同退役那份）。 */
  readonly cascadeParentTaskId?: string
  /** 取消 CAS 之前的注入点。**生产从不传**。 */
  readonly beforeStatusCas?: () => void | Promise<void>
}

/** 与退役的 `cancelTask(db, id, opts)` 同形：取消之后把任务行重读一遍还回来。 */
export async function cancelViaEngine(
  db: PersistenceDb,
  taskId: string,
  opts: CancelEngineOptions = {},
): Promise<Task> {
  await cancelTaskProjection(
    {
      db,
      persistence: createTaskExecutionPersistence(db, {
        humanGateOpen: composeHumanGateOpenParticipantFactory(),
        historyRestrictions: epoch2RuntimeTestPorts(db).historyRestrictions,
        recoveryHumanGates: o2Ports(db).collaborationReads.recovery,
      }),
      // ⚠️ 交的是**任务驱动**注册表（停机票据），不是 `platform/runtime-registry` 的运行时档案表。
      stop: taskExecutionModule.runtimeRegistry,
      log,
    },
    taskId,
    opts.cascadeFromParent === true
      ? { kind: 'parent-cascade', parentTaskId: opts.cascadeParentTaskId ?? taskId }
      : { kind: 'user' },
    {
      ...(opts.beforeStatusCas === undefined ? {} : { beforeStatusCas: opts.beforeStatusCas }),
    },
  )
  const task = await getTask(db, taskId)
  if (task === null) throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  return task
}
