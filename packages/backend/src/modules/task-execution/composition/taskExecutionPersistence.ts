import type { HumanGateOpenParticipantFactory } from '../application/ports/humanGateOpenFactory'
import type { ContentStore } from '@/platform/content/contentStore'
import type { HistoryRestrictionPort } from '@/platform/contracts/historyRestriction'
import type { TaskRecoveryHumanGateFactsPort } from './required-ports'
import { createRunSelectionReader } from '../infrastructure/runSelection/table/reader'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createFileWorkspacePresenceQueries } from '@/modules/source-control/composition/workspacePresence'
import type { WorkspacePresenceQueries } from '@/modules/source-control/public/queries'
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
import { DrizzleWrapperRunPersistence } from '../infrastructure/wrapperRunPersistence'
import { DrizzleTaskRuntimeLifecyclePersistence } from '../infrastructure/taskRuntimeLifecyclePersistence'
import { createRuntimeSessionCapturePersistence } from '../infrastructure/runtimeSessionCapturePersistence'
import { DrizzleTaskExecutionShutdownOperations } from '../infrastructure/taskExecutionShutdownOperations'
import { DrizzleNodeExecutionPersistence } from '../infrastructure/nodeExecutionPersistence'
import { DrizzleNodeActivationSnapshotReader } from '../infrastructure/nodeActivationSnapshotReader'
import { DrizzleMergeStateLifecyclePersistence } from '../infrastructure/mergeStateLifecyclePersistence'
import { DrizzleTaskArtifactPathQueries } from '../infrastructure/taskArtifactPathQueries'
import { createTaskRecoveryAdministration } from '../infrastructure/taskRecoveryAdministration'
import { DrizzleTaskExecutionIntentTerminalPersistence } from '../infrastructure/taskExecutionIntentTerminalPersistence'
import { createTaskClarifyDirectivePersistence } from '../infrastructure/taskClarifyDirectivePersistence'

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
export interface TaskExecutionPersistenceDependencies {
  readonly humanGateOpen: HumanGateOpenParticipantFactory
  readonly historyRestrictions: HistoryRestrictionPort
  readonly content?: Pick<ContentStore, 'read'>
  readonly recoveryHumanGates?: TaskRecoveryHumanGateFactsPort
  readonly workspacePresence?: WorkspacePresenceQueries
}

export function createTaskRuntimeLifecyclePersistence(
  db: PersistenceDb,
  dependencies: Pick<TaskExecutionPersistenceDependencies, 'workspacePresence'> = {},
): DrizzleTaskRuntimeLifecyclePersistence {
  return new DrizzleTaskRuntimeLifecyclePersistence(
    db,
    dependencies.workspacePresence ?? createFileWorkspacePresenceQueries(),
  )
}

export function createTaskExecutionPersistence(
  db: PersistenceDb,
  dependencies: TaskExecutionPersistenceDependencies,
): TaskExecutionPersistence {
  const effects = new DrizzleTaskExecutionEffectPersistence(db)
  const runtimeLifecycle = createTaskRuntimeLifecyclePersistence(db, dependencies)
  const humanGateLifecycle = new DatabaseHumanGateTaskLifecyclePersistence(db, runtimeLifecycle, {
    humanGateOpen: dependencies.humanGateOpen,
    historyRestrictions: dependencies.historyRestrictions,
  })
  return Object.freeze({
    selection: createRunSelectionReader(db),
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
    nodeExecution: new DrizzleNodeExecutionPersistence(db, dependencies.content),
    nodeActivation: new DrizzleNodeActivationSnapshotReader(db),
    mergeStates: new DrizzleMergeStateLifecyclePersistence(db),
    artifactPaths: new DrizzleTaskArtifactPathQueries(db),
    wrapperRuns: new DrizzleWrapperRunPersistence(db),
    runtimeLifecycle,
    intentTerminalization: new DrizzleTaskExecutionIntentTerminalPersistence(db),
    recovery: new DrizzleTaskExecutionRecoveryPersistence(db),
    humanGateDecisions: new DatabaseTaskDecisionPersistence(databaseSessionFor(db)),
    humanGateLifecycle,
    reads: createTaskExecutionReadModels(db, dependencies.content),
    recoveryAdministration: createTaskRecoveryAdministration(
      db,
      runtimeLifecycle,
      dependencies.recoveryHumanGates,
    ),
    shutdown: new DrizzleTaskExecutionShutdownOperations(db),
    runtimeSessionCapture: createRuntimeSessionCapturePersistence(db),
    clarifyDirectives: createTaskClarifyDirectivePersistence(db),
  })
}

/**
 * RFC-359 W4-D24：runtime session lease 只剩一份实现，这里不再按品牌分派，直接转出去。
 * 保留这个名字是为了两个 bootstrap 与既有测试的 import 不变。
 */
export { createRuntimeSessionLeaseOperations } from '../infrastructure/runtimeSessionLeaseOperations'

export { createTaskExecutionResourceBinding } from '../infrastructure/taskExecutionResourceSnapshots'
