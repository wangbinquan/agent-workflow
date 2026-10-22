// RFC-371 v2 — the single assembly of run observation. Roots inject the
// database, task facts (offered by task-execution) and the runtime directory.

import type { Hono } from 'hono'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { CallObservationLifecycle, CallObservations } from '../application/callObservations'
import {
  createObservationQueries,
  type ObservationQueries,
} from '../application/observationQueries'
import { createObservationPricing, type ObservationPricing } from '../application/pricing'
import type { ObservationTaskFactsPort } from '../application/ports/taskFacts'
import type { RuntimeDirectoryPort } from '../application/ports/runtimeDirectory'
import { createCallRecorder } from '../application/recordCalls'
import { createCallPersistence } from '../infrastructure/callPersistence'
import { createPricePersistence } from '../infrastructure/pricePersistence'
import { mountObservationRoutes } from '../inbound/http/observationRoutes'

export interface RunObservation {
  readonly calls: CallObservations & CallObservationLifecycle
  readonly queries: ObservationQueries
  readonly pricing: ObservationPricing
  mount(app: Hono): void
}

/** The write side alone: what runtime callers need to record their calls. */
export function composeRunObservationCalls(
  db: PersistenceDb,
  clock: () => number = Date.now,
): CallObservations & CallObservationLifecycle {
  return createCallRecorder({
    store: createCallPersistence(db),
    prices: createPricePersistence(db),
    clock,
  })
}

export function composeRunObservation(input: {
  readonly db: PersistenceDb
  readonly tasks: ObservationTaskFactsPort
  readonly runtimes: RuntimeDirectoryPort
  readonly clock?: () => number
}): RunObservation {
  const clock = input.clock ?? Date.now
  const callStore = createCallPersistence(input.db)
  const priceStore = createPricePersistence(input.db)
  const calls = createCallRecorder({ store: callStore, prices: priceStore, clock })
  const queries = createObservationQueries({ calls: callStore, tasks: input.tasks, clock })
  const pricing = createObservationPricing({
    prices: priceStore,
    calls: callStore,
    runtimes: input.runtimes,
    clock,
  })
  return {
    calls,
    queries,
    pricing,
    mount: (app) => mountObservationRoutes(app, { queries, pricing }),
  }
}
