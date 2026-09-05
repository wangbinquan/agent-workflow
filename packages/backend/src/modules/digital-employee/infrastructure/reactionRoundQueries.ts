// RFC-317 T41（findings DE-02）—— `EmployeeReactionRoundQueryPort` 的实现；RFC-359 W4-B5 起一份实现两个 provider 共用。
//
// 这段查询此前住在 development-automation 的两个 composition 文件里，直接从
// `@/db/schema` 取 `employeeReactionRounds`。搬回本 context 之后：表与列只有 OS 知道，
// 「已结算」这个判据也只有一处（下面那个常量），而不是散在别人的 where 子句里。

import { and, eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { employeeReactionRounds } from '@/db/schema'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import type { EmployeeReactionRoundQueryPort } from '../public/types'

/**
 * 轮次的**已结算**态。单一事实源——此前 development-automation 的 where 子句里
 * 硬写着 `'completed'`，OS 一旦拆分结算态（比如加一个 `settled-with-warnings`），
 * 那处会静默漏掉新态，且没有任何测试指向原因。
 */
const SETTLED_ROUND_STATES = ['completed'] as const

export function createReactionRoundQueries(
  db: ProviderNeutralDatabase,
): EmployeeReactionRoundQueryPort {
  return Object.freeze({
    async frozenPlan(roundRef: string) {
      const row = (
        await db
          .select({
            caseId: employeeReactionRounds.caseId,
            planJson: employeeReactionRounds.planJson,
          })
          .from(employeeReactionRounds)
          .where(eq(employeeReactionRounds.id, roundRef))
          .limit(1)
      )[0]
      return row === undefined ? null : { caseId: row.caseId, planJson: row.planJson }
    },
    async lastSettledRound(input: { readonly caseId: string; readonly workItemRef: string }) {
      // 单值 union 用 inArray 会比 eq 慢且读起来更绕；这里保持 eq，但判据取自上面的
      // 常量——将来结算态变成多值时，改常量 + 这一处 where，别处无需跟进。
      // 最近结算的排最前；settled_at 为 NULL 的行两个引擎都排最后（SQLite 的缺省，PG 显式 nulls last）。
      const [settled] = SETTLED_ROUND_STATES
      const row = (
        await db
          .select({ id: employeeReactionRounds.id })
          .from(employeeReactionRounds)
          .where(
            and(
              eq(employeeReactionRounds.caseId, input.caseId),
              eq(employeeReactionRounds.workItemRef, input.workItemRef),
              eq(employeeReactionRounds.state, settled),
            ),
          )
          .orderBy(engineOf(db).descNullsLast(employeeReactionRounds.settledAt))
          .limit(1)
      )[0]
      return row === undefined ? null : { roundRef: row.id }
    },
  })
}
