import { ObservationIngestSchema, type ObservationIngest } from '@agent-workflow/shared'
import { ObservationIngestError } from '../domain/ingestError'
import { reconcileUsage, type UsageDecision, type UsageLedgerRecord } from '../domain/usageLedger'
import type { UsageLedgerScope, UsageLedgerStore } from '../ports/usageLedger'

/** Late evidence is folded in revision order, including invalid/partial successors. */
async function rebuild(
  sourceId: string,
  input: ObservationIngest['events'][number]['measurement'],
  scope: UsageLedgerScope,
): Promise<UsageDecision> {
  let current: UsageLedgerRecord | undefined,
    inserted = false,
    after = 0
  while (true) {
    const page = await scope.revisions(input.invocationId, input.recordId, after, 200)
    for (const prior of page) {
      if (!inserted && input.revision < prior.revision) {
        current = reconcileUsage(sourceId, input, current).record
        inserted = true
      }
      current = reconcileUsage(sourceId, prior, current).record
      after = prior.revision
    }
    if (page.length < 200) break
  }
  if (!inserted) current = reconcileUsage(sourceId, input, current).record
  return { outcome: current!.issues.length ? 'diagnostic' : 'applied', record: current! }
}

async function appendEvent(
  sourceId: string,
  event: ObservationIngest['events'][number],
  scope: UsageLedgerScope,
): Promise<'applied' | 'diagnostic' | 'stale' | 'duplicate'> {
  const fingerprint = JSON.stringify(event.measurement)
  const priorEvent = await scope.event(event.eventId)
  if (priorEvent !== undefined) {
    if (priorEvent !== fingerprint)
      throw new ObservationIngestError('event-conflict', 'Source event content changed')
    return 'duplicate'
  }
  const input = event.measurement
  const priorRevision = await scope.revision(input.invocationId, input.recordId, input.revision)
  if (priorRevision !== undefined && priorRevision !== fingerprint)
    throw new ObservationIngestError('revision-conflict', 'Measurement revision content changed')
  const current = await scope.current(input.invocationId, input.recordId)
  const decision =
    priorRevision === undefined && current && input.revision < current.observedRevision
      ? await rebuild(sourceId, input, scope)
      : reconcileUsage(sourceId, input, current)
  await scope.append(
    event,
    { fingerprint, outcome: decision.outcome },
    decision.outcome === 'stale' ? undefined : decision.record,
  )
  return priorRevision === undefined ? decision.outcome : 'duplicate'
}

/** The source watermark and every accepted revision share one commit. */
export function createUsageIngestion(store: UsageLedgerStore) {
  return {
    cursor: (sourceId: string) => store.cursor(sourceId),
    async ingest(raw: ObservationIngest) {
      const parsed = ObservationIngestSchema.safeParse(raw)
      if (!parsed.success)
        throw new ObservationIngestError('invalid-batch', 'Observation source page is invalid')
      const input = parsed.data
      if (input.nextCursor === input.expectedCursor)
        throw new ObservationIngestError('invalid-batch', 'Source page did not advance')
      return store.change(input.sourceId, async (scope) => {
        const cursor = await scope.cursor()
        if (cursor !== input.expectedCursor && cursor !== input.nextCursor)
          throw new ObservationIngestError('cursor-conflict', 'Observation source cursor changed')
        const result = { applied: 0, diagnostic: 0, stale: 0, duplicate: 0 }
        for (const event of input.events) result[await appendEvent(input.sourceId, event, scope)]++
        if (cursor === input.nextCursor && result.duplicate !== input.events.length)
          throw new ObservationIngestError('cursor-conflict', 'Replayed page changed its event set')
        await scope.advance(input.nextCursor)
        return { cursor: input.nextCursor, ...result }
      })
    },
  }
}
