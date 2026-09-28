import { createUsageIngestion } from './usageIngestion'
import type { UsageLedgerStore } from '../ports/usageLedger'
import type { ObservationInvocationStore } from '../ports/invocations'
import type { ObservationUsageSource } from '../public/participants'

const cursorId = (cursor: string | null) => {
  if (cursor === null) return 0
  if (!/^node-event:[1-9]\d*$/.test(cursor)) throw new Error('Invalid local observation cursor')
  const id = Number(cursor.slice('node-event:'.length))
  if (!Number.isSafeInteger(id)) throw new Error('Invalid local observation cursor')
  return id
}

/** The owner's per-node write lock establishes committed ID order. Acks follow ledger commit. */
export function createUsageSourceProjection(input: {
  readonly source: ObservationUsageSource
  readonly store: UsageLedgerStore
  readonly invocations: ObservationInvocationStore
}) {
  const ingest = createUsageIngestion(input.store)
  let afterNodeRunId: string | undefined
  let active: Promise<number> | null = null
  const project = async (nodeRunId?: string) => {
    const rows = await input.source.pending({
      limit: 100,
      ...(nodeRunId ? { nodeRunId } : {}),
      ...(nodeRunId === undefined && afterNodeRunId !== undefined ? { afterNodeRunId } : {}),
    })
    if (nodeRunId === undefined && rows.length) afterNodeRunId = rows[0]!.nodeRunId
    const blocked = new Set<string>(),
      errors: unknown[] = []
    let count = 0
    for (const row of rows) {
      if (blocked.has(row.nodeRunId)) continue
      try {
        const accepted = await input.invocations.get(row.evidence.invocationId)
        if (!accepted || accepted.taskId !== row.taskId || accepted.nodeRunId !== row.nodeRunId)
          throw new Error('Observation source does not match accepted invocation')
        // Platform observations have a separate canonical source. Never ingest local duplicates.
        if (accepted.authority.kind === 'local' && row.evidence.measurements.length) {
          for (const m of row.evidence.measurements)
            if (
              m.invocationId !== accepted.invocationId ||
              m.taskId !== row.taskId ||
              m.nodeRunId !== row.nodeRunId ||
              m.agentId !== accepted.agentId
            )
              throw new Error('Observation measurement does not match accepted invocation')
          const sourceId = 'local-node:' + row.nodeRunId
          const cursor = await ingest.cursor(sourceId)
          if (cursorId(cursor) < row.id)
            await ingest.ingest({
              sourceId,
              expectedCursor: cursor,
              nextCursor: 'node-event:' + row.id,
              events: row.evidence.measurements.map((measurement, index) => ({
                eventId: `${row.id}:${index}`,
                measurement,
              })),
            })
        }
        await input.source.acknowledge([row.id])
        count++
      } catch (error) {
        blocked.add(row.nodeRunId)
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Observation projection remains pending')
    return count
  }
  return (nodeRunId?: string): Promise<number> => {
    // Coalesce chunk notifications with the provider background sweep. Remaining rows stay pending.
    if (active) return active
    const next = project(nodeRunId).finally(() => {
      if (active === next) active = null
    })
    active = next
    return next
  }
}
