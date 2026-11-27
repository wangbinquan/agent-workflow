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
import { attachRouteOperationSink } from '@/routes/registry'
import {
  composeOperationRecorder,
  composeProcessMetrics,
  type ProcessMetrics,
} from './processMetrics'

export interface RunObservation {
  readonly calls: CallObservations & CallObservationLifecycle
  readonly queries: ObservationQueries
  readonly pricing: ObservationPricing
  /** RFC-616: process metrics; null where the root did not bind the fact sources. */
  readonly process: ProcessMetrics | null
  mount(app: Hono): void
}

/** RFC-616: what process metrics need beyond run observation's own inputs. */
export type RunObservationProcessInput = Omit<
  Parameters<typeof composeProcessMetrics>[0],
  'db' | 'clock'
> & {
  /** false while the database must not be written; human operations are then not recorded. */
  readonly writable?: () => boolean
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

interface RunObservationInput {
  readonly db: PersistenceDb
  readonly tasks: ObservationTaskFactsPort
  readonly runtimes: RuntimeDirectoryPort
  readonly clock?: () => number
}

/** A root that binds the process fact sources gets process metrics; one that does not gets none. */
export function composeRunObservation(
  input: RunObservationInput & { readonly process: RunObservationProcessInput },
): RunObservation & { readonly process: ProcessMetrics }
export function composeRunObservation(
  input: RunObservationInput & { readonly process?: undefined },
): RunObservation
export function composeRunObservation(
  input: RunObservationInput & { readonly process?: RunObservationProcessInput },
): RunObservation {
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
  const process =
    input.process === undefined
      ? null
      : composeProcessMetrics({ ...input.process, db: input.db, clock })
  // RFC-616 §5.4: routes that declare `observe` hand their successful calls to this recorder.
  const operations = composeOperationRecorder({ db: input.db, writable: input.process?.writable })
  return {
    calls,
    queries,
    pricing,
    process,
    mount: (app) => {
      attachRouteOperationSink(app, operations)
      mountObservationRoutes(app, { queries, pricing })
      process?.mount(app)
    },
  }
}
