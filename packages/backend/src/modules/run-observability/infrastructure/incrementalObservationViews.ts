import { eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { ObservationOverviewQuery } from '@agent-workflow/shared'
import { observationProjectionViews } from '@/db/observationProjection'
import { sha256Hex } from '@/util/hash'
import type { IncrementalObservationVersion } from '../ports/incrementalObservationProjection'
import { CompleteObservationError } from '../domain/completeObservationError'
import { databaseSessionFor, engineOf } from '@/platform/persistence/databaseTransaction'

export interface IncrementalObservationView {
  readonly id: string
  readonly actorScope: string
  readonly generation: string
  readonly version: IncrementalObservationVersion
  readonly query: ObservationOverviewQuery
  readonly taskId?: string
}
export function incrementalObservationViews(db: ProviderNeutralDatabase) {
  return {
    async retain(input: Omit<IncrementalObservationView, 'id'>) {
      const id = 'projection-' + sha256Hex(JSON.stringify(input)),
        view = { ...input, id }
      await db
        .insert(observationProjectionViews)
        .values({ id, actorScope: input.actorScope, document: JSON.stringify(view) })
        .onConflictDoNothing()
        .run()
      return view
    },
    async activate(
      id: string,
      actorScope: string,
      version: IncrementalObservationVersion,
    ): Promise<IncrementalObservationView> {
      return databaseSessionFor(db).transaction(async (tx) => {
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
        if (!row)
          throw new CompleteObservationError(
            'not-found',
            'Original observation projection view missing',
          )
        if (row.actorScope !== actorScope)
          throw new CompleteObservationError(
            'scope-changed',
            'Original observation projection actor changed',
          )
        const pending = JSON.parse(row.document) as IncrementalObservationView
        if (pending.version.revision !== '0') return pending
        const view = { ...pending, version }
        await tx
          .update(observationProjectionViews)
          .set({ document: JSON.stringify(view) })
          .where(eq(observationProjectionViews.id, id))
          .run()
        return view
      })
    },
    async get(id: string, actorScope: string): Promise<IncrementalObservationView> {
      const row = await db
        .select()
        .from(observationProjectionViews)
        .where(eq(observationProjectionViews.id, id))
        .get()
      if (!row)
        throw new CompleteObservationError(
          'not-found',
          'Original observation projection view missing',
        )
      if (row.actorScope !== actorScope)
        throw new CompleteObservationError(
          'scope-changed',
          'Original observation projection actor changed',
        )
      return JSON.parse(row.document) as IncrementalObservationView
    },
  }
}
