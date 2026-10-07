import type { NativeUsageBaselineReadSession } from '@/modules/task-execution/public/types'
import { withNativeUsageBaselineWorker } from '../background/nativeUsageBaselineWorkerHost'
import type { OriginalReportDatabaseBinding } from './reportSnapshot'
import { originalReportSnapshotSession } from './reportSnapshot'
import { unhandledDatabaseProvider } from './databaseProviders'

/** Bootstrap selects the original file/generation or original reserved PG read channel. */
export function nativeUsageBaselineRead(
  binding: OriginalReportDatabaseBinding,
  postgresqlPoolMax?: number,
): NativeUsageBaselineReadSession | undefined {
  if (binding.provider === 'sqlite') {
    const filename = binding.db.$client.filename
    // Original one-connection memory keeps strict per-page verification.
    if (!filename || filename === ':memory:') return undefined
    return {
      run(input, work) {
        return withNativeUsageBaselineWorker(
          {
            source: { kind: 'sqlite-file', filename, generationId: binding.generationId },
            binding: input.binding,
            original: input.original,
          },
          input.signal ?? new AbortController().signal,
          work,
        )
      },
    }
  }
  if (binding.provider === 'postgresql') {
    // Never reserve the sole pool channel while final-page writes wait for it.
    if (postgresqlPoolMax === undefined || postgresqlPoolMax <= 1) return undefined
    const snapshots = originalReportSnapshotSession(binding)
    return {
      run(input, work) {
        const signal = input.signal ?? new AbortController().signal
        return snapshots.run(
          (snapshot) =>
            withNativeUsageBaselineWorker(
              {
                source: {
                  kind: 'original-channel',
                  snapshotId: snapshot.snapshotId,
                  generationId: snapshot.generationId,
                  asOf: snapshot.asOf,
                },
                binding: input.binding,
                original: input.original,
              },
              signal,
              work,
              snapshot,
            ),
          signal,
        )
      },
    }
  }
  return unhandledDatabaseProvider(binding)
}
