// RFC-311 — typed access to the `maintenance_state` KV (migration 0180).
//
// Holds derivable-but-expensive maintenance watermarks and one-shot gates
// (events-archive high water, credentials-seal completion, …). Business state
// never lives here: dropping the whole table only sends the next maintenance
// pass down its slow full-rescan path.

// Shared persistence for durable maintenance watermarks on either database.

import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
export async function readMaintenanceValue(db: PersistenceDb, key: string): Promise<string | null> {
  const { maintenanceState } = tablesOf(db)
  const rows = await db
    .select({ value: maintenanceState.value })
    .from(maintenanceState)
    .where(eq(maintenanceState.key, key))
    .limit(1)
  return rows[0]?.value ?? null
}

export async function readMaintenanceNumber(
  db: PersistenceDb,
  key: string,
): Promise<number | null> {
  const raw = await readMaintenanceValue(db, key)
  if (raw === null) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

export async function writeMaintenanceValue(
  db: PersistenceDb,
  key: string,
  value: string,
  now: number = Date.now(),
): Promise<void> {
  const { maintenanceState } = tablesOf(db)
  await db
    .insert(maintenanceState)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({
      target: maintenanceState.key,
      set: { value, updatedAt: now },
    })
}
