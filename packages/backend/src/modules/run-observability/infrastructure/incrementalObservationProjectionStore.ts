import { and, asc, eq, gt, isNull, ne } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  databaseSessionFor,
  engineOf,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import {
  observationProjectionBootstrap,
  observationProjectionChanges,
  observationProjectionComponents,
  observationProjectionCurrent,
  observationProjectionHeads,
  observationProjectionVersions,
  observationProjectionWork,
  observationProjectionWorkComponents,
} from '@/db/observationProjection'
import type {
  IncrementalObservationComponentSource,
  IncrementalObservationContribution,
  IncrementalObservationProjectionStore,
  IncrementalObservationProjectionTransaction,
  IncrementalObservationWork,
} from '../ports/incrementalObservationProjection'
import type { IncrementalObservationFold } from '../domain/incrementalObservationFold'
import { pendingIncrementalObservationWork } from './incrementalObservationWork'
import { retainIncrementalObservationVersion } from './incrementalObservationVersions'

const HEAD = 'incremental-20261012-v1'
const DOCUMENT_PACKET = 200

/** Source resolution and projection writes share the original MVCC transaction.
 * SERIALIZABLE is confined to this single consumer, whose reads include native
 * membership predicates; producers retain their original transaction mechanisms. */
export function createIncrementalObservationProjectionStore(
  db: ProviderNeutralDatabase,
  generation: string,
) {
  const readers = new WeakMap<IncrementalObservationProjectionTransaction, DatabaseTransaction>()
  const store: IncrementalObservationProjectionStore = {
    pending: (packetSize) => pendingIncrementalObservationWork(db, packetSize),
    change: (work) =>
      databaseSessionFor(db).serializable(async (reader) => {
        let ready = false
        async function coverage(item: IncrementalObservationWork) {
          const channels = await reader
            .select({ done: observationProjectionBootstrap.done })
            .from(observationProjectionBootstrap)
            .where(eq(observationProjectionBootstrap.generation, generation))
            .all()
          if (!channels.length || channels.some((row) => !row.done)) return false
          const pending = await reader
            .select({ id: observationProjectionWork.id })
            .from(observationProjectionWork)
            .where(
              and(
                isNull(observationProjectionWork.appliedRevision),
                ne(observationProjectionWork.id, item.id),
              ),
            )
            .limit(1)
            .get()
          const changes = await reader
            .select({ id: observationProjectionChanges.id })
            .from(observationProjectionChanges)
            .where(eq(observationProjectionChanges.completed, false))
            .limit(1)
            .get()
          return !pending && !changes
        }
        const tx: IncrementalObservationProjectionTransaction = {
          async head() {
            await reader
              .insert(observationProjectionHeads)
              .values({ id: HEAD, revision: '0', asOf: 0 })
              .onConflictDoNothing()
              .run()
            await engineOf(reader).lockAggregateRoot(
              reader,
              observationProjectionHeads,
              observationProjectionHeads.id,
              HEAD,
            )
            const head = (await reader
              .select()
              .from(observationProjectionHeads)
              .where(eq(observationProjectionHeads.id, HEAD))
              .get())!
            return { revision: head.revision, asOf: head.asOf }
          },
          async sourceUnchanged(item) {
            const original = await reader
              .select()
              .from(observationProjectionWork)
              .where(eq(observationProjectionWork.id, item.id))
              .get()
            const head = await reader
              .select({ revision: observationProjectionHeads.revision })
              .from(observationProjectionHeads)
              .where(eq(observationProjectionHeads.id, HEAD))
              .get()
            return (
              original?.completedRevision === null &&
              original.document === JSON.stringify(item) &&
              original.prepared !== null &&
              original.leaseToken === item.preparationToken &&
              original.leaseUntil > Date.now() &&
              head?.revision === item.baseRevision
            )
          },
          async *previous(item) {
            let after: string | undefined
            while (true) {
              const page = await reader
                .select({
                  key: observationProjectionCurrent.key,
                  document: observationProjectionCurrent.document,
                })
                .from(observationProjectionCurrent)
                .innerJoin(
                  observationProjectionWorkComponents,
                  eq(
                    observationProjectionWorkComponents.component,
                    observationProjectionCurrent.component,
                  ),
                )
                .where(
                  and(
                    eq(observationProjectionCurrent.kind, 'contribution'),
                    eq(observationProjectionWorkComponents.workId, item.id),
                    after === undefined ? undefined : gt(observationProjectionCurrent.key, after),
                  ),
                )
                .orderBy(asc(observationProjectionCurrent.key))
                .limit(DOCUMENT_PACKET)
                .all()
              if (!page.length) return
              for (const row of page)
                yield JSON.parse(row.document) as IncrementalObservationContribution
              const last = page.at(-1)!.key
              if (last === after)
                throw new Error('Incremental projection source cursor did not advance')
              after = last
            }
          },
          putContribution: (key, value, version) =>
            retainIncrementalObservationVersion(reader, {
              kind: 'contribution',
              key,
              component: value?.component ?? null,
              document: value,
              version,
            }),
          async aggregate(key) {
            const row = await reader
              .select({ document: observationProjectionCurrent.document })
              .from(observationProjectionCurrent)
              .where(
                and(
                  eq(observationProjectionCurrent.kind, 'aggregate'),
                  eq(observationProjectionCurrent.key, key),
                ),
              )
              .get()
            return row ? (JSON.parse(row.document) as IncrementalObservationFold) : null
          },
          putAggregate: (key, document, version) =>
            retainIncrementalObservationVersion(reader, {
              kind: 'aggregate',
              key,
              component: null,
              document,
              version,
            }),
          async coverageChanged(item) {
            ready = await coverage(item)
            const head = await reader
              .select()
              .from(observationProjectionHeads)
              .where(eq(observationProjectionHeads.id, HEAD))
              .get()
            const previous =
              head?.revision === '0'
                ? null
                : await reader
                    .select()
                    .from(observationProjectionVersions)
                    .where(eq(observationProjectionVersions.revision, head!.revision))
                    .get()
            // Readiness describes initial enumeration. Once all original facts
            // have been accounted for, normal queued updates do not erase data.
            ready ||= previous?.bootstrapComplete === true
            return (
              previous === null || previous === undefined || previous.bootstrapComplete !== ready
            )
          },
          async complete(item) {
            const head = await reader
              .select({ revision: observationProjectionHeads.revision })
              .from(observationProjectionHeads)
              .where(eq(observationProjectionHeads.id, HEAD))
              .get()
            for (const component of item.components)
              await reader
                .insert(observationProjectionComponents)
                .values({ component, revision: head!.revision })
                .onConflictDoUpdate({
                  target: observationProjectionComponents.component,
                  set: { revision: head!.revision },
                })
                .run()
            const current = await reader
              .select({ retryCount: observationProjectionWork.retryCount })
              .from(observationProjectionWork)
              .where(eq(observationProjectionWork.id, item.id))
              .get()
            const retries = (current?.retryCount ?? 0) + 1
            await reader
              .update(observationProjectionWork)
              .set({
                appliedRevision: head!.revision,
                completedRevision: item.retryNative ? null : head!.revision,
                retryCount: item.retryNative ? retries : 0,
                retryAt: item.retryNative
                  ? Date.now() + Math.min(60000, 1000 * 2 ** Math.min(retries, 6))
                  : 0,
                leaseToken: null,
                leaseUntil: 0,
                failure: null,
              })
              .where(eq(observationProjectionWork.id, item.id))
              .run()
          },
          async publish(version) {
            await reader
              .insert(observationProjectionVersions)
              .values({ ...version, bootstrapComplete: ready })
              .run()
            await reader
              .update(observationProjectionHeads)
              .set(version)
              .where(eq(observationProjectionHeads.id, HEAD))
              .run()
          },
        }
        readers.set(tx, reader)
        try {
          return await work(tx)
        } finally {
          readers.delete(tx)
        }
      }),
  }
  function source(
    resolve: (
      reader: DatabaseTransaction,
      work: IncrementalObservationWork,
    ) => AsyncIterable<IncrementalObservationContribution>,
  ): IncrementalObservationComponentSource {
    return {
      contributions(tx, work) {
        const reader = readers.get(tx)
        if (!reader) throw new Error('Original observation source transaction is unavailable')
        return resolve(reader, work)
      },
    }
  }
  return { store, source }
}
