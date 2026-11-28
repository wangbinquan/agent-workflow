import type { TaskSettler } from '@/platform/persistence/migration/conversion/rule'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import type { DecodedSourceRow } from '@/platform/persistence/migration/sourceTypes'
import type { TaskStopProjection } from '../../../domain/sourceTermination'
import { taskExecutionOf } from '../task/usability'
import { settlementStop } from './stop'

/**
 * RFC-626 §3.2.3 row 1, the task row of a cancel (`childTaskLifecycleParticipant.ts:858-884`):
 * canceled, finished now, with the stop reason. `lifecycle_event_revision` is left alone — the
 * upgrade appends no lifecycle event (§3.2.3), so the revision stays consistent with the event
 * stream. An `interrupted` task, which the product cannot cancel, receives the same writes.
 */
export function settleTaskValues(
  row: SourceRow,
  stop: TaskStopProjection,
  planTime: number,
): DecodedSourceRow | null {
  if (row.codecFailure || taskExecutionOf(row.values.status) !== 'executable') return null
  return {
    ...row.values,
    status: 'canceled',
    finished_at: planTime,
    error_summary: stop.summary,
    error_message: stop.code,
  }
}

export const taskRowSettler: TaskSettler = {
  tables: [{ table: 'tasks', taskColumn: 'id' }],
  settle(rows, { settlement, planTime }) {
    const stop = settlementStop(settlement)
    return (rows.get('tasks') ?? []).flatMap((row) => {
      const values = settleTaskValues(row, stop, planTime)
      return values ? [{ table: 'tasks', key: row.encodedKey, values }] : []
    })
  },
}
