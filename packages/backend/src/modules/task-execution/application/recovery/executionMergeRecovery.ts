/** Pre-drive recovery finishes durable merge work before any frontier is derived. */
export interface ExecutionMergeRecovery {
  recoverBeforeScope(): Promise<void>
}
