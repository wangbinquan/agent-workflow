// RFC-359 W7 —— RFC-057 S3 修复的协作侧事实面（自澄清轮次的开启判定 / 最近一条封存轮次 / 重开）：
// 一份实现，两个 provider 共用。合一前的 `sqliteClarifyRepairParticipant.ts` /
// `postgresqlClarifyRepairParticipant.ts` 是**零功能分叉**——同一组 where 子句、同一段排序、
// 连下面那处「已被 inArray 排除的 awaiting_human 判断」都逐字复制了两遍。
//
// RFC-395 II-b: reopen 交给 answer-write port，在同一事务内锁 round、CAS 终态并清理答案行。
// 独立 attribution 与 draft 行继续保留；此处不再直接更新轮次 JSON 列。
//
// # 抽象层错位（本刀只记录，不动手）
//
// `ClarifyRepairParticipant` 这个端口**只有 PG 在消费**（`task-execution/composition/providerRuntime.ts`
// 装配进 `taskRouteRepairOperations`）。SQLite 侧的 S3 修复能力根本不走这个端口，而在
// `platform/persistence/sqlite/taskLifecycleRepair/options-S3.ts`（S3.resurrect-clarify-run，经
// `taskLifecycleRepair.ts` 注册），且比 participant 更全：带 preflight 复检、`setNodeRunStatus` /
// `setTaskStatus` 的生命周期 CAS 与 before/after 审计快照。合一只消掉了那份生产零调用方的重复实现，
// **没有**消掉错位本身：下一步应让 `options-S3.ts` 改为消费本端口，否则 SQLite 侧会永远保留第二份实现。

import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, desc, eq, inArray } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createClarifyAnswerWritePort } from './clarifyAnswerWrite'
import type { ClarifyRepairParticipant } from '../application/ports/clarifyRepairParticipant'

export function createClarifyRepairParticipant(db: PersistenceDb): ClarifyRepairParticipant {
  return Object.freeze({
    async hasOpenForNodeRun(input: Parameters<ClarifyRepairParticipant['hasOpenForNodeRun']>[0]) {
      const { clarifyRounds } = tablesOf(db)
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
      const { clarifyRounds } = tablesOf(db)
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
      return createClarifyAnswerWritePort(db).transition({
        ...input,
        kind: 'reopen',
        roundKind: 'self',
      })
    },
  })
}
