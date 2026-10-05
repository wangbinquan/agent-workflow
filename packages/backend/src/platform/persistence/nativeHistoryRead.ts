import type { ObservationNativeHistorySource } from '@/modules/run-observability/public/participants'
import type { OriginalReportDatabaseBinding } from './reportSnapshot'
import { originalReportSnapshotSession } from './reportSnapshot'
import { unhandledDatabaseProvider } from './databaseProviders'
import { runNativeHistoryWorker } from '../background/observationReportWorkerHost'

/** Bootstrap selects the actual original source; full reads never run on the serving SQLite thread. */
export function nativeHistoryRead(
  binding: OriginalReportDatabaseBinding,
): ObservationNativeHistorySource['prepare'] {
  if (binding.provider === 'sqlite') {
    const filename = binding.db.$client.filename
    if (!filename || filename === ':memory:')
      throw new Error('Production native history Worker requires the original live database file')
    return (value, signal = new AbortController().signal) =>
      runNativeHistoryWorker(
        {
          kind: 'native-history',
          value,
          source: { kind: 'sqlite-file', filename, generationId: binding.generationId },
        },
        signal,
      )
  }
  if (binding.provider === 'postgresql') {
    const snapshots = originalReportSnapshotSession(binding)
    return (value, signal = new AbortController().signal) =>
      snapshots.run(
        (snapshot) =>
          runNativeHistoryWorker(
            {
              kind: 'native-history',
              value,
              source: {
                kind: 'original-channel',
                snapshotId: snapshot.snapshotId,
                generationId: snapshot.generationId,
                asOf: snapshot.asOf,
              },
            },
            signal,
            snapshot,
          ),
        signal,
      )
  }
  return unhandledDatabaseProvider(binding)
}
