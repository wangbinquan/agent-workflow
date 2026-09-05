// RFC-357 / RFC-359 —— 把 provider 中立的页查询绑到任一数据库客户端上（此前 sqlite.ts / postgresql.ts 两份
// 只差客户端类型）。`owners` 是**注入**的，不在这里 compose：跨 bounded context 去取另一个模块的 provider
// 实现是 RFC-328 明令的债，正解是由装配根注入。

import type { ProviderNeutralDatabase } from '@/db/query'
import type { OwnerIdentityQueries } from '@/modules/identity-access/public/operations'
import { loadTaskFailureCodes } from '@/services/task'

import { createTaskListPage, type TaskListPage } from './page'

export function createDatabaseTaskListPage(
  db: ProviderNeutralDatabase,
  owners: OwnerIdentityQueries,
): TaskListPage {
  return createTaskListPage({
    db,
    owners,
    failureCodes: async (rows) => await loadTaskFailureCodes(db, rows),
  })
}
