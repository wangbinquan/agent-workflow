import { ObservationIngestSchema, type ObservationIngest } from '@agent-workflow/shared'
import { ObservationIngestError } from '../domain/ingestError'
import { reconcileUsage, type UsageDecision, type UsageLedgerRecord } from '../domain/usageLedger'
import type { UsageLedgerScope, UsageLedgerStore } from '../ports/usageLedger'
import type { UsageCaptureReceipt } from '../ports/usageLedger'
import { reconcileNativeUsageRevisions } from './nativeUsageRevisions'
import { isNativeUsageScope } from '../domain/nativeUsageScope'
import type {
  ObservationNativeScopeSource,
  ObservationNativeHistorySource,
} from '../public/participants'
import { repairNativeUsageHistory } from './nativeUsageHistory'

async function fold(
  sourceId: string,
  measurement: ObservationIngest['events'][number]['measurement'],
  current: UsageLedgerRecord | undefined,
  nativeScopes?: ObservationNativeScopeSource,
) {
  const nativeScopeFacts = isNativeUsageScope(measurement.scope)
    ? await nativeScopes?.resolve(measurement, measurement.scope)
    : undefined
  if (isNativeUsageScope(measurement.scope) && nativeScopeFacts === undefined)
    throw new ObservationIngestError(
      'invalid-batch',
      'Original native ancestry source is not installed',
    )
  return reconcileUsage(sourceId, measurement, current, nativeScopeFacts)
}

/** Late evidence is folded in revision order, including invalid/partial successors. */
async function rebuild(
  sourceId: string,
  input: ObservationIngest['events'][number]['measurement'],
  scope: UsageLedgerScope,
  nativeScopes?: ObservationNativeScopeSource,
): Promise<UsageDecision> {
  let current: UsageLedgerRecord | undefined,
    inserted = false,
    after = 0
  while (true) {
    const page = await scope.revisions(input.invocationId, input.recordId, after, 200)
    for (const prior of page) {
      if (!inserted && input.revision < prior.revision) {
        current = (await fold(sourceId, input, current, nativeScopes)).record
        inserted = true
      }
      current = (await fold(sourceId, prior, current, nativeScopes)).record
      after = prior.revision
    }
    if (page.length < 200) break
  }
  if (!inserted) current = (await fold(sourceId, input, current, nativeScopes)).record
  return { outcome: current!.issues.length ? 'diagnostic' : 'applied', record: current! }
}

async function appendEvent(
  sourceId: string,
  event: ObservationIngest['events'][number],
  scope: UsageLedgerScope,
  nativeSource?: string,
  nativeWatermark?: number,
  nativeScopes?: ObservationNativeScopeSource,
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
      ? await rebuild(sourceId, input, scope, nativeScopes)
      : await fold(sourceId, input, current, nativeScopes)
  await scope.append(
    event,
    { fingerprint, outcome: decision.outcome },
    decision.outcome === 'stale'
      ? undefined
      : {
          ...decision.record,
          ...(nativeWatermark === undefined && current?.nativeWatermark === undefined
            ? {}
            : { nativeWatermark: Math.max(nativeWatermark ?? 0, current?.nativeWatermark ?? 0) }),
        },
    nativeSource,
  )
  return priorRevision === undefined ? decision.outcome : 'duplicate'
}

/** The source watermark and every accepted revision share one commit. */
export function createUsageIngestion(
  store: UsageLedgerStore,
  nativeScopes?: ObservationNativeScopeSource,
  nativeHistory?: ObservationNativeHistorySource,
) {
  const append: typeof appendEvent = (sourceId, event, scope, nativeSource, nativeWatermark) =>
    appendEvent(
      sourceId,
      event,
      scope,
      nativeSource,
      nativeWatermark,
      nativeScopes ? scope.bindNativeScopes?.(nativeScopes) : undefined,
    )
  return {
    cursor: (sourceId: string) => store.cursor(sourceId),
    async repairCapture(receipt: UsageCaptureReceipt) {
      if (receipt.capture.contract === 'opencode-child-pages-v2')
        return nativeHistory
          ? repairNativeUsageHistory({ receipt, store, nativeHistory, nativeScopes, append })
          : undefined
      return store.change(receipt.sourceId, async (scope) => {
        const current = await scope.capture(receipt.invocationId)
        if (!current || current.sourceCursor !== receipt.sourceCursor) return
        const match = /^node-event:([1-9]\d*)$/.exec(current.sourceCursor)
        const watermark = match ? Number(match[1]) : undefined
        const value = {
          invocationId: current.invocationId,
          taskId: current.taskId,
          capture: current.capture,
        }
        const resolutions = await reconcileNativeUsageRevisions({
          value,
          watermark: Number.isSafeInteger(watermark) ? watermark : undefined,
          scope,
          append,
        })
        await scope.commitCapture(value, current.sourceCursor, resolutions)
      })
    },
    async ingest(raw: ObservationIngest) {
      const parsed = ObservationIngestSchema.safeParse(raw)
      if (!parsed.success)
        throw new ObservationIngestError('invalid-batch', 'Observation source page is invalid')
      const input = parsed.data
      if (
        input.nativeProcess !== undefined ||
        input.capture?.capture.contract === 'opencode-child-pages-v2' ||
        input.events.some((event) => isNativeUsageScope(event.measurement.scope))
      ) {
        if (!nativeScopes)
          throw new ObservationIngestError(
            'invalid-batch',
            'Original native source owner is not installed',
          )
        await nativeScopes.verify(input)
      }
      if (input.nextCursor === input.expectedCursor)
        throw new ObservationIngestError('invalid-batch', 'Source page did not advance')
      return store.change(input.sourceId, async (scope) => {
        const cursor = await scope.cursor()
        if (cursor !== input.expectedCursor && cursor !== input.nextCursor)
          throw new ObservationIngestError('cursor-conflict', 'Observation source cursor changed')
        const result = { applied: 0, diagnostic: 0, stale: 0, duplicate: 0 }
        const nativeSource = input.nativeSource ?? input.capture?.capture.nativeSource
        if (nativeSource) {
          const roots = [
            ...new Set([
              ...input.events.flatMap((event) =>
                event.measurement.scope ? [event.measurement.scope.root] : [],
              ),
              ...(input.capture?.capture.rootSessionId
                ? [input.capture.capture.rootSessionId]
                : []),
            ]),
          ].sort()
          for (const root of roots) await scope.lockNativeRoot(nativeSource, root)
        }
        for (const event of input.events)
          result[await append(input.sourceId, event, scope, nativeSource, input.nativeWatermark)]++
        if (cursor === input.nextCursor && result.duplicate !== input.events.length)
          throw new ObservationIngestError('cursor-conflict', 'Replayed page changed its event set')
        if (input.capture) {
          let prior: UsageCaptureReceipt | undefined
          if (cursor === input.nextCursor) {
            prior = await scope.capture(input.capture.invocationId)
            if (
              !prior ||
              prior.sourceCursor !== input.nextCursor ||
              JSON.stringify(prior.capture) !== JSON.stringify(input.capture.capture) ||
              prior.taskId !== input.capture.taskId
            )
              throw new ObservationIngestError(
                'event-conflict',
                'Replayed native capture proof changed',
              )
          }
          const resolutions =
            prior?.resolutions ??
            (await reconcileNativeUsageRevisions({
              value: input.capture,
              watermark: input.nativeWatermark,
              scope,
              append,
            }))
          await scope.commitCapture(input.capture, input.nextCursor, resolutions)
        }
        await scope.advance(input.nextCursor)
        return { cursor: input.nextCursor, ...result }
      })
    },
  }
}
