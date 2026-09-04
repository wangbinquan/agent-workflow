import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { unhandledDatabaseProvider } from '@/platform/persistence/databaseProviders'
import { DatabaseTaskDecisionPersistence } from '../infrastructure/taskDecisionParticipant'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { TaskExecutionPersistence } from '../application/ports/taskExecutionPersistence'
import { PostgresqlTaskExecutionIntentPersistence } from '../infrastructure/postgresqlTaskExecutionIntentPersistence'
import { PostgresqlTaskOwnershipPersistence } from '../infrastructure/postgresqlTaskOwnershipPersistence'
import { SqliteTaskExecutionIntentPersistence } from '../infrastructure/sqliteTaskExecutionIntentPersistence'
import { SqliteTaskOwnershipPersistence } from '../infrastructure/sqliteTaskOwnershipPersistence'
import { createPostgresqlTaskExecutionReadModels } from '../infrastructure/postgresqlTaskExecutionReadModels'
import { createSqliteTaskExecutionReadModels } from '../infrastructure/sqliteTaskExecutionReadModels'
import { SqliteTaskExecutionEffectPersistence } from '../infrastructure/sqliteTaskExecutionEffectPersistence'
import { PostgresqlTaskExecutionEffectPersistence } from '../infrastructure/postgresqlTaskExecutionEffectPersistence'
import { PostgresqlTerminalMaintenancePersistence } from '../infrastructure/postgresqlTerminalMaintenancePersistence'
import { SqliteTerminalMaintenancePersistence } from '../infrastructure/sqliteTerminalMaintenancePersistence'
import { DrizzleGateContinuationEffectPersistence } from '../infrastructure/gateContinuationEffectPersistence'
import { PostgresqlTaskExecutionIntentTerminalPersistence } from '../infrastructure/postgresqlTaskExecutionIntentTerminalPersistence'
import { SqliteTaskExecutionIntentTerminalPersistence } from '../infrastructure/sqliteTaskExecutionIntentTerminalPersistence'
import { PostgresqlTaskExecutionRecoveryPersistence } from '../infrastructure/postgresqlTaskExecutionRecovery'
import { SqliteTaskExecutionRecoveryPersistence } from '../infrastructure/sqliteTaskExecutionRecoveryPersistence'
import { PostgresqlHumanGateTaskLifecyclePersistence } from '../infrastructure/postgresqlHumanGateTaskLifecyclePersistence'
import { SqliteHumanGateTaskLifecyclePersistence } from '../infrastructure/sqliteHumanGateTaskLifecyclePersistence'
import { SqliteTaskEngineApplicationPersistence } from '../infrastructure/sqliteTaskEngineApplicationPersistence'
import { PostgresqlTaskEngineApplicationPersistence } from '../infrastructure/postgresqlTaskEngineApplicationPersistence'
import { SqliteGateContinuationPreDrivePersistence } from '../infrastructure/sqliteGateContinuationPreDrivePersistence'
import { PostgresqlGateContinuationPreDrivePersistence } from '../infrastructure/postgresqlGateContinuationPreDrivePersistence'
import { SqliteSchedulerCompletionPersistence } from '../infrastructure/sqliteSchedulerCompletionPersistence'
import { PostgresqlSchedulerCompletionPersistence } from '../infrastructure/postgresqlSchedulerCompletionPersistence'
import { SqliteChildTaskBudgetQueries } from '../infrastructure/sqliteChildTaskBudgetQueries'
import { PostgresqlChildTaskBudgetQueries } from '../infrastructure/postgresqlChildTaskBudgetQueries'
import { SqliteNodeRunLifecyclePersistence } from '../infrastructure/sqliteNodeRunLifecyclePersistence'
import { PostgresqlNodeRunLifecyclePersistence } from '../infrastructure/postgresqlNodeRunLifecyclePersistence'
import { SqliteNodeRunRuntimePersistence } from '../infrastructure/sqliteNodeRunRuntimePersistence'
import { PostgresqlNodeRunRuntimePersistence } from '../infrastructure/postgresqlNodeRunRuntimePersistence'
import { SqliteWrapperRunPersistence } from '../infrastructure/sqliteWrapperRunPersistence'
import { PostgresqlWrapperRunPersistence } from '../infrastructure/postgresqlWrapperRunPersistence'
import { SqliteTaskRuntimeLifecyclePersistence } from '../infrastructure/sqliteTaskRuntimeLifecyclePersistence'
import { PostgresqlTaskRuntimeLifecyclePersistence } from '../infrastructure/postgresqlTaskRuntimeLifecyclePersistence'
import { createSqliteRuntimeSessionCapturePersistence } from '../infrastructure/sqliteRuntimeSessionCapturePersistence'
import { createPostgresqlRuntimeSessionCapturePersistence } from '../infrastructure/postgresqlRuntimeSessionCapturePersistence'
import { SqliteTaskExecutionShutdownOperations } from '../infrastructure/sqliteTaskExecutionShutdownOperations'
import { PostgresqlTaskExecutionShutdownOperations } from '../infrastructure/postgresqlTaskExecutionShutdownOperations'
import { SqliteNodeExecutionPersistence } from '../infrastructure/sqliteNodeExecutionPersistence'
import { PostgresqlNodeExecutionPersistence } from '../infrastructure/postgresqlNodeExecutionPersistence'
import { DrizzleNodeActivationSnapshotReader } from '../infrastructure/nodeActivationSnapshotReader'
import { SqliteMergeStateLifecyclePersistence } from '../infrastructure/sqliteMergeStateLifecyclePersistence'
import { PostgresqlMergeStateLifecyclePersistence } from '../infrastructure/postgresqlMergeStateLifecyclePersistence'
import { DrizzleTaskArtifactPathQueries } from '../infrastructure/taskArtifactPathQueries'
import { createSqliteTaskRecoveryOperations } from '../infrastructure/sqliteTaskRecoveryOperations'
import { createPostgresqlTaskRecoveryOperations } from '../infrastructure/postgresqlTaskRecoveryOperations'
import { createSqliteRuntimeSessionLeaseOperations } from '../infrastructure/sqliteRuntimeSessionLeaseOperations'
import { createPostgresqlRuntimeSessionLeaseOperations } from '../infrastructure/postgresqlRuntimeSessionLeaseOperations'
import type { RuntimeSessionLeaseOperations } from '../application/ports/runtimeSessionLeaseOperations'
import { terminalizeTaskExecutionIntentsTx } from '../infrastructure/sqliteTerminalizeExecutionIntent'
import { trySetTaskStatus } from '@/services/lifecycle'
import { repairRuntimeSessionLeasesAfterOrphanReap } from '@/services/runtimeSessionLease'

function createSqliteRecoveryAdministration(db: DbClient) {
  const nodeLifecycle = new SqliteNodeRunLifecyclePersistence(db)
  const taskLifecycle = new SqliteTaskRuntimeLifecyclePersistence(db)
  const runtimeLeaseOperations = createSqliteRuntimeSessionLeaseOperations(db)
  return createSqliteTaskRecoveryOperations(db, {
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
    drive: new SqliteTaskEngineApplicationPersistence(db),
    ownership: new SqliteTaskOwnershipPersistence(db),
    intents: new SqliteTaskExecutionIntentPersistence(db),
    effects,
    terminalMaintenance: new SqliteTerminalMaintenancePersistence(db),
    gateContinuationEffects: new DrizzleGateContinuationEffectPersistence(db, effects),
    gateContinuationPreDrive: new SqliteGateContinuationPreDrivePersistence(db),
    scheduler: new SqliteSchedulerCompletionPersistence(db),
    childBudget: new SqliteChildTaskBudgetQueries(db),
    nodeRuns: new SqliteNodeRunLifecyclePersistence(db),
    nodeRunRuntime: new SqliteNodeRunRuntimePersistence(db),
    nodeExecution: new SqliteNodeExecutionPersistence(db),
    nodeActivation: new DrizzleNodeActivationSnapshotReader(db),
    mergeStates: new SqliteMergeStateLifecyclePersistence(db),
    artifactPaths: new DrizzleTaskArtifactPathQueries(db),
    wrapperRuns: new SqliteWrapperRunPersistence(db),
    runtimeLifecycle: new SqliteTaskRuntimeLifecyclePersistence(db),
    intentTerminalization: new SqliteTaskExecutionIntentTerminalPersistence(db),
    recovery: new SqliteTaskExecutionRecoveryPersistence(db),
    humanGateDecisions: new DatabaseTaskDecisionPersistence(databaseSessionFor(db)),
    humanGateLifecycle: new SqliteHumanGateTaskLifecyclePersistence(db),
    reads: createSqliteTaskExecutionReadModels(db),
    recoveryAdministration: createSqliteRecoveryAdministration(db),
    shutdown: new SqliteTaskExecutionShutdownOperations(db),
    runtimeSessionCapture: createSqliteRuntimeSessionCapturePersistence(db),
  })
}

export function createPostgresqlTaskExecutionPersistence(
  db: PostgresqlDatabaseClient,
): TaskExecutionPersistence {
  const effects = new PostgresqlTaskExecutionEffectPersistence(db)
  return Object.freeze({
    drive: new PostgresqlTaskEngineApplicationPersistence(db),
    ownership: new PostgresqlTaskOwnershipPersistence(db),
    intents: new PostgresqlTaskExecutionIntentPersistence(db),
    effects,
    terminalMaintenance: new PostgresqlTerminalMaintenancePersistence(db),
    gateContinuationEffects: new DrizzleGateContinuationEffectPersistence(db, effects),
    gateContinuationPreDrive: new PostgresqlGateContinuationPreDrivePersistence(db),
    scheduler: new PostgresqlSchedulerCompletionPersistence(db),
    childBudget: new PostgresqlChildTaskBudgetQueries(db),
    nodeRuns: new PostgresqlNodeRunLifecyclePersistence(db),
    nodeRunRuntime: new PostgresqlNodeRunRuntimePersistence(db),
    nodeExecution: new PostgresqlNodeExecutionPersistence(db),
    nodeActivation: new DrizzleNodeActivationSnapshotReader(db),
    mergeStates: new PostgresqlMergeStateLifecyclePersistence(db),
    artifactPaths: new DrizzleTaskArtifactPathQueries(db),
    wrapperRuns: new PostgresqlWrapperRunPersistence(db),
    runtimeLifecycle: new PostgresqlTaskRuntimeLifecyclePersistence(db),
    intentTerminalization: new PostgresqlTaskExecutionIntentTerminalPersistence(db),
    recovery: new PostgresqlTaskExecutionRecoveryPersistence(db),
    humanGateDecisions: new DatabaseTaskDecisionPersistence(databaseSessionFor(db)),
    humanGateLifecycle: new PostgresqlHumanGateTaskLifecyclePersistence(db),
    reads: createPostgresqlTaskExecutionReadModels(db),
    recoveryAdministration: createPostgresqlTaskRecoveryOperations(db),
    shutdown: new PostgresqlTaskExecutionShutdownOperations(db),
    runtimeSessionCapture: createPostgresqlRuntimeSessionCapturePersistence(db),
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
