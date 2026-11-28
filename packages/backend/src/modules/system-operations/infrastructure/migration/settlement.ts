import type { TaskSettler } from '@/platform/persistence/migration/conversion/rule'
import type { EncodedKey, SourceRow } from '@/platform/persistence/migration/conversion/types'
import type { DecodedSourceRow } from '@/platform/persistence/migration/sourceTypes'

/**
 * RFC-626 §3.2.3 row 7: an upgrade that ends tasks resolves their open stuck-task alerts at the
 * upgrade time. A real cancel leaves them open (the stuck check only resolves alerts of the
 * four cancelable statuses), which would leave every ended task in the "needs attention" list
 * for good. Resolved alerts, and rows the frozen codec could not decode, stay as they are.
 */
export function resolveOpenLifecycleAlerts(
  alerts: readonly SourceRow[],
  planTime: number,
): readonly {
  readonly table: string
  readonly key: EncodedKey
  readonly values: DecodedSourceRow
}[] {
  return alerts.flatMap((alert) =>
    alert.codecFailure || alert.values.resolved_at !== null
      ? []
      : [
          {
            table: 'lifecycle_alerts',
            key: alert.encodedKey,
            values: { ...alert.values, resolved_at: planTime },
          },
        ],
  )
}

export const lifecycleAlertSettler: TaskSettler = {
  tables: [{ table: 'lifecycle_alerts', taskColumn: 'task_id' }],
  settle: (rows, ctx) =>
    resolveOpenLifecycleAlerts(rows.get('lifecycle_alerts') ?? [], ctx.planTime),
}
