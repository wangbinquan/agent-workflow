import type {
  CompleteObservationBuildResult,
  CompleteObservationStoredReport,
} from '@/modules/run-observability/public/participants'
import type { OriginalReportDatabaseBinding } from './reportSnapshot'
import { originalReportSnapshotSession } from './reportSnapshot'
import { unhandledDatabaseProvider } from './databaseProviders'
import { runObservationReportWorker } from '../background/observationReportWorkerHost'

/** Provider choices are made at platform bootstrap, without a Worker fallback on the serving thread. */
export function observationReportBuild(
  binding: OriginalReportDatabaseBinding,
  appHome: string,
): {
  readonly heartbeatDuringRead: boolean
  readonly build: (
    report: CompleteObservationStoredReport,
    signal: AbortSignal,
  ) => Promise<CompleteObservationBuildResult>
} {
  if (binding.provider === 'sqlite') {
    const filename = binding.db.$client.filename
    if (!filename || filename === ':memory:')
      throw new Error('Full observation Worker requires the original live database file')
    return {
      heartbeatDuringRead: true,
      build: (report, signal) =>
        runObservationReportWorker(
          {
            kind: 'start',
            appHome,
            report,
            source: { kind: 'sqlite-file', filename, generationId: binding.generationId },
          },
          signal,
        ),
    }
  }
  if (binding.provider === 'postgresql') {
    const session = originalReportSnapshotSession(binding)
    return {
      heartbeatDuringRead: false,
      build: (report, signal) =>
        session.run(
          (snapshot) =>
            runObservationReportWorker(
              {
                kind: 'start',
                appHome,
                report,
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
          { id: report.id, owner: report.owner, generation: report.generation },
        ),
    }
  }
  return unhandledDatabaseProvider(binding)
}
