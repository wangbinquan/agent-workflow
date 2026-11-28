import type { TaskSettler } from '@/platform/persistence/migration/conversion/rule'
import type { DecodedSourceRow } from '@/platform/persistence/migration/sourceTypes'
import { nextRevision } from './stop'

/** The recovery code a cancel revokes a claimed owner with (`childTaskLifecycleParticipant.ts:831`). */
export const CANCEL_OWNER_RECOVERY_CODE = 'terminal-control-cancel'

/**
 * RFC-626 §3.2.3 row 4 (`childTaskLifecycleParticipant.ts:821-843`): a claimed execution owner
 * of the task is revoked, its revision one step on, with the cancel's recovery code.
 */
export function revokeOwnerValues(
  values: DecodedSourceRow,
  planTime: number,
): DecodedSourceRow | null {
  if (values.state !== 'claimed') return null
  const revision = nextRevision(values.revision)
  if (revision === null) return null
  return {
    ...values,
    state: 'revoked',
    revision,
    recovery_code: CANCEL_OWNER_RECOVERY_CODE,
    updated_at: planTime,
  }
}

export const executionOwnerSettler: TaskSettler = {
  tables: [{ table: 'task_execution_owners', taskColumn: 'task_id' }],
  settle(rows, { planTime }) {
    return (rows.get('task_execution_owners') ?? []).flatMap((row) => {
      if (row.codecFailure) return []
      const values = revokeOwnerValues(row.values, planTime)
      return values ? [{ table: 'task_execution_owners', key: row.encodedKey, values }] : []
    })
  },
}
