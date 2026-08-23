// RFC-317 T41（findings DE-02）—— `EmployeeReactionRoundQueryPort` 的 SQLite 实现。
//
// 这段查询此前住在 development-automation 的两个 composition 文件里，直接从
// `@/db/schema` 取 `employeeReactionRounds`。搬回本 context 之后：表与列只有 OS 知道，
// 「已结算」这个判据也只有一处（下面那个常量），而不是散在别人的 where 子句里。

import { and, desc, eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { employeeReactionRounds } from '@/db/schema'
import type { EmployeeReactionRoundQueryPort } from '../public/types'

/**
 * 轮次的**已结算**态。单一事实源——此前 development-automation 的 where 子句里
 * 硬写着 `'completed'`，OS 一旦拆分结算态（比如加一个 `settled-with-warnings`），
 * 那处会静默漏掉新态，且没有任何测试指向原因。
 */
const SETTLED_ROUND_STATES = ['completed'] as const

export function createSqliteReactionRoundQueries(db: DbClient): EmployeeReactionRoundQueryPort {
  return {
    frozenPlan(roundRef) {
      const row = db
        .select({
          caseId: employeeReactionRounds.caseId,
          planJson: employeeReactionRounds.planJson,
        })
        .from(employeeReactionRounds)
        .where(eq(employeeReactionRounds.id, roundRef))
        .get()
      return row === undefined ? null : { caseId: row.caseId, planJson: row.planJson }
    },

    lastSettledRound({ caseId, workItemRef }) {
      // 单值 union 用 inArray 会比 eq 慢且读起来更绕；这里保持 eq，但判据取自上面的
      // 常量——将来结算态变成多值时，改常量 + 这一处 where，别处无需跟进。
      const [settled] = SETTLED_ROUND_STATES
      const row = db
        .select({ id: employeeReactionRounds.id })
        .from(employeeReactionRounds)
        .where(
          and(
            eq(employeeReactionRounds.caseId, caseId),
            eq(employeeReactionRounds.workItemRef, workItemRef),
            eq(employeeReactionRounds.state, settled),
          ),
        )
        .orderBy(desc(employeeReactionRounds.settledAt))
        .get()
      return row === undefined ? null : { roundRef: row.id }
    },
  }
}
