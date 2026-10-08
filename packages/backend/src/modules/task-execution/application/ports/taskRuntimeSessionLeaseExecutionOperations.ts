import type { RuntimeSessionLeaseOperations } from './runtimeSessionLeaseOperations'

/** Task execution uses the original lease atom without recovery administration. */
export type TaskRuntimeSessionLeaseExecutionOperations = Pick<
  RuntimeSessionLeaseOperations,
  | 'load'
  | 'claimNew'
  | 'preclaimResume'
  | 'confirmResume'
  | 'rotate'
  | 'markResetPending'
  | 'discard'
  | 'release'
>
