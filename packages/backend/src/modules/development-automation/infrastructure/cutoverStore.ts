// RFC-359 W4-B5 —— RFC-310 PR-9 的 CutoverStore：一份实现，两个 provider 共用。
//
// 状态落 maintenance_state（key 'rfc310-cutover-state'）：该表按 RFC-311 约定存「维护性水位与一次性闸门」，
// cutover phase 属后者；legacy link 落 legacy_code_work_item_links（migration 0177 就位的 cutover 台账表）。

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { parseCutoverState, type CutoverState } from '../domain/cutover'
import type { CutoverStore } from '../application/ports/cutoverStore'

export const CUTOVER_STATE_KEY = 'rfc310-cutover-state'

export function createCutoverStore(db: PersistenceDb): CutoverStore {
  return {
    async readState(): Promise<CutoverState> {
      const { maintenanceState } = tablesOf(db)
      const row = (
        await db
          .select({ value: maintenanceState.value })
          .from(maintenanceState)
          .where(eq(maintenanceState.key, CUTOVER_STATE_KEY))
          .limit(1)
      )[0]
      return parseCutoverState(row?.value ?? null)
    },
    async writeState(state, now) {
      const { maintenanceState } = tablesOf(db)
      await db
        .insert(maintenanceState)
        .values({ key: CUTOVER_STATE_KEY, value: JSON.stringify(state), updatedAt: now })
        .onConflictDoUpdate({
          target: maintenanceState.key,
          set: { value: JSON.stringify(state), updatedAt: now },
        })
    },
    async insertLegacyLink(input) {
      const { legacyCodeWorkItemLinks } = tablesOf(db)
      await insertOne(db, legacyCodeWorkItemLinks, {
        id: input.id,
        missionId: input.missionId,
        legacyWorkItemId: input.legacyWorkItemId,
        legacyRoundId: input.legacyRoundId,
        cutoverReceiptJson: input.cutoverReceiptJson,
        createdAt: input.now,
      })
    },
  }
}
