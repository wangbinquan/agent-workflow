import type { DbClient } from '@/db/client'
import { createDevelopmentAdapterResourceCatalogAclAdapter } from '../application/adapters/resource-catalog-acl-adapter'
import { createSqliteDevelopmentAdapterStore } from '../infrastructure/sqliteDevelopmentAdapterStore'

/** Owner composition for resource-catalog ACL identity persistence. */
export function createDevelopmentAdapterResourceCatalogAclProvider(db: DbClient) {
  return createDevelopmentAdapterResourceCatalogAclAdapter(createSqliteDevelopmentAdapterStore(db))
}
