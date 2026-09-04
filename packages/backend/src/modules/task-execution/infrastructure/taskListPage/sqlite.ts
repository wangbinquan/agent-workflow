// RFC-357 —— SQLite 侧的装配：把 provider 中立的页查询绑到 bun:sqlite 客户端上。
//
// `owners` 是**注入**的，不在这里 compose：跨 bounded context 去取另一个模块的 provider
// 实现是 RFC-328 明令的债（`CROSS_CONTEXT_PROVIDER_BRIDGE_DEBT` 是一份精确清单，新边一律
// 判红）。搬进模块之前这条依赖藏在 `services/ownerIdentity.ts` 的 legacy facade 后面，
// 守卫看不见；搬进来之后它现形，正解是由**装配根**（`server.ts`）注入。
//
// PostgreSQL 侧的孪生装配在 `postgresql.ts`（RFC-357 PR-3）。

import type { DbClient } from '@/db/client'
import type { OwnerIdentityQueries } from '@/modules/identity-access/public/operations'
import { loadTaskFailureCodes } from '@/services/task'

import { createTaskListPage, type TaskListPage } from './page'

export function createSqliteTaskListPage(db: DbClient, owners: OwnerIdentityQueries): TaskListPage {
  return createTaskListPage({
    db,
    owners,
    failureCodes: async (rows) => await loadTaskFailureCodes(db, rows),
  })
}
