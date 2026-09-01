import { eq } from 'drizzle-orm'

import { legacyCodeWorkItemLinks, maintenanceState } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { CutoverStore } from '../application/ports/cutoverStore'
import { parseCutoverState } from '../domain/cutover'
import { CUTOVER_STATE_KEY } from './sqliteCutoverStore'

export function createPostgresqlCutoverStore(db: PostgresqlDatabaseClient): CutoverStore {
  return {
    async readState() {
      const row = await db
        .select({ value: maintenanceState.value })
        .from(maintenanceState)
        .where(eq(maintenanceState.key, CUTOVER_STATE_KEY))
        .limit(1)
        .get()
      return parseCutoverState(row?.value ?? null)
    },
    async writeState(state, now) {
      await db
        .insert(maintenanceState)
        .values({ key: CUTOVER_STATE_KEY, value: JSON.stringify(state), updatedAt: now })
        .onConflictDoUpdate({
          target: maintenanceState.key,
          set: { value: JSON.stringify(state), updatedAt: now },
        })
        .run()
    },
    async insertLegacyLink(input) {
      await db
        .insert(legacyCodeWorkItemLinks)
        .values({
          id: input.id,
          missionId: input.missionId,
          legacyWorkItemId: input.legacyWorkItemId,
          legacyRoundId: input.legacyRoundId,
          cutoverReceiptJson: input.cutoverReceiptJson,
          createdAt: input.now,
        })
        .run()
    },
  }
}
