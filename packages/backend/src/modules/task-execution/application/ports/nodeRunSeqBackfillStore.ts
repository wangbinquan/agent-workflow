// RFC-374: boot recovery's provider-neutral, resumable sequence backfill boundary.
export interface NodeRunSeqBackfillStore {
  listTaskIds(limit: number): Promise<readonly string[]>
  backfillTask(taskId: string): Promise<number>
  assertAllocatorCurrent(): Promise<void>
  pruneAllocations(): Promise<number>
}

export interface NodeRunSeqBackfillReport {
  readonly tasks: number
  readonly runs: number
  readonly allocationsPruned: number
}
