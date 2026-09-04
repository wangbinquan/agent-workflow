// RFC-357 —— 测试侧保留 `listTaskOperationsPage(db, actor, raw, options)` 的旧调用形状。
//
// 生产代码里这条依赖由装配根注入（`server.ts` 把 identity-access 的
// `OwnerIdentityQueries` 传进 `composeTaskExecutionCatalogSources`）——模块自己去 compose
// 另一个 context 的 provider 是 RFC-328 精确判红的跨 context 桥。测试不在那份守卫的语料里，
// 这里就地组装即可，于是 29 个既有调用点一行都不用改。

import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { composeSqliteOwnerIdentityQueries } from '@/modules/identity-access/composition/providerOperations'
import {
  createSqliteTaskListPage,
  taskListViewerOf,
  type TaskOperationsPageOptions,
  type TaskOperationsRawQuery,
} from '@/modules/task-execution/infrastructure/taskListPage'
import type { TaskOperationsPage } from '@agent-workflow/shared'

export async function listTaskOperationsPage(
  db: DbClient,
  actor: Actor,
  rawQuery: TaskOperationsRawQuery,
  options: TaskOperationsPageOptions = {},
): Promise<TaskOperationsPage> {
  return await createSqliteTaskListPage(db, composeSqliteOwnerIdentityQueries(db)).list(
    taskListViewerOf(actor),
    rawQuery,
    options,
  )
}
