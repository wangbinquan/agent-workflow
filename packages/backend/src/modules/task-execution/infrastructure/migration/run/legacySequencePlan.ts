// RFC-374: pure planning for legacy rows; persistence owns the transaction and allocation.
export interface NodeRunSeqBackfillSummary {
  readonly minSeq: number | null
  readonly maxId: string | null
}

export type NodeRunSeqBackfillPlan =
  | { readonly kind: 'initial' }
  | {
      readonly kind: 'mixed'
      readonly older: readonly { id: string; seq: number }[]
      readonly newer: readonly string[]
    }

export function planNodeRunSeqBackfill(
  existing: NodeRunSeqBackfillSummary,
  missingIds: readonly string[],
): NodeRunSeqBackfillPlan {
  if (existing.minSeq === null || existing.maxId === null) return { kind: 'initial' }
  const ids = [...missingIds].sort()
  const older = ids.filter((id) => id <= existing.maxId!)
  return {
    kind: 'mixed',
    older: older.map((id, index) => ({ id, seq: existing.minSeq! - older.length + index })),
    newer: ids.filter((id) => id > existing.maxId!),
  }
}
