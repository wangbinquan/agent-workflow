// RFC-353 T3 —— 测试用的 memory 成员关系写入面。
//
// `restoreSkillVersion` 现在把「把融进更高版本的记忆退回待用」这一半**注入**进来
// （PostgreSQL 侧一直如此，SQLite 侧此前是从 `@/services/memory` 直接 import）。
// 测试给的就是生产同一份实现，不是 stub——否则这些用例会退化成「只验技能版本、不验记忆状态」。

import { unfuseAboveVersionSync } from '../../src/modules/memory/infrastructure/sqliteMemoryMembershipParticipant'
import type { DbTxSync } from '../../src/db/txSync'

export const TEST_SKILL_RESTORE_MEMBERSHIP = Object.freeze({
  unfuseAboveVersion: (
    tx: DbTxSync,
    selector: { readonly skillId: string; readonly aboveVersion: number },
  ): string[] => unfuseAboveVersionSync(tx, selector),
})
