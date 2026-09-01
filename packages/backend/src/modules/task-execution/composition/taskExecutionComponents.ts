import type { TaskMechanicsState } from '@/services/execution/taskMechanicsState'
import type { Logger } from '@/util/log'
import type { WrapperNodeExecutionPort } from '../application/ports/wrapperNodeExecution'
import type { ExecutionMergeRecovery } from '../application/recovery/executionMergeRecovery'

export type WrapperRuntimeFactory = (state: TaskMechanicsState) => WrapperNodeExecutionPort

export type ExecutionMergeRecoveryFactory = (
  state: TaskMechanicsState,
  log: Logger,
) => ExecutionMergeRecovery

export interface TaskExecutionRuntimeComponents {
  readonly wrapperRuntimeFactory: WrapperRuntimeFactory
  readonly mergeRecoveryFactory: ExecutionMergeRecoveryFactory
}
