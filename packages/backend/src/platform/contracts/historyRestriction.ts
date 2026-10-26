// RFC-395 II-b W0: system-operations implements; A injects; N and C consume. Dormant.
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import type { EncodedKey } from '@/platform/persistence/migration/conversion/types'
import type { PersistedHistoryRestriction } from '@/platform/persistence/migration/run/types'

/** Exact V3 switch record: outer runId is the migration run; history.runId is
 * the NodeRun (or null). Keep executionUse/reason on the executable/unused arm.
 * Type-only reuse introduces neither a module dependency nor a migration runtime.
 */
export type HistoryRestrictionRecord = PersistedHistoryRestriction
export type HistoryRestrictionGate = {
  readonly sourceTable: 'clarify_rounds' | 'collaboration_gate_operations'
  readonly sourceKey: EncodedKey
}

export type HistoryRestrictionRequest = {
  readonly taskId: string
  /** Actual execution dependencies, including runs supplying recovery/checkpoints.
   * Do not include unrelated unselected history just because it belongs to the task.
   */
  readonly nodeRunIds: readonly string[]
} & (
  | { readonly action: 'resume' | 'retry'; readonly gates: readonly HistoryRestrictionGate[] }
  | {
      readonly action: 'replay'
      readonly gates: readonly [HistoryRestrictionGate, ...HistoryRestrictionGate[]]
    }
)

export type HistoryRestrictionDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false
      readonly code: 'history-only'
      readonly restrictions: readonly [HistoryRestrictionRecord, ...HistoryRestrictionRecord[]]
    }

/** Records have already been matched by the provider to the active target generation,
 * task and requested dependencies. Even execution='executable' here means that this
 * particular historical row is unusable (executionUse='none'), not permission to run.
 */
export function historyRestrictionDecision(
  restrictions: readonly HistoryRestrictionRecord[],
): HistoryRestrictionDecision {
  const [first, ...rest] = restrictions
  return first === undefined
    ? { allowed: true }
    : { allowed: false, code: 'history-only', restrictions: [first, ...rest] }
}

export interface HistoryRestrictionPort {
  /** Read migration_history_restrictions in the caller's transaction. The provider
   * binds the active generation's migration run; callers never choose a migration run.
   * Include task-wide restrictions and matching NodeRun/gate evidence, distinguishing
   * task-wide records from unrelated gate records whose history.runId is also null.
   * N/C refuse a false decision before writes or effects; history reads stay available.
   * A read failure propagates rather than becoming an empty restriction list.
   */
  check(tx: PersistenceTx, request: HistoryRestrictionRequest): Promise<HistoryRestrictionDecision>
}
