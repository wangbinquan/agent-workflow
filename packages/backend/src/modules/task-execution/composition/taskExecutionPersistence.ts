import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { unhandledDatabaseProvider } from '@/platform/persistence/databaseProviders'
import { DatabaseTaskDecisionPersistence } from '../infrastructure/taskDecisionParticipant'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { TaskExecutionPersistence } from '../application/ports/taskExecutionPersistence'
import { PostgresqlTaskOwnershipPersistence } from '../infrastructure/postgresqlTaskOwnershipPersistence'
import { DrizzleTaskExecutionIntentPersistence } from '../infrastructure/taskExecutionIntentPersistence'
import { SqliteTaskOwnershipPersistence } from '../infrastructure/sqliteTaskOwnershipPersistence'
import { createTaskExecutionReadModels } from '../infrastructure/taskExecutionReadModels'
import { SqliteTaskExecutionEffectPersistence } from '../infrastructure/sqliteTaskExecutionEffectPersistence'
import { PostgresqlTaskExecutionEffectPersistence } from '../infrastructure/postgresqlTaskExecutionEffectPersistence'
import { PostgresqlTerminalMaintenancePersistence } from '../infrastructure/postgresqlTerminalMaintenancePersistence'
import { SqliteTerminalMaintenancePersistence } from '../infrastructure/sqliteTerminalMaintenancePersistence'
import { DrizzleGateContinuationEffectPersistence } from '../infrastructure/gateContinuationEffectPersistence'
import { DrizzleTaskExecutionIntentTerminalPersistence } from '../infrastructure/taskExecutionIntentTerminalPersistence'
import { PostgresqlTaskExecutionRecoveryPersistence } from '../infrastructure/postgresqlTaskExecutionRecovery'
import { SqliteTaskExecutionRecoveryPersistence } from '../infrastructure/sqliteTaskExecutionRecoveryPersistence'
import { PostgresqlHumanGateTaskLifecyclePersistence } from '../infrastructure/postgresqlHumanGateTaskLifecyclePersistence'
import { SqliteHumanGateTaskLifecyclePersistence } from '../infrastructure/sqliteHumanGateTaskLifecyclePersistence'
import { DrizzleTaskEngineApplicationPersistence } from '../infrastructure/taskEngineApplicationPersistence'
import { DrizzleGateContinuationPreDrivePersistence } from '../infrastructure/gateContinuationPreDrivePersistence'
import { DrizzleSchedulerCompletionPersistence } from '../infrastructure/schedulerCompletionPersistence'
import { DrizzleChildTaskBudgetQueries } from '../infrastructure/childTaskBudgetQueries'
import { DrizzleNodeRunLifecyclePersistence } from '../infrastructure/nodeRunLifecyclePersistence'
import { DrizzleNodeRunRuntimePersistence } from '../infrastructure/nodeRunRuntimePersistence'
import { DrizzleWrapperRunPersistence } from '../infrastructure/wrapperRunPersistence'
import { DrizzleTaskRuntimeLifecyclePersistence } from '../infrastructure/taskRuntimeLifecyclePersistence'
import { createRuntimeSessionCapturePersistence } from '../infrastructure/runtimeSessionCapturePersistence'
import { SqliteTaskExecutionShutdownOperations } from '../infrastructure/sqliteTaskExecutionShutdownOperations'
import { PostgresqlTaskExecutionShutdownOperations } from '../infrastructure/postgresqlTaskExecutionShutdownOperations'
import { DrizzleNodeExecutionPersistence } from '../infrastructure/nodeExecutionPersistence'
import { DrizzleNodeActivationSnapshotReader } from '../infrastructure/nodeActivationSnapshotReader'
import { DrizzleMergeStateLifecyclePersistence } from '../infrastructure/mergeStateLifecyclePersistence'
import { DrizzleTaskArtifactPathQueries } from '../infrastructure/taskArtifactPathQueries'
import {
  createTaskRecoveryOperations,
  repairRuntimeSessionLeaseAfterOrphanReapTx,
} from '../infrastructure/taskRecoveryOperations'
import { terminalizeTaskExecutionIntentsInTx } from '../infrastructure/taskExecutionIntentTerminalPersistence'
import { createSqliteRuntimeSessionLeaseOperations } from '../infrastructure/sqliteRuntimeSessionLeaseOperations'
import { createPostgresqlRuntimeSessionLeaseOperations } from '../infrastructure/postgresqlRuntimeSessionLeaseOperations'
import type { RuntimeSessionLeaseOperations } from '../application/ports/runtimeSessionLeaseOperations'
import { terminalizeTaskExecutionIntentsTx } from '../infrastructure/sqliteTerminalizeExecutionIntent'
import { trySetTaskStatus } from '@/services/lifecycle'
import { repairRuntimeSessionLeasesAfterOrphanReap } from '@/services/runtimeSessionLease'

/** RFC-359 W4-B1 批 2e：恢复读 / 写只有一份实现；这里只注入 PostgreSQL 的四条状态迁移。 */
function createPostgresqlRecoveryAdministration(db: PostgresqlDatabaseClient) {
  const nodeLifecycle = new DrizzleNodeRunLifecyclePersistence(db)
  const taskLifecycle = new DrizzleTaskRuntimeLifecyclePersistence(db)
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
      return repairRuntimeSessionLeaseAfterOrphanReapTx(db, nodeRunId)
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

function createSqliteRecoveryAdministration(db: DbClient) {
  const nodeLifecycle = new DrizzleNodeRunLifecyclePersistence(db)
  const taskLifecycle = new DrizzleTaskRuntimeLifecyclePersistence(db)
  const runtimeLeaseOperations = createSqliteRuntimeSessionLeaseOperations(db)
  return createTaskRecoveryOperations(db, {
    async interruptBootOrphanTask(input) {
      return await trySetTaskStatus({
        db,
        taskId: input.taskId,
        to: 'interrupted',
        allowedFrom: [input.from],
        extra: {
          finishedAt: input.now,
          errorSummary: input.failureCode,
          errorMessage: input.errorMessage,
        },
        onTransitionTx: (tx) =>
          terminalizeTaskExecutionIntentsTx({
            tx,
            taskId: input.taskId,
            state: 'failed',
            failureCode: input.failureCode,
            now: input.now,
          }),
        reason: 'reapOrphanRuns',
      })
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

export function createSqliteTaskExecutionPersistence(db: DbClient): TaskExecutionPersistence {
  const effects = new SqliteTaskExecutionEffectPersistence(db)
  return Object.freeze({
    drive: new DrizzleTaskEngineApplicationPersistence(db),
    ownership: new SqliteTaskOwnershipPersistence(db),
    intents: new DrizzleTaskExecutionIntentPersistence(db),
    effects,
    terminalMaintenance: new SqliteTerminalMaintenancePersistence(db),
    gateContinuationEffects: new DrizzleGateContinuationEffectPersistence(db, effects),
    gateContinuationPreDrive: new DrizzleGateContinuationPreDrivePersistence(db),
    scheduler: new DrizzleSchedulerCompletionPersistence(db),
    childBudget: new DrizzleChildTaskBudgetQueries(db),
    nodeRuns: new DrizzleNodeRunLifecyclePersistence(db),
    nodeRunRuntime: new DrizzleNodeRunRuntimePersistence(db),
    nodeExecution: new DrizzleNodeExecutionPersistence(db),
    nodeActivation: new DrizzleNodeActivationSnapshotReader(db),
    mergeStates: new DrizzleMergeStateLifecyclePersistence(db),
    artifactPaths: new DrizzleTaskArtifactPathQueries(db),
    wrapperRuns: new DrizzleWrapperRunPersistence(db),
    runtimeLifecycle: new DrizzleTaskRuntimeLifecyclePersistence(db),
    intentTerminalization: new DrizzleTaskExecutionIntentTerminalPersistence(db),
    recovery: new SqliteTaskExecutionRecoveryPersistence(db),
    humanGateDecisions: new DatabaseTaskDecisionPersistence(databaseSessionFor(db)),
    humanGateLifecycle: new SqliteHumanGateTaskLifecyclePersistence(db),
    reads: createTaskExecutionReadModels(db),
    recoveryAdministration: createSqliteRecoveryAdministration(db),
    shutdown: new SqliteTaskExecutionShutdownOperations(db),
    runtimeSessionCapture: createRuntimeSessionCapturePersistence(db),
  })
}

export function createPostgresqlTaskExecutionPersistence(
  db: PostgresqlDatabaseClient,
): TaskExecutionPersistence {
  const effects = new PostgresqlTaskExecutionEffectPersistence(db)
  return Object.freeze({
    drive: new DrizzleTaskEngineApplicationPersistence(db),
    ownership: new PostgresqlTaskOwnershipPersistence(db),
    intents: new DrizzleTaskExecutionIntentPersistence(db),
    effects,
    terminalMaintenance: new PostgresqlTerminalMaintenancePersistence(db),
    gateContinuationEffects: new DrizzleGateContinuationEffectPersistence(db, effects),
    gateContinuationPreDrive: new DrizzleGateContinuationPreDrivePersistence(db),
    scheduler: new DrizzleSchedulerCompletionPersistence(db),
    childBudget: new DrizzleChildTaskBudgetQueries(db),
    nodeRuns: new DrizzleNodeRunLifecyclePersistence(db),
    nodeRunRuntime: new DrizzleNodeRunRuntimePersistence(db),
    nodeExecution: new DrizzleNodeExecutionPersistence(db),
    nodeActivation: new DrizzleNodeActivationSnapshotReader(db),
    mergeStates: new DrizzleMergeStateLifecyclePersistence(db),
    artifactPaths: new DrizzleTaskArtifactPathQueries(db),
    wrapperRuns: new DrizzleWrapperRunPersistence(db),
    runtimeLifecycle: new DrizzleTaskRuntimeLifecyclePersistence(db),
    intentTerminalization: new DrizzleTaskExecutionIntentTerminalPersistence(db),
    recovery: new PostgresqlTaskExecutionRecoveryPersistence(db),
    humanGateDecisions: new DatabaseTaskDecisionPersistence(databaseSessionFor(db)),
    humanGateLifecycle: new PostgresqlHumanGateTaskLifecyclePersistence(db),
    reads: createTaskExecutionReadModels(db),
    recoveryAdministration: createPostgresqlRecoveryAdministration(db),
    shutdown: new PostgresqlTaskExecutionShutdownOperations(db),
    runtimeSessionCapture: createRuntimeSessionCapturePersistence(db),
  })
}

/**
 * RFC-359 T7b：按客户端句柄选 persistence 聚合。这是 task-execution 里看 provider 的唯一入口之一；
 * 调用方拿到的是一份 `TaskExecutionPersistence`，看不见 provider。第三个 provider 在这里得到自己的
 * 分支，残余分支是 `unhandledDatabaseProvider` 的 never 汇。
 */
export function createTaskExecutionPersistence(
  db: ProviderNeutralDatabase,
): TaskExecutionPersistence {
  const provider = databaseSessionFor(db).engine.provider
  return provider === 'postgresql'
    ? createPostgresqlTaskExecutionPersistence(db as unknown as PostgresqlDatabaseClient)
    : provider === 'sqlite'
      ? createSqliteTaskExecutionPersistence(db as unknown as DbClient)
      : unhandledDatabaseProvider(provider)
}

/** RFC-359 W3-T4：runtime session lease 操作按客户端品牌选实现；同上，调用方看不见 provider。 */
export function createRuntimeSessionLeaseOperations(
  db: ProviderNeutralDatabase,
): RuntimeSessionLeaseOperations {
  const provider = databaseSessionFor(db).engine.provider
  return provider === 'postgresql'
    ? createPostgresqlRuntimeSessionLeaseOperations(db as unknown as PostgresqlDatabaseClient)
    : provider === 'sqlite'
      ? createSqliteRuntimeSessionLeaseOperations(db as unknown as DbClient)
      : unhandledDatabaseProvider(provider)
}
