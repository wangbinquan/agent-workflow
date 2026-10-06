import { composeLocalInvocationObservations } from '@/modules/run-observability/composition/localInvocations'
import { composeObservationUsageSource } from '@/modules/task-execution/composition/observationUsageSource'
import {
  createObservationNativeHistory,
  prepareOriginalNativeHistory,
} from '@/modules/task-execution/infrastructure/observationNativeHistory'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import { nativeHistoryRead } from '@/platform/persistence/nativeHistoryRead'
import type { ProviderHarness } from './eachProvider'

/** The real original snapshot is closed before the history writer is acquired. */
export function originalNativeObservationParticipant(harness: ProviderHarness) {
  const actual = harness.applicationBinding
  const original =
    actual.provider === 'sqlite'
      ? { ...actual, generationId: 'original-root-producer-harness' }
      : { provider: 'postgresql' as const, runtime: actual.runtime }
  const prepare =
    actual.provider === 'postgresql' || actual.db.$client.filename !== ':memory:'
      ? nativeHistoryRead(original)
      : (value: Parameters<typeof prepareOriginalNativeHistory>[1], signal?: AbortSignal) =>
          originalReportSnapshotSession(original).run(
            (snapshot) => prepareOriginalNativeHistory(snapshot.executor, value, snapshot),
            signal,
          )
  return composeLocalInvocationObservations(harness.db, {
    ...composeObservationUsageSource(harness.db),
    nativeHistory: createObservationNativeHistory(harness.db, prepare),
  })
}
