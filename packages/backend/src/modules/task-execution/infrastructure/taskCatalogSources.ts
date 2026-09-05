// RFC-357 / RFC-359 —— 任务目录源装配：造页查询，交给共用的目录源适配（`taskExecutionCatalogSources.ts`）。
// 此前 sqlite / postgresql 两份薄壳只差客户端类型；目录源的适配逻辑一个字都不在这里。

import type { ProviderNeutralDatabase } from '@/db/query'
import type { OwnerIdentityQueries } from '@/modules/identity-access/public/operations'
import type { TaskCatalogSource } from '@/modules/task-catalog/composition/required-ports'

import {
  composeTaskExecutionCatalogSources as composeSources,
  type TaskExecutionCatalogSourceFactory,
} from '../application/adapters/task-catalog-adapter'
import { createTaskExecutionCatalogSourceFactory } from './taskExecutionCatalogSources'
import { createDatabaseTaskListPage } from './taskListPage'

export function createDatabaseTaskExecutionCatalogSourceFactory(
  db: ProviderNeutralDatabase,
  owners: OwnerIdentityQueries,
): TaskExecutionCatalogSourceFactory {
  return createTaskExecutionCatalogSourceFactory(createDatabaseTaskListPage(db, owners))
}

export function composeTaskExecutionCatalogSources(
  db: ProviderNeutralDatabase,
  owners: OwnerIdentityQueries,
): TaskCatalogSource[] {
  return composeSources(createDatabaseTaskExecutionCatalogSourceFactory(db, owners))
}
