import { observationMaintenance } from '../infrastructure/observationMaintenance'
import { observationStorageStatus } from '../infrastructure/observationStorageStatus'
import { collectObservationStorage } from '../infrastructure/observationStorageGc'
import { observationStorageWorker } from '../application/observationStorageWorker'
import type { ObservationExecutionLifetime } from '../application/completeObservationExecution'
import {
  observeStorageAnomalies,
  observationAnomalyQueries,
  observationAnomalySampler,
} from '../infrastructure/observationAnomalies'
import type { ProviderNeutralDatabase } from '@/db/query'
import { sha256Hex } from '@/util/hash'
import { createIncrementalObservationProjection } from '../application/incrementalObservationProjection'
import { incrementalObservationQueries } from '../application/incrementalObservationQueries'
import { incrementalObservationWorker } from '../application/incrementalObservationWorker'
import { createIncrementalObservationProjectionStore } from '../infrastructure/incrementalObservationProjectionStore'
import { createIncrementalObservationQueryStore } from '../infrastructure/incrementalObservationQueryStore'
import { incrementalObservationViews } from '../infrastructure/incrementalObservationViews'
import { incrementalObservationChangeQueue } from '../infrastructure/incrementalObservationChanges'
import { preparedObservationContributions } from '../infrastructure/incrementalObservationPreparedStore'
import { deferIncrementalObservationWork } from '../infrastructure/incrementalObservationWork'
import { completeObservationActorScope } from '../infrastructure/completeObservationReportDocuments'
import type { CompleteObservationTaskSource } from '../ports/taskObservations'
import type { OriginalObservationChangeRouter } from '../ports/incrementalObservationChanges'
import type {
  IncrementalObservationWork,
  IncrementalObservationVersion,
} from '../ports/incrementalObservationProjection'

export function composeIncrementalObservationProjection(input: {
  readonly db: ProviderNeutralDatabase
  readonly generation: string
  readonly tasks: (db: ProviderNeutralDatabase, taskId?: string) => CompleteObservationTaskSource
  readonly router: OriginalObservationChangeRouter
  readonly prepare: (
    work: IncrementalObservationWork,
    signal: AbortSignal,
  ) => Promise<IncrementalObservationWork>
  readonly bootstrap: (signal: AbortSignal) => Promise<number>
  readonly committed?: (version: IncrementalObservationVersion) => void
  readonly failed: (error: unknown) => void
  readonly executionMode?: 'native' | 'host'
}) {
  const adapter = createIncrementalObservationProjectionStore(input.db, input.generation),
    query = createIncrementalObservationQueryStore(input.db),
    views = incrementalObservationViews(input.db),
    sampleAnomalies = observationAnomalySampler(input.db),
    changes = incrementalObservationChangeQueue(input.db, input.failed)
  const projection = createIncrementalObservationProjection({
    store: adapter.store,
    source: adapter.source(preparedObservationContributions),
    now: Date.now,
    ...(input.committed ? { committed: input.committed } : {}),
  })
  const worker = incrementalObservationWorker({
    ...(input.executionMode ? { executionMode: input.executionMode } : {}),
    store: adapter.store,
    bootstrap: input.bootstrap,
    dispatch: async () => {
      const dispatched = await changes.dispatch(input.router, 100)
      await maintenance?.tick()
      await sampleAnomalies()
      return dispatched
    },
    prepare: input.prepare,
    apply: projection.apply,
    failed: input.failed,
    defer: (work, error) => deferIncrementalObservationWork(input.db, work, error),
  })
  const queries = incrementalObservationQueries({
    generation: input.generation,
    scopeOf: completeObservationActorScope,
    keyOf: sha256Hex,
    source: {
      ...query,
      retainView: views.retain,
      activateView: views.activate,
      view: views.get,
      visibleTaskIds: (actor, ids) => input.tasks(input.db).visibleIds(actor, ids),
    },
  })
  const maintenance = observationMaintenance({
    db: input.db,
    reports: queries,
    scopeOf: completeObservationActorScope,
    failed: input.failed,
  })
  const storage = observationStorageStatus(input.db),
    storageWorker = observationStorageWorker({
      ...(input.executionMode ? { executionMode: input.executionMode } : {}),
      ...storage,
      sample: async () => {
        await storage.sample()
        await observeStorageAnomalies(input.db, await storage.read())
      },
      failed: async (error) => {
        input.failed(error)
        await storage.failed(error)
        await observeStorageAnomalies(input.db, await storage.read())
      },
      collect: async () => {
        let scanned = 0
        const removed = await collectObservationStorage(input.db, (rows) => {
          scanned = rows
        })
        return { removed, scanned }
      },
    })
  return {
    worker: {
      start(execution?: ObservationExecutionLifetime) {
        worker.start(execution)
        storageWorker.start(execution)
      },
      async drain() {
        await Promise.all([worker.drain(), storageWorker.drain()])
      },
      async stop() {
        await Promise.all([worker.stop(), storageWorker.stop()])
      },
      quiesce() {
        worker.quiesce()
        storageWorker.quiesce()
      },
      async drainAuthority() {
        const settled = await Promise.allSettled([
          worker.drainAuthority(),
          storageWorker.drainAuthority(),
        ])
        const failures = settled.filter(
          (value): value is PromiseRejectedResult => value.status === 'rejected',
        )
        if (failures.length)
          throw new AggregateError(
            failures.map((value) => value.reason),
            'Observation projection drain failed',
          )
      },
    },
    queries: {
      ...queries,
      storage: storage.read,
      maintenance: maintenance.commands,
      anomalies: (
        actor: Parameters<typeof queries.request>[0],
        query: { from: number; to: number; after?: string; pageSize: number },
      ) =>
        observationAnomalyQueries(
          input.db,
          (ids) => input.tasks(input.db).visibleIds(actor, ids),
          actor.permissions.has('settings:write'),
        )(query),
      async projectionVersion() {
        const version = await query.snapshot()
        return version && (await query.bootstrapComplete(version)) ? version : null
      },
    },
  }
}
export { incrementalObservationQualification } from './incrementalObservationQualification'
export type { ProjectionOriginalScope } from './incrementalObservationQualification'
export type {
  OriginalObservationChange,
  OriginalObservationChangeRouter,
} from '../ports/incrementalObservationChanges'
export { composeOriginalProjectionBootstrap } from './incrementalObservationBootstrap'
