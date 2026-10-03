import type { ObservationPlatformNativeCapture } from '@agent-workflow/shared'
import { completeObservationGap } from '../domain/completeObservationMetrics'
import type { CompleteObservationContribution } from '../ports/completeObservationTask'
import { completeWorkingCache } from './completeWorkingCache'
import { completeWorkingTraversal } from './completeWorkingTraversal'
import type { CompleteObservationEvidenceContext } from './completeObservationEvidence'
import { completePlatformCaptureKey } from './completeObservationPlatform'

/** Validate every raw imported record before coverage selection can exclude a covered child. */
export async function validateCompletePlatformRecords(context: CompleteObservationEvidenceContext) {
  const { input, space } = context
  const counts = completeWorkingCache<string>(
    input.rows,
    space('platform-capture-record-counts'),
    input.signal,
  )
  for await (const row of completeWorkingTraversal<CompleteObservationContribution>(
    input.rows,
    space('platform-raw-usage'),
    input.signal,
  )) {
    const record = row.document,
      scope = record.platformUsage?.scope
    const { key, entry } = await context.invocationFor(record.invocationId)
    const captureKey = scope
      ? input.keyOf(
          completePlatformCaptureKey(
            record.invocationId,
            record.sourceId,
            scope.root,
            scope.turn,
            scope.turnIndex,
          ),
        )
      : null
    const capture = captureKey
      ? await input.rows.get<ObservationPlatformNativeCapture>(
          space('platform-capture-turns'),
          captureKey,
        )
      : undefined
    if (!capture || capture.state !== 'complete')
      completeObservationGap(entry.fold, 'native-capture-unobserved')
    if (captureKey) {
      const count = String(BigInt((await counts.get(captureKey)) ?? '0') + 1n)
      await counts.put(captureKey, count)
      if (capture && BigInt(count) > BigInt(capture.receivedSteps))
        completeObservationGap(entry.fold, 'native-capture-partial')
    }
    await context.invocations.put(key, entry)
  }
  await counts.flush()
  for await (const row of completeWorkingTraversal<ObservationPlatformNativeCapture>(
    input.rows,
    space('platform-capture-turns'),
    input.signal,
  )) {
    const capture = row.document
    if (BigInt((await counts.get(row.key)) ?? '0') !== BigInt(capture.receivedSteps)) {
      // Every complete native emitted step has its numeric projection, even when coverage later removes it.
      const retained = await input.rows.get<{ invocationId: string }>(
        space('platform-capture-owners'),
        row.key,
      )
      if (!retained) throw new Error('Original platform capture owner missing')
      const { key, entry } = await context.invocationFor(retained.invocationId)
      completeObservationGap(entry.fold, 'native-capture-records-missing')
      await context.invocations.put(key, entry)
    }
  }
}
