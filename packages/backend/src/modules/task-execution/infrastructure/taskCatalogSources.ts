// RFC-357 / RFC-359 —— 任务目录源装配：造页查询，交给共用的目录源适配（`taskExecutionCatalogSources.ts`）。
// 此前 sqlite / postgresql 两份薄壳只差客户端类型；目录源的适配逻辑一个字都不在这里。

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'

import {
  composeTaskExecutionCatalogSources as composeSources,
  type TaskCatalogSource,
  type TaskExecutionCatalogSourceFactory,
} from '../application/adapters/task-catalog-adapter'
import { createTaskExecutionCatalogSourceFactory } from './taskExecutionCatalogSources'
import { createDatabaseTaskListPage } from './taskListPage'
import type { WorkflowNameExpression } from './taskRepositorySql'
import type { OwnerIdentityQueries } from '@/modules/identity-access/public/queries'

export function createDatabaseTaskExecutionCatalogSourceFactory(
  db: PersistenceDb,
  owners: OwnerIdentityQueries,
  /** RFC-567: Resource Catalog's workflow name fragment for the page query (handed over by the assembly root). */
  workflowName: WorkflowNameExpression,
): TaskExecutionCatalogSourceFactory {
  return createTaskExecutionCatalogSourceFactory(
    createDatabaseTaskListPage(db, owners, workflowName),
  )
}

export function composeTaskExecutionCatalogSources(
  db: PersistenceDb,
  owners: OwnerIdentityQueries,
  workflowName: WorkflowNameExpression,
): TaskCatalogSource[] {
  return composeSources(createDatabaseTaskExecutionCatalogSourceFactory(db, owners, workflowName))
}
