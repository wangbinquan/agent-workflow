import { and, asc, eq, isNull, lte } from 'drizzle-orm'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import { databaseTransactionIsActive } from '@/platform/persistence/databaseTransaction'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  observationProjectionWork,
  observationProjectionWorkComponents,
} from '@/db/observationProjection'
import { sha256Hex } from '@/util/hash'
import type { IncrementalObservationWork } from '../ports/incrementalObservationProjection'

/** Call with the producer's original transaction. A process notification is not
 * the queue and cannot replace this durable source/derived handoff. */
export async function enqueueIncrementalObservationWork(
  tx: DatabaseTransaction,
  work: IncrementalObservationWork,
) {
  if (!databaseTransactionIsActive(tx))
    throw new Error('Observation work requires its original source transaction')
  if (
    !work.id ||
    !work.source ||
    !work.revision ||
    !work.components.length ||
    work.components.some((key) => !key) ||
    new Set(work.components).size !== work.components.length
  )
    throw new Error('Invalid incremental observation work')
  const document = JSON.stringify(work),
    fingerprint = sha256Hex(document)
  const existing = await tx
    .select({ fingerprint: observationProjectionWork.fingerprint })
    .from(observationProjectionWork)
    .where(eq(observationProjectionWork.id, work.id))
    .get()
  if (existing) {
    if (existing.fingerprint !== fingerprint)
      throw new Error('Conflicting incremental observation source event')
    return
  }
  await tx.insert(observationProjectionWork).values({ id: work.id, document, fingerprint }).run()
  // Each insertion packet bounds SQL parameters, never the connected population.
  for (let at = 0; at < work.components.length; at += 200)
    await tx
      .insert(observationProjectionWorkComponents)
      .values(
        work.components.slice(at, at + 200).map((component) => ({ workId: work.id, component })),
      )
      .run()
}
export async function pendingIncrementalObservationWork(
  db: ProviderNeutralDatabase,
  packetSize: number,
) {
  if (!Number.isSafeInteger(packetSize) || packetSize < 1)
    throw new RangeError('Invalid observation work packet size')
  const rows = await db
    .select({ document: observationProjectionWork.document })
    .from(observationProjectionWork)
    .where(
      and(
        isNull(observationProjectionWork.completedRevision),
        lte(observationProjectionWork.retryAt, Date.now()),
        lte(observationProjectionWork.leaseUntil, Date.now()),
      ),
    )
    .orderBy(asc(observationProjectionWork.retryAt), asc(observationProjectionWork.id))
    .limit(packetSize)
    .all()
  return rows.map((row) => JSON.parse(row.document) as IncrementalObservationWork)
}
export async function deferIncrementalObservationWork(
  db: ProviderNeutralDatabase,
  work: IncrementalObservationWork,
  error: unknown,
) {
  await db
    .update(observationProjectionWork)
    .set({
      retryAt: Date.now() + 1000,
      failure: error instanceof Error ? error.message : String(error),
      leaseToken: null,
      leaseUntil: 0,
    })
    .where(
      and(
        eq(observationProjectionWork.id, work.id),
        isNull(observationProjectionWork.completedRevision),
        work.preparationToken === undefined
          ? isNull(observationProjectionWork.leaseToken)
          : eq(observationProjectionWork.leaseToken, work.preparationToken),
      ),
    )
    .run()
}
