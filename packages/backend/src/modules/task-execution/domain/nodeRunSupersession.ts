import type { MergeStateOrNull } from '@agent-workflow/shared'

/** 今天铸造 UPDATE 的 `inArray(mergeState, ABANDONABLE)`；去掉了不属于 `MERGE_STATES` 的死值。 */
export const SUPERSEDABLE_MERGE_STATES = ['isolating', 'pending-merge', 'conflict-human'] as const

export function isSupersedableMergeState(state: MergeStateOrNull): boolean {
  return state !== null && (SUPERSEDABLE_MERGE_STATES as readonly string[]).includes(state)
}
