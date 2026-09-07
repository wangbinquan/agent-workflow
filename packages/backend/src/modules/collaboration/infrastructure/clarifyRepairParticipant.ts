// RFC-359 W7 —— RFC-057 S3 修复的协作侧事实面（自澄清轮次的开启判定 / 最近一条封存轮次 / 重开）：
// 一份实现，两个 provider 共用。合一前的 `sqliteClarifyRepairParticipant.ts` /
// `postgresqlClarifyRepairParticipant.ts` 是**零功能分叉**——同一组 where 子句、同一段排序、
// 连下面那处「已被 inArray 排除的 awaiting_human 判断」都逐字复制了两遍。
//
// # 事务包裹：单语句 CAS 不包（与 `reviewRepairParticipant` 取一致的形态）
//
// 合一前 `reopen` 在 PG 侧包了 `db.transaction`、SQLite 侧是裸 UPDATE；隔壁
// `reviewRepairParticipant` 的 `unapprove` 恰好反过来（SQLite 包、PG 裸）。同一类语句在两个端口
// 上给出相反的包裹选择，说明这些包裹是随手加的、没有语义依据。这里按语义统一裁定：`reopen` 是
// 单条带 `WHERE status=$expected` 的 CAS UPDATE，单语句在两个引擎上本来就是原子的——SQLite 的
// autocommit 给每条语句自带一笔事务；PG 客户端的 `withWriteFence`
// （`platform/persistence/postgresqlDatabaseClient.ts:136-163`）把每一条非事务写都放到独占连接上的
// BEGIN / …UPDATE… / COMMIT 里。再显式包一层只多一次写者租约和一对 BEGIN/COMMIT 往返，
// CAS 的判定结果一模一样，因此不包。
// （对照：`reviewRepairParticipant.completeApproved` 是「读判定 + 写两个端口」的读改写序列，
// 那一处**要**包，头注释同样写明了理由。）
//
// # 抽象层错位（本刀只记录，不动手）
//
// `ClarifyRepairParticipant` 这个端口**只有 PG 在消费**（`task-execution/composition/providerRuntime.ts`
// 装配进 `postgresqlTaskRouteRepairOperations`）。SQLite 侧的 S3 修复能力根本不走这个端口，而在
// `platform/persistence/sqlite/taskLifecycleRepair/options-S3.ts`（S3.resurrect-clarify-run，经
// `taskLifecycleRepair.ts` 注册），且比 participant 更全：带 preflight 复检、`setNodeRunStatus` /
// `setTaskStatus` 的生命周期 CAS 与 before/after 审计快照。合一只消掉了那份生产零调用方的重复实现，
// **没有**消掉错位本身：下一步应让 `options-S3.ts` 改为消费本端口，否则 SQLite 侧会永远保留第二份实现。

import { and, desc, eq, inArray } from 'drizzle-orm'

import { clarifyRounds } from '@/db/schema'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { ClarifyRepairParticipant } from '../application/ports/clarifyRepairParticipant'

export function createClarifyRepairParticipant(
  db: ProviderNeutralDatabase,
): ClarifyRepairParticipant {
  return Object.freeze({
    async hasOpenForNodeRun(input: Parameters<ClarifyRepairParticipant['hasOpenForNodeRun']>[0]) {
      const row = (
        await db
          .select({ id: clarifyRounds.id })
          .from(clarifyRounds)
          .where(
            and(
              eq(clarifyRounds.taskId, input.taskId),
              eq(clarifyRounds.kind, 'self'),
              eq(clarifyRounds.intermediaryNodeRunId, input.nodeRunId),
              eq(clarifyRounds.status, 'awaiting_human'),
            ),
          )
          .limit(1)
      )[0]
      return row !== undefined
    },
    async latestClosedForNodeRun(
      input: Parameters<ClarifyRepairParticipant['latestClosedForNodeRun']>[0],
    ) {
      const row = (
        await db
          .select({ roundId: clarifyRounds.id, status: clarifyRounds.status })
          .from(clarifyRounds)
          .where(
            and(
              eq(clarifyRounds.taskId, input.taskId),
              eq(clarifyRounds.kind, 'self'),
              eq(clarifyRounds.intermediaryNodeRunId, input.nodeRunId),
              inArray(clarifyRounds.status, ['answered', 'canceled', 'abandoned']),
            ),
          )
          .orderBy(desc(clarifyRounds.createdAt), desc(clarifyRounds.id))
          .limit(1)
      )[0]
      // `awaiting_human` 这一支运行期不可达（上面的 inArray 已排除它），留着是把列的四值枚举
      // 收窄到端口声明的三值封存态；删掉它类型就对不上。合一前两侧逐字复制了这处判断。
      if (row === undefined || row.status === 'awaiting_human') return null
      return { roundId: row.roundId, status: row.status }
    },
    async reopen(input: Parameters<ClarifyRepairParticipant['reopen']>[0]) {
      const changed = await db
        .update(clarifyRounds)
        .set({ status: 'awaiting_human', answersJson: null, answeredAt: null })
        .where(
          and(
            eq(clarifyRounds.id, input.roundId),
            eq(clarifyRounds.taskId, input.taskId),
            eq(clarifyRounds.kind, 'self'),
            eq(clarifyRounds.status, input.expectedStatus),
          ),
        )
        .returning({ id: clarifyRounds.id })
      return changed.length === 1
    },
  })
}
