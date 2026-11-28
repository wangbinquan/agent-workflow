import type { TaskSettler } from '@/platform/persistence/migration/conversion/rule'
import type { EncodedKey } from '@/platform/persistence/migration/conversion/types'
import type { DecodedSourceRow } from '@/platform/persistence/migration/sourceTypes'
import { nextRevision, settlementStop } from './stop'

/** The intents a terminal cancel closes (`taskExecutionIntentTerminalSequence.ts:20-36`). */
const ACTIVE_INTENT_STATES: ReadonlySet<string> = new Set(['pending', 'claimed'])

/**
 * RFC-626 §3.2.3 row 3 (`taskExecutionIntentTerminalSequence.ts:37-51`): an active intent of
 * the task is canceled with the stop reason code, completed and updated now.
 */
export function settleIntentValues(
  values: DecodedSourceRow,
  input: { readonly code: string; readonly planTime: number },
): DecodedSourceRow | null {
  if (typeof values.state !== 'string' || !ACTIVE_INTENT_STATES.has(values.state)) return null
  return {
    ...values,
    state: 'canceled',
    failure_code: input.code,
    completed_at: input.planTime,
    updated_at: input.planTime,
  }
}

/**
 * RFC-626 §3.2.3 row 5 (`taskExecutionIntentTerminalSequence.ts:62-98`): a replay decision an
 * actor authorized for one of the intents row 3 closed goes back to requiring an actor, with
 * its authorization and binding cleared and its revision one step on.
 */
export function releaseReplayDecisionValues(
  values: DecodedSourceRow,
  input: { readonly closedIntentIds: ReadonlySet<string>; readonly planTime: number },
): DecodedSourceRow | null {
  if (
    values.record_kind !== 'replay-decision' ||
    values.decision_state !== 'actor-replay-authorized' ||
    typeof values.bound_intent_id !== 'string' ||
    !input.closedIntentIds.has(values.bound_intent_id)
  )
    return null
  const revision = nextRevision(values.record_revision)
  if (revision === null) return null
  return {
    ...values,
    decision_state: 'requires-actor',
    replay_authorization_id: null,
    authorization_scope_json: null,
    actor_user_id: null,
    authorization_source: null,
    bound_intent_id: null,
    record_revision: revision,
    updated_at: input.planTime,
  }
}

/**
 * Rows 3 and 5 in one settler: the decisions to release are the ones bound to the intents this
 * settlement closes. Lineage records carry no column with that task's id, so the engine finds
 * them through the task's intents (`bound_intent_id` → `task_execution_intents.id`) — the same
 * selection the cancel uses (`taskExecutionIntentTerminalSequence.ts:62-98`).
 */
export const executionIntentSettler: TaskSettler = {
  tables: [
    { table: 'task_execution_intents', taskColumn: 'task_id' },
    {
      table: 'task_execution_lineage_operation_records',
      taskColumn: 'bound_intent_id',
      via: { table: 'task_execution_intents', keyColumn: 'id' },
    },
  ],
  settle(rows, { settlement, planTime }) {
    const code = settlementStop(settlement).code
    const changes: { table: string; key: EncodedKey; values: DecodedSourceRow }[] = []
    const closed = new Set<string>()
    for (const row of rows.get('task_execution_intents') ?? []) {
      if (row.codecFailure) continue
      const values = settleIntentValues(row.values, { code, planTime })
      if (!values) continue
      if (typeof row.values.id === 'string') closed.add(row.values.id)
      changes.push({ table: 'task_execution_intents', key: row.encodedKey, values })
    }
    for (const row of rows.get('task_execution_lineage_operation_records') ?? []) {
      if (row.codecFailure) continue
      const values = releaseReplayDecisionValues(row.values, { closedIntentIds: closed, planTime })
      if (values)
        changes.push({
          table: 'task_execution_lineage_operation_records',
          key: row.encodedKey,
          values,
        })
    }
    return changes
  },
}
