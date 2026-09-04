// RFC-357 —— PostgreSQL 侧的装配：与 `sqlite.ts` 结构相同，只换客户端与 owner 实现。
//
// 页查询本身**一个字都不换**（`page.ts` / `query.ts` / `filters.ts` / `projection.ts` 与
// SQLite 共用同一份），依据逐条见 `db.ts` 的头注释。这里唯一 provider 特有的是：
//   · 客户端类型（`PostgresqlDatabaseClient`，本身就是 drizzle 的 sqlite-proxy）；
//   · owner 身份查询由装配根注入（同 `sqlite.ts` 的理由：模块内不去 compose 别的 context）。
//
// 失败码沿用与 SQLite 相同的**批量**实现——PostgreSQL 目录源此前是逐个失败任务发一次
// `SELECT … FROM node_runs`（N+1），这条依赖换成共享实现后一并消失。

import type { OwnerIdentityQueries } from '@/modules/identity-access/public/operations'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { loadTaskFailureCodes } from '@/services/task'

import { createTaskListPage, type TaskListPage } from './page'

export function createPostgresqlTaskListPage(
  db: PostgresqlDatabaseClient,
  owners: OwnerIdentityQueries,
): TaskListPage {
  return createTaskListPage({
    db,
    owners,
    failureCodes: async (rows) => await loadTaskFailureCodes(db, rows),
  })
}
