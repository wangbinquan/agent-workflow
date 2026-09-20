import type { ProviderNeutralDatabase } from '@/db/query'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { DatabaseTaskDecisionPersistence } from '../infrastructure/taskDecisionParticipant'
import type { TaskExecutionPersistence } from '../application/ports/taskExecutionPersistence'
import { DrizzleTaskExecutionIntentPersistence } from '../infrastructure/taskExecutionIntentPersistence'
import { DrizzleTaskOwnershipPersistence } from '../infrastructure/taskOwnershipPersistence'
import { createTaskExecutionReadModels } from '../infrastructure/taskExecutionReadModels'
import { DrizzleTaskExecutionEffectPersistence } from '../infrastructure/taskExecutionEffectPersistence'
import { DrizzleTerminalMaintenancePersistence } from '../infrastructure/terminalMaintenancePersistence'
import { DrizzleGateContinuationEffectPersistence } from '../infrastructure/gateContinuationEffectPersistence'
import { DrizzleTaskExecutionRecoveryPersistence } from '../infrastructure/taskExecutionRecovery'
import { DatabaseHumanGateTaskLifecyclePersistence } from '../infrastructure/humanGateTaskLifecyclePersistence'
import { DrizzleTaskEngineApplicationPersistence } from '../infrastructure/taskEngineApplicationPersistence'
import { DrizzleGateContinuationPreDrivePersistence } from '../infrastructure/gateContinuationPreDrivePersistence'
import { DrizzleSchedulerCompletionPersistence } from '../infrastructure/schedulerCompletionPersistence'
import { DrizzleChildTaskBudgetQueries } from '../infrastructure/childTaskBudgetQueries'
import { DrizzleNodeRunLifecyclePersistence } from '../infrastructure/nodeRunLifecyclePersistence'
import { composeNodeRunRuntimePersistence } from '@/modules/task-execution/composition/nodeRunRuntime'
import { DrizzleWrapperRunPersistence } from '../infrastructure/wrapperRunPersistence'
import { DrizzleTaskRuntimeLifecyclePersistence } from '../infrastructure/taskRuntimeLifecyclePersistence'
import { createRuntimeSessionCapturePersistence } from '../infrastructure/runtimeSessionCapturePersistence'
import { DrizzleTaskExecutionShutdownOperations } from '../infrastructure/taskExecutionShutdownOperations'
import { DrizzleNodeExecutionPersistence } from '../infrastructure/nodeExecutionPersistence'
import { DrizzleNodeActivationSnapshotReader } from '../infrastructure/nodeActivationSnapshotReader'
import { DrizzleMergeStateLifecyclePersistence } from '../infrastructure/mergeStateLifecyclePersistence'
import { DrizzleTaskArtifactPathQueries } from '../infrastructure/taskArtifactPathQueries'
import { createTaskRecoveryOperations } from '../infrastructure/taskRecoveryOperations'
import {
  DrizzleTaskExecutionIntentTerminalPersistence,
  terminalizeTaskExecutionIntentsInTx,
} from '../infrastructure/taskExecutionIntentTerminalPersistence'
import { createRuntimeSessionLeaseOperations as createRuntimeSessionLeaseOperationsInternal } from '../infrastructure/runtimeSessionLeaseOperations'
import { repairRuntimeSessionLeasesAfterOrphanReap } from '@/services/runtimeSessionLease'

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
function createRecoveryAdministration(db: ProviderNeutralDatabase) {
  const nodeLifecycle = new DrizzleNodeRunLifecyclePersistence(db)
  const taskLifecycle = new DrizzleTaskRuntimeLifecyclePersistence(db)
  const runtimeLeaseOperations = createRuntimeSessionLeaseOperationsInternal(db)
  return createTaskRecoveryOperations(db, {
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
            finishedAt: input.now,
            ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
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
  })
}

/**
 * 一份 persistence 聚合，里面没有任何一个参与者看 provider。
 *
 * RFC-359 AC-10：这里原来是 task-execution 里少数几个看 provider 的入口之一——按客户端句柄的
 * 品牌在两份聚合之间三元选一，两份聚合各配一份恢复管理面。恢复管理面合一之后两份聚合逐字
 * 相同，于是分派三元、那道 `unhandledDatabaseProvider` 穷尽性围栏、以及
 * `create{Sqlite,Postgresql}TaskExecutionPersistence` 两个带品牌的入口一并消失（后者的函数体
 * 一旦相同就被 `rfc359-w5-identical-provider-twins` 当场咬住，处方就是收成这一份）。
 * 第三个 provider 在这里什么都不用加。
 */
export function createTaskExecutionPersistence(
  db: ProviderNeutralDatabase,
): TaskExecutionPersistence {
  const effects = new DrizzleTaskExecutionEffectPersistence(db)
  return Object.freeze({
    drive: new DrizzleTaskEngineApplicationPersistence(db),
    ownership: new DrizzleTaskOwnershipPersistence(db),
    intents: new DrizzleTaskExecutionIntentPersistence(db),
    effects,
    terminalMaintenance: new DrizzleTerminalMaintenancePersistence(db),
    gateContinuationEffects: new DrizzleGateContinuationEffectPersistence(db, effects),
    gateContinuationPreDrive: new DrizzleGateContinuationPreDrivePersistence(db),
    scheduler: new DrizzleSchedulerCompletionPersistence(db),
    childBudget: new DrizzleChildTaskBudgetQueries(db),
    nodeRuns: new DrizzleNodeRunLifecyclePersistence(db),
    nodeRunRuntime: composeNodeRunRuntimePersistence(db),
    nodeExecution: new DrizzleNodeExecutionPersistence(db),
    nodeActivation: new DrizzleNodeActivationSnapshotReader(db),
    mergeStates: new DrizzleMergeStateLifecyclePersistence(db),
    artifactPaths: new DrizzleTaskArtifactPathQueries(db),
    wrapperRuns: new DrizzleWrapperRunPersistence(db),
    runtimeLifecycle: new DrizzleTaskRuntimeLifecyclePersistence(db),
    intentTerminalization: new DrizzleTaskExecutionIntentTerminalPersistence(db),
    recovery: new DrizzleTaskExecutionRecoveryPersistence(db),
    humanGateDecisions: new DatabaseTaskDecisionPersistence(databaseSessionFor(db)),
    humanGateLifecycle: new DatabaseHumanGateTaskLifecyclePersistence(db),
    reads: createTaskExecutionReadModels(db),
    recoveryAdministration: createRecoveryAdministration(db),
    shutdown: new DrizzleTaskExecutionShutdownOperations(db),
    runtimeSessionCapture: createRuntimeSessionCapturePersistence(db),
  })
}

/**
 * RFC-359 W4-D24：runtime session lease 只剩一份实现，这里不再按品牌分派，直接转出去。
 * 保留这个名字是为了两个 bootstrap 与既有测试的 import 不变。
 */
export { createRuntimeSessionLeaseOperations } from '../infrastructure/runtimeSessionLeaseOperations'
