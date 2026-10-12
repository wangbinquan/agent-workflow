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
}) {
  const adapter = createIncrementalObservationProjectionStore(input.db, input.generation),
    query = createIncrementalObservationQueryStore(input.db),
    views = incrementalObservationViews(input.db),
    changes = incrementalObservationChangeQueue(input.db, input.failed)
  const projection = createIncrementalObservationProjection({
    store: adapter.store,
    source: adapter.source(preparedObservationContributions),
    now: Date.now,
    ...(input.committed ? { committed: input.committed } : {}),
  })
  const worker = incrementalObservationWorker({
    store: adapter.store,
    bootstrap: input.bootstrap,
    dispatch: () => changes.dispatch(input.router, 100),
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
      async *visibleTasks(actor, filters, taskId) {
        const facts = input.tasks(input.db, taskId)
        let after: string | undefined
        for (;;) {
          const page = await facts.list({
            actor,
            query: { ...filters, limit: 200, ...(after ? { after } : {}) },
          })
          for (const task of page.items) yield task
          if (page.nextCursor === null) return
          if (after === page.nextCursor)
            throw new Error('Original projection visible Task EOF did not advance')
          after = page.nextCursor
        }
      },
    },
  })
  return {
    worker,
    queries: {
      ...queries,
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
