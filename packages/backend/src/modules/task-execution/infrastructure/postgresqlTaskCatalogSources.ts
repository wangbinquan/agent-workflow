// RFC-357 —— PostgreSQL 装配：造页查询，交给共用的目录源适配。
//
// 这个文件此前是 276 行的第二份实现：`listItems({ limit: 10_000 })` 把行全部拉进内存，
// 再在 JS 里做 source / statuses / origin / q 过滤、view 分流、排序、游标分页与 facets 计数。
// 它一次也没用上 PostgreSQL 上早就存在的物化列与索引（`branch_started_at` / `root_task_id`,
// `idx_tasks_branch_started_id`），而目录页对三个源各调一次——三次条件字节相同的全量查询，
// 结果三选一。现在全部交给与 SQLite 共用的下推查询。

import type { OwnerIdentityQueries } from '@/modules/identity-access/public/operations'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'

import type { TaskExecutionCatalogSourceFactory } from '../application/adapters/task-catalog-adapter'
import { createTaskExecutionCatalogSourceFactory } from './taskExecutionCatalogSources'
import { createPostgresqlTaskListPage } from './taskListPage'

export function createPostgresqlTaskExecutionCatalogSourceFactory(
  db: PostgresqlDatabaseClient,
  owners: OwnerIdentityQueries,
): TaskExecutionCatalogSourceFactory {
  return createTaskExecutionCatalogSourceFactory(createPostgresqlTaskListPage(db, owners))
}
