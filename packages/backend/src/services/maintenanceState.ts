// RFC-311 — typed access to the `maintenance_state` KV (migration 0180).
//
// Holds derivable-but-expensive maintenance watermarks and one-shot gates
// (events-archive high water, credentials-seal completion, …). Business state
// never lives here: dropping the whole table only sends the next maintenance
// pass down its slow full-rescan path.

import { eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { maintenanceState } from '@/db/schema'

export async function readMaintenanceValue(db: DbClient, key: string): Promise<string | null> {
  const rows = await db
    .select({ value: maintenanceState.value })
    .from(maintenanceState)
    .where(eq(maintenanceState.key, key))
    .limit(1)
  return rows[0]?.value ?? null
}

export async function readMaintenanceNumber(db: DbClient, key: string): Promise<number | null> {
  const raw = await readMaintenanceValue(db, key)
  if (raw === null) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

export async function writeMaintenanceValue(
  db: DbClient,
  key: string,
  value: string,
  now: number = Date.now(),
): Promise<void> {
  await db
    .insert(maintenanceState)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({
      target: maintenanceState.key,
      set: { value, updatedAt: now },
    })
}
