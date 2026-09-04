// RFC-357 —— SQLite 装配：造页查询，交给共用的目录源适配（`taskExecutionCatalogSources.ts`）。
// 目录源的适配逻辑一个字都不在这里，两个 provider 共用同一份。

import type { DbClient } from '@/db/client'
import type { OwnerIdentityQueries } from '@/modules/identity-access/public/operations'
import type { TaskCatalogSource } from '@/modules/task-catalog/composition/required-ports'

import { composeTaskExecutionCatalogSources as composeSources } from '../application/adapters/task-catalog-adapter'
import { createTaskExecutionCatalogSourceFactory } from './taskExecutionCatalogSources'
import { createSqliteTaskListPage } from './taskListPage'

export function composeTaskExecutionCatalogSources(
  db: DbClient,
  owners: OwnerIdentityQueries,
): TaskCatalogSource[] {
  return composeSources(
    createTaskExecutionCatalogSourceFactory(createSqliteTaskListPage(db, owners)),
  )
}
