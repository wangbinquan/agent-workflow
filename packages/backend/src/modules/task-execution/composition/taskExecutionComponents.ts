import type { LegacyTaskMechanicsState } from '@/services/execution/taskMechanicsState'
import type { Logger } from '@/util/log'
import type { WrapperNodeExecutionPort } from '../application/ports/wrapperNodeExecution'
import type { ExecutionMergeRecovery } from '../application/recovery/executionMergeRecovery'

export type WrapperRuntimeFactory = (state: LegacyTaskMechanicsState) => WrapperNodeExecutionPort

export type ExecutionMergeRecoveryFactory = (
  state: LegacyTaskMechanicsState,
  log: Logger,
) => ExecutionMergeRecovery

export interface TaskExecutionRuntimeComponents {
  readonly wrapperRuntimeFactory: WrapperRuntimeFactory
  readonly mergeRecoveryFactory: ExecutionMergeRecoveryFactory
}
