import type { TaskExecutionRecoveryPersistence } from '../recoverTaskExecutions'
import type { RuntimeSessionLeaseOperations } from './runtimeSessionLeaseOperations'
import type { TaskRecoveryOperations } from './taskRecoveryOperations'

/** Resource recovery belongs to the original host grant, without an admitted Task. */
export interface TaskResourceRecoveryGrant {
  readonly generation: string
  readonly reference: object
}

export type TaskBootOrphanOperations = Pick<
  TaskRecoveryOperations,
  'loadBootOrphanSnapshot' | 'interruptBootOrphanTask' | 'interruptNodeRun' | 'recordEvent'
>

export type TaskPeriodicRecoveryOperations = Pick<
  TaskRecoveryOperations,
  | 'listPeriodicReconcileCandidates'
  | 'loadPeriodicReconcileSnapshot'
  | 'findHeldRuntimeSessionId'
  | 'interruptNodeRun'
  | 'repairRuntimeSessionLeaseAfterOrphanReap'
  | 'interruptPeriodicTaskIfIdle'
  | 'recordEvent'
>

export type TaskRuntimeSessionLeaseRepairOperations = Pick<
  RuntimeSessionLeaseOperations,
  'repairAfterOrphanReap'
>

export interface TaskBootRecoveryWrites {
  readonly recovery: TaskExecutionRecoveryPersistence
  readonly operations: TaskBootOrphanOperations
  readonly runtimeSessionLeases: TaskRuntimeSessionLeaseRepairOperations
}

export interface TaskRecoveryWritePurposes {
  boot(grant: TaskResourceRecoveryGrant): TaskBootRecoveryWrites
  periodic(grant: TaskResourceRecoveryGrant): TaskPeriodicRecoveryOperations
}

export interface TaskRecoveryWriteSelection {
  readonly recoveryWriteMode?: 'host-selected'
  readonly recoveryWritePurposes?: TaskRecoveryWritePurposes
}
