import { randomUUID } from 'node:crypto'
import type { ProviderNeutralDatabase } from '@/db/query'
import { sha256Hex } from '@/util/hash'
import { completeObservationReportService } from '../application/completeObservationReportService'
import { completeObservationReportCache } from '../infrastructure/completeObservationReportStore'
import { completeObservationFileSpool } from '../infrastructure/completeObservationFileSpool'
import { completeObservationActorScope } from '../infrastructure/completeObservationReportDocuments'
import { completeReportPerformanceObserver } from '../infrastructure/completeReportPerformanceObserver'
import type {
  CompleteObservationBuildResult,
  CompleteObservationSpool,
  CompleteObservationStoredReport,
} from '../ports/completeObservationReport'
import type { CompleteObservationReportQueries } from '../public/queries'
import type { CompleteObservationTaskSource } from '../ports/taskObservations'

export function composeCompleteObservationReports(input: {
  readonly db: ProviderNeutralDatabase
  readonly taskSource: (db: ProviderNeutralDatabase) => CompleteObservationTaskSource
  readonly generation: string
  readonly appHome: string
  readonly heartbeatDuringRead: boolean
  readonly build: (
    report: CompleteObservationStoredReport,
    spool: CompleteObservationSpool,
    signal: AbortSignal,
  ) => Promise<CompleteObservationBuildResult>
  readonly closeBuild?: () => Promise<void>
  readonly projection?: {
    readonly queries: CompleteObservationReportQueries
    readonly worker: { start(): void; stop(): Promise<void> }
  }
}) {
  const spool = completeObservationFileSpool(input.appHome)
  const service = completeObservationReportService({
    store: completeObservationReportCache(input.db, input.generation, input.taskSource),
    spool,
    scopeOf: completeObservationActorScope,
    keyOf: sha256Hex,
    newId: randomUUID,
    owner: randomUUID(),
    heartbeatDuringRead: input.heartbeatDuringRead,
    observePhase: (report) =>
      completeReportPerformanceObserver(report.id, report.request.refreshKey),
    build: (report, signal) => input.build(report, spool, signal),
    ...(input.closeBuild ? { closeBuild: input.closeBuild } : {}),
  })
  const queries: CompleteObservationReportQueries = input.projection
    ? {
        ...input.projection.queries,
        status: (actor, id) =>
          id.startsWith('projection-')
            ? input.projection!.queries.status(actor, id)
            : service.status(actor, id),
        page: (actor, id, query) =>
          id.startsWith('projection-')
            ? input.projection!.queries.page(actor, id, query)
            : service.page(actor, id, query),
      }
    : service
  return {
    queries,
    auditQueries: service satisfies CompleteObservationReportQueries,
    worker: input.projection
      ? {
          start() {
            input.projection!.worker.start()
          },
          async stop() {
            await input.projection!.worker.stop()
            await service.worker.stop()
          },
        }
      : service.worker,
  }
}
