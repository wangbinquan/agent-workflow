// RFC-349 — provider-owned proof used before filesystem plugin-generation GC.
// The maintenance application receives only a closed clear/busy answer; neither
// database client nor task rows cross this infrastructure boundary.
//
// RFC-359 W11 —— **一份实现，两个引擎**。此前这里是两份：SQLite 半边裸写
// `FROM node_runs INDEXED BY idx_node_runs_status_active` 的 raw SQL，PostgreSQL 半边走查询
// 构造器。同一个存在性探针两份渲染，改一处不会红另一处，而两侧的判据（可取消状态集）本来
// 就该是同一个。索引提示是它们唯一真正的差异，能力矩阵的 `indexHint()` 正是为它而存在：
// SQLite 渲染 `INDEXED BY "<index>"`，PostgreSQL 渲染空（planner 自选，没有对应语法）。
//
// 为什么 SQLite 侧必须钉住索引：满量的维护语料里有数百万条**终态** node run，而 IN 列表覆盖
// 了枚举里的大多数值，ANALYZE 之后 SQLite 会改选整表扫——即使活跃行一条都没有。判据（覆盖
// 索引仍被选中）在 `tests/rfc359-w11-dialect-ledger-conformance.test.ts` 里两个引擎各跑一遍。

import { CANCELABLE_TASK_STATUSES } from '@agent-workflow/shared'
import { sql } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns } from '@/db/schema'
import { engineOf } from './databaseTransaction'

export type MaintenanceExecutionFence = () => Promise<'clear' | 'busy'>

export function createMaintenanceExecutionFence(
  db: ProviderNeutralDatabase,
): MaintenanceExecutionFence {
  return async () => {
    const statuses = sql.join(
      CANCELABLE_TASK_STATUSES.map((status) => sql`${status}`),
      sql`, `,
    )
    const active = await db.all<{ readonly present: number }>(sql`
      SELECT 1 AS present
      FROM ${nodeRuns} ${engineOf(db).indexHint('idx_node_runs_status_active')}
      WHERE ${nodeRuns.status} IN (${statuses})
      LIMIT 1
    `)
    return active.length === 0 ? 'clear' : 'busy'
  }
}
