import { randomUUID } from 'node:crypto'
import type { ProviderNeutralDatabase } from '@/db/query'
import { sha256Hex } from '@/util/hash'
import { completeObservationReportService } from '../application/completeObservationReportService'
import { completeObservationReportCache } from '../infrastructure/completeObservationReportStore'
import { completeObservationFileSpool } from '../infrastructure/completeObservationFileSpool'
import { completeObservationActorScope } from '../infrastructure/completeObservationReportDocuments'
import type {
  CompleteObservationBuildResult,
  CompleteObservationSpool,
  CompleteObservationStoredReport,
} from '../ports/completeObservationReport'
import type { CompleteObservationReportQueries } from '../public/queries'

export function composeCompleteObservationReports(input: {
  readonly db: ProviderNeutralDatabase
  readonly generation: string
  readonly appHome: string
  readonly heartbeatDuringRead: boolean
  readonly build: (
    report: CompleteObservationStoredReport,
    spool: CompleteObservationSpool,
    signal: AbortSignal,
  ) => Promise<CompleteObservationBuildResult>
}) {
  const spool = completeObservationFileSpool(input.appHome)
  const service = completeObservationReportService({
    store: completeObservationReportCache(input.db, input.generation),
    spool,
    scopeOf: completeObservationActorScope,
    keyOf: sha256Hex,
    newId: randomUUID,
    owner: randomUUID(),
    heartbeatDuringRead: input.heartbeatDuringRead,
    build: (report, signal) => input.build(report, spool, signal),
  })
  return { queries: service satisfies CompleteObservationReportQueries, worker: service.worker }
}
