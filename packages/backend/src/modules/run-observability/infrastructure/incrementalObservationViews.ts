import { observationReportLeases } from '@/db/observationStorage'
import {
  admitObservationStorage,
  renewObservationView,
  observationViewAlive,
} from './observationStorageLifetime'
import { eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { ObservationOverviewQuery } from '@agent-workflow/shared'
import {
  observationProjectionHeads,
  observationProjectionVersions,
  observationProjectionViews,
} from '@/db/observationProjection'
import { sha256Hex } from '@/util/hash'
import type { IncrementalObservationVersion } from '../ports/incrementalObservationProjection'
import { CompleteObservationError } from '../domain/completeObservationError'
import { databaseSessionFor, engineOf } from '@/platform/persistence/databaseTransaction'

export interface IncrementalObservationView {
  readonly id: string
  readonly actorScope: string
  readonly generation: string
  readonly queryShape?: 'complete-cohort-v2'
  readonly version: IncrementalObservationVersion
  readonly query: ObservationOverviewQuery
  readonly taskId?: string
}
export function incrementalObservationViews(db: ProviderNeutralDatabase) {
  return {
    async retain(input: Omit<IncrementalObservationView, 'id'>) {
      return databaseSessionFor(db).transaction(async (tx) => {
        await admitObservationStorage(tx)
        let version = input.version
        if (
          version.revision !== '0' &&
          !(await tx
            .select()
            .from(observationProjectionVersions)
            .where(eq(observationProjectionVersions.revision, version.revision))
            .get())
        ) {
          const head = await tx
            .select()
            .from(observationProjectionHeads)
            .where(eq(observationProjectionHeads.id, 'incremental-20261012-v1'))
            .get()
          if (!head)
            throw new CompleteObservationError('not-ready', 'Current complete projection missing')
          const complete = await tx
            .select()
            .from(observationProjectionVersions)
            .where(eq(observationProjectionVersions.revision, head.revision))
            .get()
          version = complete?.bootstrapComplete
            ? { revision: head.revision, asOf: head.asOf }
            : { revision: '0', asOf: 0 }
        }
        const document = { ...input, version },
          requestKey = sha256Hex(JSON.stringify(document)),
          existing = await tx
            .select()
            .from(observationReportLeases)
            .where(eq(observationReportLeases.requestKey, requestKey))
            .get()
        if (existing && !existing.retiring) {
          const row = await tx
            .select()
            .from(observationProjectionViews)
            .where(eq(observationProjectionViews.id, existing.id))
            .get()
          if (row) {
            await renewObservationView(tx, row.id, 'projection', version.revision)
            return JSON.parse(row.document) as IncrementalObservationView
          }
        }
        const id = 'projection-' + crypto.randomUUID(),
          view = { ...document, id }
        await tx
          .insert(observationProjectionViews)
          .values({ id, actorScope: input.actorScope, document: JSON.stringify(view) })
          .run()
        await renewObservationView(tx, id, 'projection', version.revision)
        await tx
          .update(observationReportLeases)
          .set({ requestKey })
          .where(eq(observationReportLeases.id, id))
          .run()
        return view
      })
    },
    async activate(
      id: string,
      actorScope: string,
      version: IncrementalObservationVersion,
    ): Promise<IncrementalObservationView> {
      return databaseSessionFor(db).transaction(async (tx) => {
        await admitObservationStorage(tx)
        await engineOf(tx).lockAggregateRoot(
          tx,
          observationProjectionViews,
          observationProjectionViews.id,
          id,
        )
        const row = await tx
          .select()
          .from(observationProjectionViews)
          .where(eq(observationProjectionViews.id, id))
          .get()
        if (!row || !(await observationViewAlive(tx, id)))
          throw new CompleteObservationError(
            'not-found',
            'Original observation projection view missing',
          )
        if (row.actorScope !== actorScope)
          throw new CompleteObservationError(
            'scope-changed',
            'Original observation projection actor changed',
          )
        await renewObservationView(tx, id, 'projection')
        const pending = JSON.parse(row.document) as IncrementalObservationView
        if (pending.version.revision !== '0') return pending
        // The caller read the head before taking this lifecycle lock. Exact
        // reference GC may have retired that unbound intermediate version.
        let selected = version
        if (
          version.revision !== '0' &&
          !(await tx
            .select()
            .from(observationProjectionVersions)
            .where(eq(observationProjectionVersions.revision, version.revision))
            .get())
        ) {
          const head = await tx
            .select()
            .from(observationProjectionHeads)
            .where(eq(observationProjectionHeads.id, 'incremental-20261012-v1'))
            .get()
          if (!head)
            throw new CompleteObservationError('not-ready', 'Current complete projection missing')
          const complete = await tx
            .select()
            .from(observationProjectionVersions)
            .where(eq(observationProjectionVersions.revision, head.revision))
            .get()
          if (!complete?.bootstrapComplete) return pending
          selected = { revision: head.revision, asOf: head.asOf }
        }
        const view = { ...pending, version: selected }
        await tx
          .update(observationProjectionViews)
          .set({ document: JSON.stringify(view) })
          .where(eq(observationProjectionViews.id, id))
          .run()
        await renewObservationView(tx, id, 'projection', selected.revision)
        return view
      })
    },
    async get(id: string, actorScope: string): Promise<IncrementalObservationView> {
      return databaseSessionFor(db).transaction(async (tx) => {
        await admitObservationStorage(tx)
        const row = await tx
          .select()
          .from(observationProjectionViews)
          .where(eq(observationProjectionViews.id, id))
          .get()
        if (!row || !(await observationViewAlive(tx, id)))
          throw new CompleteObservationError(
            'not-found',
            'Observation report expired; request the original filters again',
          )
        if (row.actorScope !== actorScope)
          throw new CompleteObservationError(
            'scope-changed',
            'Original observation projection actor changed',
          )
        await renewObservationView(tx, id, 'projection')
        return JSON.parse(row.document) as IncrementalObservationView
      })
    },
  }
}
