import { allowedFromStatusesForEvent } from '@agent-workflow/shared'
import type { TaskSettler } from '@/platform/persistence/migration/conversion/rule'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import type { DecodedSourceRow } from '@/platform/persistence/migration/sourceTypes'
import { settlementStop } from './stop'

/** The runs a cancel ends: `mark-canceled`'s allowed-from, as the cancel transaction selects them. */
const CANCELED_BY_CANCEL: ReadonlySet<string> = new Set<string>(
  allowedFromStatusesForEvent({ kind: 'mark-canceled' }),
)
/**
 * The cause the human-gate terminal sweep stamps on the intermediary run of an open clarify
 * round once its task is canceled: the sweep runs with `task-${status}` of the task's terminal
 * status (`bootstrap/daemonSession.ts:427`), and a settled task is canceled.
 */
export const GATE_SWEEP_CANCELED_CAUSE = 'task-canceled'

/**
 * RFC-626 §3.2.3 rows 2a and 2b.
 *
 * 2a — the cancel transaction cancels every run still pending, running or parked, finished now
 * with the stop reason code (`childTaskLifecycleParticipant.ts:888-898`).
 * 2b — the gate sweep that follows finds each clarify round still awaiting a person and stamps its
 * intermediary run with the sweep cause. That run is canceled by then, either just now by 2a or
 * earlier, so only the reason changes (`humanGatePersistenceParticipant.ts:31-51`); a run in any
 * other state is left as it is. The clarify page reads that reason to say why the round closed.
 */
export function settleNodeRunValues(
  values: DecodedSourceRow,
  input: {
    readonly code: string
    readonly planTime: number
    readonly openRoundIntermediary: boolean
  },
): DecodedSourceRow | null {
  let next = values
  if (typeof values.status === 'string' && CANCELED_BY_CANCEL.has(values.status))
    next = { ...next, status: 'canceled', finished_at: input.planTime, error_message: input.code }
  if (input.openRoundIntermediary && next.status === 'canceled')
    next = { ...next, error_message: GATE_SWEEP_CANCELED_CAUSE }
  return next === values ? null : next
}

/** Intermediary runs of the clarify rounds that still await a person, before any rewrite. */
export function openRoundIntermediaries(rounds: readonly SourceRow[]): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const round of rounds)
    if (
      !round.codecFailure &&
      round.values.status === 'awaiting_human' &&
      typeof round.values.intermediary_node_run_id === 'string'
    )
      ids.add(round.values.intermediary_node_run_id)
  return ids
}

export const nodeRunSettler: TaskSettler = {
  tables: [
    { table: 'node_runs', taskColumn: 'task_id' },
    // Read only: the rounds are the collaboration module's to rewrite, and every settler sees
    // them as they were, so 2b still finds the rounds that were awaiting a person.
    { table: 'clarify_rounds', taskColumn: 'task_id', write: false },
  ],
  settle(rows, { settlement, planTime }) {
    const code = settlementStop(settlement).code
    const intermediaries = openRoundIntermediaries(rows.get('clarify_rounds') ?? [])
    return (rows.get('node_runs') ?? []).flatMap((row) => {
      if (row.codecFailure) return []
      const values = settleNodeRunValues(row.values, {
        code,
        planTime,
        openRoundIntermediary:
          typeof row.values.id === 'string' && intermediaries.has(row.values.id),
      })
      return values ? [{ table: 'node_runs', key: row.encodedKey, values }] : []
    })
  },
}
