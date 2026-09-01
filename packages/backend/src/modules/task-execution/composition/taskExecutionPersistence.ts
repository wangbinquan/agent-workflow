import type { DbClient } from '@/db/client'
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
import { PostgresqlGateContinuationEffectPersistence } from '../infrastructure/postgresqlGateContinuationEffectPersistence'
import { SqliteGateContinuationEffectPersistence } from '../infrastructure/sqliteGateContinuationEffectPersistence'
import { PostgresqlTaskExecutionIntentTerminalPersistence } from '../infrastructure/postgresqlTaskExecutionIntentTerminalPersistence'
import { SqliteTaskExecutionIntentTerminalPersistence } from '../infrastructure/sqliteTaskExecutionIntentTerminalPersistence'
import { PostgresqlTaskExecutionRecoveryPersistence } from '../infrastructure/postgresqlTaskExecutionRecovery'
import { SqliteTaskExecutionRecoveryPersistence } from '../infrastructure/sqliteTaskExecutionRecoveryPersistence'
import { PostgresqlTaskDecisionPersistence } from '../infrastructure/postgresqlTaskDecisionPersistence'
import { SqliteTaskDecisionPersistence } from '../infrastructure/sqliteTaskDecisionPersistence'
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
import { SqliteNodeActivationSnapshotReader } from '../infrastructure/sqliteNodeActivationSnapshotReader'
import { PostgresqlNodeActivationSnapshotReader } from '../infrastructure/postgresqlNodeActivationSnapshotReader'
import { SqliteMergeStateLifecyclePersistence } from '../infrastructure/sqliteMergeStateLifecyclePersistence'
import { PostgresqlMergeStateLifecyclePersistence } from '../infrastructure/postgresqlMergeStateLifecyclePersistence'
import { SqliteTaskArtifactPathQueries } from '../infrastructure/sqliteTaskArtifactPathQueries'
import { PostgresqlTaskArtifactPathQueries } from '../infrastructure/postgresqlTaskArtifactPathQueries'
import { createSqliteTaskRecoveryOperations } from '../infrastructure/sqliteTaskRecoveryOperations'
import { createPostgresqlTaskRecoveryOperations } from '../infrastructure/postgresqlTaskRecoveryOperations'
import { createSqliteRuntimeSessionLeaseOperations } from '../infrastructure/sqliteRuntimeSessionLeaseOperations'
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
    gateContinuationEffects: new SqliteGateContinuationEffectPersistence(db, effects),
    gateContinuationPreDrive: new SqliteGateContinuationPreDrivePersistence(db),
    scheduler: new SqliteSchedulerCompletionPersistence(db),
    childBudget: new SqliteChildTaskBudgetQueries(db),
    nodeRuns: new SqliteNodeRunLifecyclePersistence(db),
    nodeRunRuntime: new SqliteNodeRunRuntimePersistence(db),
    nodeExecution: new SqliteNodeExecutionPersistence(db),
    nodeActivation: new SqliteNodeActivationSnapshotReader(db),
    mergeStates: new SqliteMergeStateLifecyclePersistence(db),
    artifactPaths: new SqliteTaskArtifactPathQueries(db),
    wrapperRuns: new SqliteWrapperRunPersistence(db),
    runtimeLifecycle: new SqliteTaskRuntimeLifecyclePersistence(db),
    intentTerminalization: new SqliteTaskExecutionIntentTerminalPersistence(db),
    recovery: new SqliteTaskExecutionRecoveryPersistence(db),
    humanGateDecisions: new SqliteTaskDecisionPersistence(db),
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
    gateContinuationEffects: new PostgresqlGateContinuationEffectPersistence(db, effects),
    gateContinuationPreDrive: new PostgresqlGateContinuationPreDrivePersistence(db),
    scheduler: new PostgresqlSchedulerCompletionPersistence(db),
    childBudget: new PostgresqlChildTaskBudgetQueries(db),
    nodeRuns: new PostgresqlNodeRunLifecyclePersistence(db),
    nodeRunRuntime: new PostgresqlNodeRunRuntimePersistence(db),
    nodeExecution: new PostgresqlNodeExecutionPersistence(db),
    nodeActivation: new PostgresqlNodeActivationSnapshotReader(db),
    mergeStates: new PostgresqlMergeStateLifecyclePersistence(db),
    artifactPaths: new PostgresqlTaskArtifactPathQueries(db),
    wrapperRuns: new PostgresqlWrapperRunPersistence(db),
    runtimeLifecycle: new PostgresqlTaskRuntimeLifecyclePersistence(db),
    intentTerminalization: new PostgresqlTaskExecutionIntentTerminalPersistence(db),
    recovery: new PostgresqlTaskExecutionRecoveryPersistence(db),
    humanGateDecisions: new PostgresqlTaskDecisionPersistence(db),
    humanGateLifecycle: new PostgresqlHumanGateTaskLifecyclePersistence(db),
    reads: createPostgresqlTaskExecutionReadModels(db),
    recoveryAdministration: createPostgresqlTaskRecoveryOperations(db),
    shutdown: new PostgresqlTaskExecutionShutdownOperations(db),
    runtimeSessionCapture: createPostgresqlRuntimeSessionCapturePersistence(db),
  })
}
