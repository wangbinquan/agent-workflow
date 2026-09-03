// RFC-353 T3/T7 —— 测试用的回滚成员关系协调器。
//
// `restoreSkillVersion` 把「把融进更高版本的记忆退回待用」这一半**注入**进来
// （PostgreSQL 侧一直如此，SQLite 侧此前是从 `@/services/memory` 直接 import）。
// T7 之后注入的是 knowledge-evolution 铸的协调器：判据（退回哪些）归 KE，
// 写入归 memory，resource-catalog 只看到「给事务与回滚目标，还我 id」。
//
// 测试给的就是生产装配的同一份（`createSyncSkillRestoreMembership` + memory 的同步核心），
// 不是 stub——否则这些用例会退化成「只验技能版本、不验记忆状态」。

import { createSyncSkillRestoreMembership } from '../../src/modules/knowledge-evolution/public/participants'
import { unfuseAboveVersionSync } from '../../src/modules/memory/composition'
import type { DbTxSync } from '../../src/db/txSync'

export const TEST_SKILL_RESTORE_MEMBERSHIP = createSyncSkillRestoreMembership<DbTxSync>(
  (tx, selector) => unfuseAboveVersionSync(tx, selector),
)
