// RFC-359 W7 —— 资源上限（时长 / token）的持久化实现：一份实现，两个 provider 共用。
//
// 合一前是 `sqliteResourceLimitPersistence.ts`(109 行) / `postgresqlResourceLimitPersistence.ts`(110 行)
// 两份，**全文差异只有 4 类**：db 客户端类型、类名、`await` 位置，以及唯一一处可见 delta——
// logger 名（`'sqlite-resource-limits'` / `'postgresql-resource-limits'`，只用于
// `recordLimitCancellation` 的降级告警文案，全仓无断言）。零校验差、零幂等差、零状态转移差。
//
// 可以合成一份的判据与 `taskIdleTimeoutPersistence.ts`（RFC-350 / W4-B1）同款：本 adapter
// 只有纯读 + 两条单语句写，**没有事务**——SQLite 的 `dbTxSync` 与 PostgreSQL 的异步事务那道
// 真正的分歧在这里不存在；`DbClient` 与 `PostgresqlDatabaseClient` 都是 drizzle 的
// `BaseSQLiteDatabase`，同一套 query builder 在 `await` 下两个引擎行为一致（`await` 一个
// 同步 builder 的结果就是它自己）。抄成两份只会制造漂移。
//
// 两条写点各自的门都在 SQL 里，不靠调用方：
//   · `writeLimitReason` 只覆盖**已经落进 canceled** 的行的终态原因文案（`error_summary` /
//     `error_message`），`WHERE status='canceled'` 抢不到就是空操作，**不翻状态**
//     （与 `taskIdleTimeoutPersistence.ts` 的同名写点完全同形）。
//   · `recordLimitCancellation` 是纯审计追加，失败只降级告警——审计写不进去不该把
//     取消动作本身拖红。
//
// 聚合列 `sum(tok_total)` 的跨 provider 解码交给端口里的 `decodeResourceLimitTokenTotal`
// （PG 驱动把 bigint 聚合交回字符串，SQLite 交回 number）。

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns, recoveryEvents, tasks } from '@/db/schema'
import { bumpRecoveryCounter } from '@/services/recovery'
import { createLogger } from '@/util/log'
import {
  decodeResourceLimitTokenTotal,
  type ResourceLimitCancellationAudit,
  type ResourceLimitCallRow,
  type ResourceLimitPersistence,
  type ResourceLimitTask,
  type ResourceLimitTaskClock,
} from '../application/ports/resourceLimitPersistence'

const log = createLogger('resource-limits')

export class DrizzleResourceLimitPersistence implements ResourceLimitPersistence {
  constructor(private readonly db: ProviderNeutralDatabase) {}

  async listRunningTasks(): Promise<ReadonlyArray<ResourceLimitTask>> {
    return await this.db
      .select({
        id: tasks.id,
        maxDurationMs: tasks.maxDurationMs,
        maxTotalTokens: tasks.maxTotalTokens,
        runningMs: tasks.runningMs,
        runningSince: tasks.runningSince,
      })
      .from(tasks)
      .where(eq(tasks.status, 'running'))
      .all()
  }

  async listCallRows(taskId: string): Promise<ReadonlyArray<ResourceLimitCallRow>> {
    return await this.db
      .select({
        childTaskId: nodeRuns.childTaskId,
        wrapperProgressJson: nodeRuns.wrapperProgressJson,
      })
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), isNotNull(nodeRuns.childTaskId)))
      .all()
  }

  async listTaskStatuses(taskIds: readonly string[]): Promise<ReadonlyArray<string>> {
    if (taskIds.length === 0) return []
    return (
      await this.db
        .select({ status: tasks.status })
        .from(tasks)
        .where(inArray(tasks.id, [...taskIds]))
        .all()
    ).map((row) => row.status)
  }

  async sumTaskTokens(taskId: string): Promise<number> {
    const rows = await this.db
      .select({ total: sql<number | null>`sum(${nodeRuns.tokTotal})` })
      .from(nodeRuns)
      .where(eq(nodeRuns.taskId, taskId))
      .all()
    return decodeResourceLimitTokenTotal(rows[0]?.total)
  }

  async readTaskClock(taskId: string): Promise<ResourceLimitTaskClock | null> {
    return (
      (await this.db
        .select({ runningMs: tasks.runningMs, runningSince: tasks.runningSince })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .get()) ?? null
    )
  }

  async writeLimitReason(input: {
    readonly taskId: string
    readonly summary: string
    readonly message: string
  }): Promise<void> {
    await this.db
      .update(tasks)
      .set({ errorSummary: input.summary, errorMessage: input.message })
      .where(and(eq(tasks.id, input.taskId), eq(tasks.status, 'canceled')))
      .run()
  }

  async recordLimitCancellation(input: ResourceLimitCancellationAudit): Promise<void> {
    bumpRecoveryCounter('limit-cancel')
    try {
      await this.db
        .insert(recoveryEvents)
        .values({
          id: ulid(),
          taskId: input.taskId,
          nodeRunId: null,
          actor: 'system',
          kind: 'limit-cancel',
          reason: input.reason,
          beforeJson: JSON.stringify({ status: 'running' }),
          afterJson: JSON.stringify({ status: 'canceled' }),
          createdAt: input.now,
        })
        .run()
    } catch (error) {
      log.warn('resource-limit recovery audit dropped', { error: String(error) })
    }
  }
}
