import { randomUUID } from 'node:crypto'
import type { ProviderNeutralDatabase } from '@/db/query'
import { sha256Hex } from '@/util/hash'
import { completeObservationReportService } from '../application/completeObservationReportService'
import type {
  ObservationExecutionLifecycle,
  ObservationExecutionLifetime,
} from '../application/completeObservationExecution'
import { completeObservationHostClaims } from '../infrastructure/completeObservationHostClaims'
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

interface ObservationProjectionWorker {
  start(execution?: ObservationExecutionLifetime): void
  drain?(): Promise<void>
  stop(): Promise<void>
  quiesce?(): void
  drainAuthority?(): Promise<void>
}

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
  readonly executionMode?: 'native' | 'host'
  readonly projection?: {
    readonly queries: CompleteObservationReportQueries
    readonly worker: ObservationProjectionWorker
  }
}) {
  if (
    input.executionMode !== undefined &&
    input.executionMode !== 'native' &&
    input.executionMode !== 'host'
  )
    throw new Error('observation-report-execution-mode-invalid')
  if (
    input.executionMode === 'host' &&
    input.projection &&
    (!input.projection.worker.quiesce || !input.projection.worker.drainAuthority)
  )
    throw new Error('observation-report-projection-host-contract-incomplete')
  const spool = completeObservationFileSpool(input.appHome)
  const service = completeObservationReportService({
    store: completeObservationReportCache(input.db, input.generation, input.taskSource),
    spool,
    scopeOf: completeObservationActorScope,
    keyOf: sha256Hex,
    newId: randomUUID,
    owner: randomUUID(),
    heartbeatDuringRead: input.heartbeatDuringRead,
    ...(input.executionMode === 'host'
      ? { execution: completeObservationHostClaims(input.db) }
      : {}),
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
  const execution =
    service.execution && composeReportExecution(service.execution, input.projection?.worker)
  return {
    ...(execution ? { execution } : {}),
    queries,
    auditQueries: service satisfies CompleteObservationReportQueries,
    worker: input.projection
      ? {
          start() {
            input.projection!.worker.start()
          },
          async drain() {
            await input.projection!.worker.drain?.()
          },
          async stop() {
            await input.projection!.worker.stop()
            await service.worker.stop()
          },
        }
      : service.worker,
  }
}

function composeReportExecution(
  reports: ObservationExecutionLifecycle,
  projection: ObservationProjectionWorker | undefined,
): ObservationExecutionLifecycle {
  const start = reports.start.bind(reports),
    quiesce = reports.quiesce.bind(reports),
    drain = reports.awaitDrained.bind(reports),
    pause = reports.pause.bind(reports)
  const auxiliary = projection && {
    start: projection.start.bind(projection),
    stop: projection.stop.bind(projection),
    quiesce: projection.quiesce!.bind(projection),
    drain: projection.drainAuthority!.bind(projection),
  }
  let active:
    | { lifetime: ObservationExecutionLifetime; current: () => boolean; drained: boolean }
    | undefined
  const requireLifetime = (lifetime: ObservationExecutionLifetime) => {
    if (active?.lifetime !== lifetime) throw new Error('observation-reports-lifetime-mismatch')
    return active
  }
  const finish = async (work: readonly Promise<unknown>[]) => {
    const settled = await Promise.allSettled(work)
    const errors = settled.filter(
      (value): value is PromiseRejectedResult => value.status === 'rejected',
    )
    if (errors.length)
      throw new AggregateError(
        errors.map((value) => value.reason),
        'Observation workers did not drain',
      )
  }
  const lifecycle: ObservationExecutionLifecycle = {
    async start(lifetime) {
      if (active && !active.drained)
        throw new Error('observation-reports-prior-lifetime-not-drained')
      await start(lifetime)
      active = { lifetime, current: lifetime.current.bind(lifetime), drained: false }
      try {
        auxiliary?.start(lifetime)
      } catch (error) {
        await lifecycle.quiesce(lifetime)
        await lifecycle.awaitDrained(lifetime)
        throw error
      }
    },
    async quiesce(lifetime) {
      requireLifetime(lifetime)
      auxiliary?.quiesce()
      await quiesce(lifetime)
    },
    async awaitDrained(lifetime) {
      const frame = requireLifetime(lifetime)
      await finish([drain(lifetime), ...(auxiliary ? [auxiliary.drain()] : [])])
      frame.drained = true
    },
    async pause(lifetime) {
      const frame = requireLifetime(lifetime)
      if (!frame.current()) {
        await lifecycle.quiesce(lifetime)
        await lifecycle.awaitDrained(lifetime)
        return
      }
      await finish([pause(lifetime), ...(auxiliary ? [auxiliary.stop()] : [])])
      await finish([drain(lifetime), ...(auxiliary ? [auxiliary.drain()] : [])])
      frame.drained = true
    },
  }
  return lifecycle
}

export type { ObservationExecutionLifecycle } from '../application/completeObservationExecution'
