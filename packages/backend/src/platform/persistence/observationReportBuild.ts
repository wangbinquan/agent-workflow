import type {
  CompleteObservationBuildResult,
  CompleteObservationStoredReport,
} from '@/modules/run-observability/public/participants'
import type { OriginalReportDatabaseBinding } from './reportSnapshot'
import { originalReportSnapshotSession } from './reportSnapshot'
import { unhandledDatabaseProvider } from './databaseProviders'
import { runObservationReportWorkerWithFacts } from '../background/observationReportWorkerHost'
import type { ObservationReportWorkerStart } from '../background/observationReportProtocol'
import type { ProviderNeutralDatabase } from '@/db/query'
import { isDeepStrictEqual } from 'node:util'
import type { HistoricalNativeVersionObserver } from '@/modules/runtime-management/public/participants'
import { createHistoricalNativeVersionObserver } from '@/modules/runtime-management/composition/historicalNativeVersion'
import {
  historicalNativeFactFileSpool,
  importHistoricalNativeFacts,
} from '@/modules/run-observability/composition/historicalNativeFacts'
import { completeObservationFileSpool } from '@/modules/run-observability/composition/completeObservationSpool'
import {
  completeCalculationSourceProof,
  completeCalculationFactFileSpool,
  importCompleteTaskCalculations,
} from '@/modules/run-observability/composition/completeCalculations'
import { createLogger } from '@/util/log'
import { CompleteCalculationInvalid } from '@/modules/run-observability/public/participants'

const log = createLogger('observation-native-facts')

function originalBuild(
  binding: OriginalReportDatabaseBinding,
  appHome: string,
  taskCalculations?: true,
) {
  if (binding.provider === 'sqlite') {
    const filename = binding.db.$client.filename
    if (!filename || filename === ':memory:')
      throw new Error('Full observation Worker requires the original live database file')
    return {
      heartbeatDuringRead: true,
      build: (
        report: CompleteObservationStoredReport,
        signal: AbortSignal,
        nativeProof?: ObservationReportWorkerStart['nativeProof'],
      ) =>
        runObservationReportWorkerWithFacts(
          {
            kind: 'start',
            appHome,
            report,
            source: { kind: 'sqlite-file', filename, generationId: binding.generationId },
            ...(nativeProof ? { nativeProof } : {}),
            ...(taskCalculations ? { taskCalculations } : {}),
          },
          signal,
        ),
    }
  }
  if (binding.provider === 'postgresql') {
    const session = originalReportSnapshotSession(binding)
    return {
      heartbeatDuringRead: false,
      build: (
        report: CompleteObservationStoredReport,
        signal: AbortSignal,
        nativeProof?: ObservationReportWorkerStart['nativeProof'],
      ) =>
        session.run(
          (snapshot) =>
            runObservationReportWorkerWithFacts(
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
                ...(nativeProof ? { nativeProof } : {}),
                ...(taskCalculations ? { taskCalculations } : {}),
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

/** Provider choices are made at platform bootstrap, without a Worker fallback on the serving thread. */
export function observationReportBuild(
  binding: OriginalReportDatabaseBinding,
  appHome: string,
  writer?: ProviderNeutralDatabase,
  options?: { readonly taskCalculations: true },
): {
  readonly heartbeatDuringRead: boolean
  readonly build: (
    report: CompleteObservationStoredReport,
    signal: AbortSignal,
  ) => Promise<CompleteObservationBuildResult>
  readonly close: () => Promise<void>
} {
  const original = originalBuild(binding, appHome, options?.taskCalculations),
    observer: HistoricalNativeVersionObserver | undefined = writer
      ? createHistoricalNativeVersionObserver(process.env)
      : undefined,
    spool = completeObservationFileSpool(appHome),
    factSpool = historicalNativeFactFileSpool(appHome),
    calculationSpool = completeCalculationFactFileSpool(appHome),
    active = new Set<Promise<CompleteObservationBuildResult>>()
  const build = async (report: CompleteObservationStoredReport, signal: AbortSignal) => {
    // A cache invalidation retries once in a new original application snapshot, never in old TEMP.
    for (let pass = 0; pass < 2; pass++) {
      signal.throwIfAborted()
      const proof = pass === 0 ? await observer?.sample() : null
      const result = await original.build(report, signal, proof ?? undefined)
      signal.throwIfAborted()
      if (result.kind === 'native-facts-invalid') {
        if (pass !== 0) throw new Error(result.reason)
        await spool.remove(report.id, report.owner)
        await observer?.close()
        continue
      }
      if (result.nativeFacts || result.calculationFacts) {
        const usedCache = result.nativeFacts?.usedCache || result.calculationFacts?.usedCache
        if (result.calculationFacts && report.request.refreshKey.startsWith('load-performance-'))
          log.info('original task calculation reuse', {
            reportId: report.id,
            pass: String(pass),
            ...result.calculationFacts.statistics,
          })
        if (
          result.calculationFacts?.historicalPreparation &&
          report.request.refreshKey.startsWith('load-performance-')
        )
          log.info('original historical preparation reuse', {
            reportId: report.id,
            pass: String(pass),
            ...result.calculationFacts.historicalPreparation,
          })
        if (result.nativeFacts && report.request.refreshKey.startsWith('load-performance-'))
          log.info('original native numeric page reuse', {
            reportId: report.id,
            pass: String(pass),
            ...result.nativeFacts.statistics,
          })
        const after = await observer?.sample(),
          same = proof !== null && proof !== undefined && isDeepStrictEqual(proof, after)
        if (usedCache && !same) {
          await spool.remove(report.id, report.owner)
          continue
        }
        if (same && writer) {
          // Awaiting original.build has released SQLite and the outer PostgreSQL reservation.
          if (result.nativeFacts)
            await importHistoricalNativeFacts({
              db: writer,
              spool: factSpool,
              manifest: result.nativeFacts.manifest,
              signal,
            })
          if (
            result.calculationFacts &&
            isDeepStrictEqual(
              result.calculationFacts.manifest.context.source,
              await completeCalculationSourceProof(writer, report.generation),
            )
          )
            try {
              await importCompleteTaskCalculations({
                db: writer,
                spool: calculationSpool,
                manifest: result.calculationFacts.manifest,
                signal,
              })
            } catch (error) {
              signal.throwIfAborted()
              if (!(error instanceof CompleteCalculationInvalid) || pass !== 0) throw error
              // Derived corruption gets the original one-time uncached rebuild, not empty statistics.
              await spool.remove(report.id, report.owner)
              continue
            }
          if (usedCache && !isDeepStrictEqual(proof, await observer?.sample())) {
            await spool.remove(report.id, report.owner)
            continue
          }
        }
      }
      return result.result
    }
    throw new Error('Original uncached observation rebuild did not finish')
  }
  return {
    heartbeatDuringRead: original.heartbeatDuringRead,
    build(report, signal) {
      const work = build(report, signal)
      active.add(work)
      void work.finally(() => active.delete(work)).catch(() => {})
      return work
    },
    async close() {
      await Promise.allSettled([...active])
      await observer?.close()
    },
  }
}
