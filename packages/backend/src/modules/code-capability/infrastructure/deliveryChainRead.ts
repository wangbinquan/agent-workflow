import type { CodeHistoryReader } from '../application/ports/historyReader'
import type { DeliveryChainReadPort, DeliveryRow } from '../application/ports/deliveryChainRead'
import type { DeliveryOutcome, DeliveryStep } from '../domain/deliveryChain'
import type { CodeHistoryQueryRow } from '../domain/codeHistoryPackage'

function toRow(row: CodeHistoryQueryRow<'code_trigger_deliveries'>): DeliveryRow {
  return {
    id: row.id,
    correlationId: row.correlation_id,
    capability: row.capability,
    step: row.step as DeliveryStep,
    outcome: row.outcome as DeliveryOutcome['kind'],
    reason: row.reason,
    queuedAt: row.queued_at,
    queuePosition: row.queue_position,
    waitingOn: row.waiting_on,
    roundId: row.round_id,
    isProbe: row.is_probe,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
export function createDeliveryChainRead(history: CodeHistoryReader): DeliveryChainReadPort {
  const rows = async () =>
    [...(await history.rows('code_trigger_deliveries'))].sort((a, b) => b.created_at - a.created_at)
  const bounded = (
    values: readonly CodeHistoryQueryRow<'code_trigger_deliveries'>[],
    limit = 50,
  ) => {
    // Drizzle omitted a negative/NaN limit; non-integer SQL limits failed rather than truncating.
    if (!(limit >= 0)) return values.map(toRow)
    if (!Number.isInteger(limit)) throw new RangeError('code-history-limit-not-integer')
    return values.slice(0, limit).map(toRow)
  }
  return {
    async recent(input) {
      return bounded(
        (await rows()).filter((row) => row.stable_project_id === input.stableProjectId),
        input.limit,
      )
    },
    async byCorrelation(correlationId) {
      return (await rows()).filter((row) => row.correlation_id === correlationId).map(toRow)
    },
    async failures(input) {
      return bounded(
        (await rows()).filter(
          (row) =>
            row.outcome === 'failed' &&
            (input.stableProjectId === undefined ||
              row.stable_project_id === input.stableProjectId),
        ),
        input.limit,
      )
    },
  }
}
