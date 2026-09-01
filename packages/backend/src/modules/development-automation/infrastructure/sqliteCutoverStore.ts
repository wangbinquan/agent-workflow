// RFC-310 PR-9 —— CutoverStore 的 sqlite 实现。
//
// 状态落 maintenance_state（key 'rfc310-cutover-state'）：该表按 RFC-311 约定
// 存「维护性水位与一次性闸门」，cutover phase 属后者；legacy link 落
// legacy_code_work_item_links（migration 0177 就位的 cutover 台账表）。

import { eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { legacyCodeWorkItemLinks, maintenanceState } from '@/db/schema'
import { parseCutoverState, type CutoverState } from '../domain/cutover'
import type { CutoverStore } from '../application/ports/cutoverStore'

export const CUTOVER_STATE_KEY = 'rfc310-cutover-state'

export function createSqliteCutoverStore(db: DbClient): CutoverStore {
  return {
    async readState(): Promise<CutoverState> {
      const row = db
        .select({ value: maintenanceState.value })
        .from(maintenanceState)
        .where(eq(maintenanceState.key, CUTOVER_STATE_KEY))
        .get()
      return parseCutoverState(row?.value ?? null)
    },
    async writeState(state, now) {
      db.insert(maintenanceState)
        .values({ key: CUTOVER_STATE_KEY, value: JSON.stringify(state), updatedAt: now })
        .onConflictDoUpdate({
          target: maintenanceState.key,
          set: { value: JSON.stringify(state), updatedAt: now },
        })
        .run()
    },
    async insertLegacyLink(input) {
      db.insert(legacyCodeWorkItemLinks)
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
