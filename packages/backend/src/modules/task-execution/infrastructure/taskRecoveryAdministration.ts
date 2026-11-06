// RFC-419: the recovery administration face, moved verbatim from composition/taskExecutionPersistence.ts (renamed
// from createRecoveryAdministration); every method is a persistence operation on the shared recovery primitives.
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { repairRuntimeSessionLeasesAfterOrphanReap } from '../application/runtimeSessionLease'
import type { TaskRecoveryHumanGateFactsPort } from '../composition/required-ports'
import { DrizzleNodeRunLifecyclePersistence } from './nodeRunLifecyclePersistence'
import { createRuntimeSessionLeaseOperations as createRuntimeSessionLeaseOperationsInternal } from './runtimeSessionLeaseOperations'
import { terminalizeTaskExecutionIntentsInTx } from './taskExecutionIntentTerminalPersistence'
import { createTaskRecoveryOperations } from './taskRecoveryOperations'
import type { DrizzleTaskRuntimeLifecyclePersistence } from './taskRuntimeLifecyclePersistence'

/**
 * RFC-359 AC-10：恢复管理面**一份实现**。两个 provider 曾各有一份，四个方法里两个逐字相同、
 * 两个各不相同——而且不同的那两个**各让一个引擎更弱**，正是「两种数据库一个好一个不好」：
 *
 *   · `interruptBootOrphanTask` —— PG 走 `trySetWithGuard` + 严判据终态化（终态化写回行数对
 *     不上就 `task-continuation-stale` 整笔回滚）；SQLite 走 `trySetTaskStatus` + 宽判据，
 *     写没写进去都当成功。SQLite 那支还**漏传了 `now`**，于是落到
 *     `const now = args.now ?? Date.now()` 的兜底上：同一行里 `finishedAt` 记调用方时钟、
 *     `runningMs` 记墙上时钟，两个瞬间对不上。判据取严、时钟取调用方。
 *
 *   · `repairRuntimeSessionLeaseAfterOrphanReap` —— SQLite 走共享的 lease 原语，每笔
 *     release / discard 都过 `fenceTaskWrite` 那道任务归属闸；PG 走一份手抄的事务内联版，
 *     抄的时候把闸漏了。收敛到共享原语，闸两个引擎都过。
 *
 * 收敛后这四个方法一个 provider 名都不问，`createTaskExecutionPersistence` 的分派三元也就
 * 没有存在理由了。
 */
export function createTaskRecoveryAdministration(
  db: PersistenceDb,
  taskLifecycle: Pick<DrizzleTaskRuntimeLifecyclePersistence, 'trySet' | 'trySetWithGuard'>,
  humanGates?: TaskRecoveryHumanGateFactsPort,
) {
  const nodeLifecycle = new DrizzleNodeRunLifecyclePersistence(db)
  const runtimeLeaseOperations = createRuntimeSessionLeaseOperationsInternal(db)
  return createTaskRecoveryOperations(
    db,
    {
      async interruptBootOrphanTask(input) {
        return await taskLifecycle.trySetWithGuard(
          {
            taskId: input.taskId,
            to: 'interrupted',
            allowedFrom: [input.from],
            extra: {
              finishedAt: input.now,
              errorSummary: input.failureCode,
              errorMessage: input.errorMessage,
            },
            now: input.now,
            reason: 'reapOrphanRuns',
          },
          (tx) =>
            terminalizeTaskExecutionIntentsInTx(tx, {
              taskId: input.taskId,
              state: 'failed',
              failureCode: input.failureCode,
              now: input.now,
            }),
        )
      },
      async interruptNodeRun(input) {
        try {
          await nodeLifecycle.transition({
            nodeRunId: input.nodeRunId,
            event: { kind: 'mark-interrupted' },
            extra: {
              identity: {
                finishedAt: input.now,
                ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
              },
            },
          })
          return true
        } catch {
          return false
        }
      },
      async repairRuntimeSessionLeaseAfterOrphanReap(nodeRunId) {
        return repairRuntimeSessionLeasesAfterOrphanReap(runtimeLeaseOperations, true, nodeRunId)
      },
      async interruptPeriodicTaskIfIdle(input) {
        return taskLifecycle.trySet({
          taskId: input.taskId,
          to: 'interrupted',
          allowedFrom: ['running'],
          extra: { finishedAt: input.now, errorSummary: input.failureCode },
          now: input.now,
          reason: 'reconcileDeadRunningRuns',
        })
      },
    },
    humanGates,
  )
}
