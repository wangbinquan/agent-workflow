import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  databaseSessionFor,
  engineOf,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import {
  observationProjectionPrepared,
  observationProjectionWork,
  observationProjectionWorkComponents,
} from '@/db/observationProjection'
import type {
  IncrementalObservationContribution,
  IncrementalObservationWork,
} from '../ports/incrementalObservationProjection'
import type { QualifiedObservationPrepared } from '../ports/incrementalObservationQualified'

const digestRow = (hash: ReturnType<typeof createHash>, key: string, document: string) =>
  hash.update(JSON.stringify([key, document]) + '\n')
const LEASE_MS = 30 * 60 * 1000
async function owned(tx: DatabaseTransaction, work: IncrementalObservationWork) {
  const row = await tx
    .select()
    .from(observationProjectionWork)
    .where(eq(observationProjectionWork.id, work.id))
    .get()
  if (
    !work.preparationToken ||
    row?.leaseToken !== work.preparationToken ||
    row.completedRevision !== null ||
    row.leaseUntil <= Date.now()
  )
    throw new Error('Observation preparation lease changed')
}
export function incrementalObservationPreparedStore(db: ProviderNeutralDatabase) {
  return {
    async begin(work: IncrementalObservationWork) {
      const claimed = { ...work, preparationToken: crypto.randomUUID() }
      await databaseSessionFor(db).transaction(async (tx) => {
        await engineOf(tx).lockAggregateRoot(
          tx,
          observationProjectionWork,
          observationProjectionWork.id,
          work.id,
        )
        const current = await tx
          .select()
          .from(observationProjectionWork)
          .where(eq(observationProjectionWork.id, work.id))
          .get()
        if (!current || current.completedRevision !== null || current.leaseUntil > Date.now())
          throw new Error('Observation work is already claimed or completed')
        await tx
          .update(observationProjectionWork)
          .set({
            document: JSON.stringify(claimed),
            prepared: null,
            leaseToken: claimed.preparationToken,
            leaseUntil: Date.now() + LEASE_MS,
          })
          .where(eq(observationProjectionWork.id, work.id))
          .run()
        await tx
          .delete(observationProjectionPrepared)
          .where(eq(observationProjectionPrepared.workId, work.id))
          .run()
      })
      return claimed
    },
    async renew(work: IncrementalObservationWork) {
      await databaseSessionFor(db).transaction(async (tx) => {
        await owned(tx, work)
        await tx
          .update(observationProjectionWork)
          .set({ leaseUntil: Date.now() + LEASE_MS })
          .where(
            and(
              eq(observationProjectionWork.id, work.id),
              eq(observationProjectionWork.leaseToken, work.preparationToken!),
            ),
          )
          .run()
      })
    },
    async releaseFailed(work: IncrementalObservationWork, error: unknown) {
      await db
        .update(observationProjectionWork)
        .set({
          leaseToken: null,
          leaseUntil: 0,
          retryAt: Date.now() + 1000,
          failure: error instanceof Error ? error.message : String(error),
        })
        .where(
          and(
            eq(observationProjectionWork.id, work.id),
            eq(observationProjectionWork.leaseToken, work.preparationToken!),
            isNull(observationProjectionWork.completedRevision),
          ),
        )
        .run()
    },
    async append(
      work: IncrementalObservationWork,
      rows: readonly IncrementalObservationContribution[],
    ) {
      for (let at = 0; at < rows.length; at += 150)
        await databaseSessionFor(db).transaction(async (tx) => {
          await owned(tx, work)
          const packet = rows.slice(at, at + 150),
            unique = new Map<string, string>()
          for (const row of packet) {
            const document = JSON.stringify(row),
              previous = unique.get(row.key)
            if (previous !== undefined && previous !== document)
              throw new Error('Conflicting qualified observation contribution identity')
            unique.set(row.key, document)
          }
          const existing = await tx
            .select()
            .from(observationProjectionPrepared)
            .where(
              and(
                eq(observationProjectionPrepared.workId, work.id),
                inArray(observationProjectionPrepared.key, [...unique.keys()]),
              ),
            )
            .all()
          for (const row of existing) {
            if (unique.get(row.key) !== row.document)
              throw new Error('Conflicting qualified observation contribution identity')
            unique.delete(row.key)
          }
          if (unique.size)
            await tx
              .insert(observationProjectionPrepared)
              .values([...unique].map(([key, document]) => ({ workId: work.id, key, document })))
              .run()
        })
    },
    async seal(
      work: IncrementalObservationWork,
      identity: Omit<QualifiedObservationPrepared, 'rows' | 'digest'>,
      components: readonly string[],
    ) {
      const next = {
        ...work,
        baseRevision: identity.baseRevision,
        asOf: identity.asOf,
        components: [...new Set([...work.components, ...components])].sort(),
      }
      return databaseSessionFor(db).transaction(async (tx) => {
        await owned(tx, work)
        const hash = createHash('sha256')
        let rows = 0n,
          after: string | undefined
        for (;;) {
          const packet = await tx
            .select()
            .from(observationProjectionPrepared)
            .where(
              and(
                eq(observationProjectionPrepared.workId, work.id),
                after === undefined ? undefined : gt(observationProjectionPrepared.key, after),
              ),
            )
            .orderBy(asc(observationProjectionPrepared.key))
            .limit(200)
            .all()
          if (!packet.length) break
          for (const row of packet) {
            digestRow(hash, row.key, row.document)
            rows++
          }
          after = packet.at(-1)!.key
        }
        for (let at = 0; at < next.components.length; at += 200)
          await tx
            .insert(observationProjectionWorkComponents)
            .values(
              next.components
                .slice(at, at + 200)
                .map((component) => ({ workId: work.id, component })),
            )
            .onConflictDoNothing()
            .run()
        await tx
          .update(observationProjectionWork)
          .set({
            document: JSON.stringify(next),
            prepared: JSON.stringify({
              ...identity,
              rows: String(rows),
              digest: hash.digest('hex'),
            }),
          })
          .where(eq(observationProjectionWork.id, work.id))
          .run()
        return next
      })
    },
  }
}
/** Only a sealed complete preparation can withdraw an old tail. Staging
 * failure leaves the work pending and the published version untouched. */
export async function* preparedObservationContributions(
  tx: DatabaseTransaction,
  work: IncrementalObservationWork,
): AsyncIterable<IncrementalObservationContribution> {
  const row = await tx
    .select({ prepared: observationProjectionWork.prepared })
    .from(observationProjectionWork)
    .where(eq(observationProjectionWork.id, work.id))
    .get()
  if (!row?.prepared) throw new Error('Observation component preparation has not reached EOF')
  const seal = JSON.parse(row.prepared) as QualifiedObservationPrepared,
    hash = createHash('sha256')
  if (
    seal.preparationToken !== work.preparationToken ||
    seal.baseRevision !== work.baseRevision ||
    seal.asOf !== work.asOf ||
    !seal.generation ||
    !seal.snapshotId
  )
    throw new Error('Observation preparation seal changed identity')
  let seen = 0n,
    after: string | undefined
  for (;;) {
    const page = await tx
      .select()
      .from(observationProjectionPrepared)
      .where(
        and(
          eq(observationProjectionPrepared.workId, work.id),
          after === undefined ? undefined : gt(observationProjectionPrepared.key, after),
        ),
      )
      .orderBy(asc(observationProjectionPrepared.key))
      .limit(200)
      .all()
    if (!page.length) break
    for (const item of page) {
      digestRow(hash, item.key, item.document)
      seen++
      yield JSON.parse(item.document) as IncrementalObservationContribution
    }
    after = page.at(-1)!.key
  }
  if (String(seen) !== seal.rows || hash.digest('hex') !== seal.digest)
    throw new Error('Observation component preparation EOF changed')
}
