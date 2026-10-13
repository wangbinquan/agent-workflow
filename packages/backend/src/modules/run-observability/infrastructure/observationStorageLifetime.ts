import { and, eq, sql } from 'drizzle-orm'
import { observationReportLeases, observationStorageState } from '@/db/observationStorage'
import { observationProjectionViews } from '@/db/observationProjection'
import { observationReports } from '@/db/observationReports'
import { engineOf, type DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
export const observationStorageLock = 'observation-storage-lifecycle'
export const observationReportIdleMs = 7 * 86400000
/** Called inside the same transaction as choosing/registering/renewing/reclaiming a version. */
export async function admitObservationStorage(tx: DatabaseTransaction) {
  await engineOf(tx).advisoryLock(tx, observationStorageLock)
  if (
    await tx
      .select()
      .from(observationStorageState)
      .where(eq(observationStorageState.key, 'initialized'))
      .get()
  )
    return
  const grace = Date.now() + observationReportIdleMs
  await tx.run(
    sql`INSERT INTO ${observationReportLeases}(id,kind,revision,expires_at,retiring) SELECT id,'projection',json_extract(document,'$.version.revision'),${grace},false FROM ${observationProjectionViews} WHERE true ON CONFLICT(id) DO NOTHING`,
  )
  await tx.run(
    sql`INSERT INTO ${observationReportLeases}(id,kind,expires_at,retiring) SELECT id,'legacy',${grace},false FROM ${observationReports} WHERE true ON CONFLICT(id) DO NOTHING`,
  )
  await tx
    .insert(observationStorageState)
    .values({ key: 'initialized', document: JSON.stringify({ at: Date.now() }) })
    .onConflictDoNothing()
    .run()
}
export async function renewObservationView(
  tx: DatabaseTransaction,
  id: string,
  kind: string,
  revision?: string,
) {
  const lease = await tx
    .select()
    .from(observationReportLeases)
    .where(eq(observationReportLeases.id, id))
    .get()
  if (lease?.retiring) return false
  await tx
    .insert(observationReportLeases)
    .values({
      id,
      kind,
      revision: revision ?? null,
      expiresAt: Date.now() + observationReportIdleMs,
    })
    .onConflictDoUpdate({
      target: observationReportLeases.id,
      set: {
        expiresAt: Date.now() + observationReportIdleMs,
        ...(revision === undefined ? {} : { revision }),
      },
      where: eq(observationReportLeases.retiring, false),
    })
    .run()
  return true
}
export async function observationViewAlive(tx: DatabaseTransaction, id: string) {
  return !!(await tx
    .select({ id: observationReportLeases.id })
    .from(observationReportLeases)
    .where(and(eq(observationReportLeases.id, id), eq(observationReportLeases.retiring, false)))
    .get())
}
