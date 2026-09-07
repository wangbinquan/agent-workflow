// RFC-359 W9 —— `/health` 的库读投影：一份实现，两个 provider 共用。
//
// 合一前是 `platform/persistence/sqlite/systemHealthReadModel.ts`(21 行) /
// `modules/system-operations/infrastructure/postgresqlHealthReadModel.ts`(21 行) 两份，
// 而它们是同一条查询——「tasks 里状态是 running 的有几行」。**零机制差异**：
// 没有事务、没有方言函数、没有 provider 专属的表或列。全文差异只有三处，全部是写法：
//
//   · `count()`（drizzle 的聚合，自带 `.mapWith(Number)`）vs 手写 `sql\`count(*)\``；
//   · `where(sql\`status = 'running'\`)` 两侧都是**裸 SQL 片段**——现改成
//     `eq(tasks.status, 'running')`，列名不再靠字符串对齐 `db/schema.ts`；
//   · SQLite 侧把表钉成 `concreteDatabaseTable(tasks, 'sqlite')`。那是全仓唯一一处
//     **adapter 里**的投影钉死（另一处在 `schemaContract.ts`，那里是要产出 SQLite 规范
//     DDL，是设计）。它保护的是「进程级投影是 postgresql、手里却是 SQLite 客户端」这种
//     组合，可那种进程里同一个 server 的**每一条**业务查询都会一起坏——钉死一条 count
//     救不了任何人，只会让这份 adapter 与其余全部 adapter（`resourceLimitPersistence.ts`
//     等）不同形。这里跟随全仓惯例用 facade 表 `tasks`。
//
// 数值列陷阱：PG 驱动把 `count(*)` 交回**字符串**。`count()` 自带 `mapWith(Number)`，
// 外面再兜一层 `Number(...)`——端口契约是 number，不是 `"2"`。

import { count, eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { tasks } from '@/db/schema'
import type { HealthDatabaseReadModel } from '../public/queries'

/**
 * 健康检查的库读投影。库被锁住 / 正在迁移时的降级由路由自己的 fail-soft 存活策略处理，
 * 不在这里吞掉 provider 错误。
 */
export function createHealthDatabaseReadModel(
  db: ProviderNeutralDatabase,
): HealthDatabaseReadModel {
  return Object.freeze({
    async countRunningTasks() {
      const rows = await db
        .select({ n: count() })
        .from(tasks)
        .where(eq(tasks.status, 'running'))
        .all()
      return Number(rows[0]?.n ?? 0)
    },
  })
}
