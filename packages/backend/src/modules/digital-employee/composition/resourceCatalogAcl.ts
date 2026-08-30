import type { DbClient } from '@/db/client'
import { createDigitalEmployeeResourceCatalogAclAdapters as adaptResourceCatalogAcl } from '../application/adapters/resource-catalog-acl-adapter'
import { createSqliteDigitalEmployeeAuthoringStore } from '../infrastructure/sqliteAuthoringStore'

/** Owner composition for resource-catalog ACL identity persistence. */
export function createDigitalEmployeeResourceCatalogAclProviders(db: DbClient) {
  return adaptResourceCatalogAcl(createSqliteDigitalEmployeeAuthoringStore(db))
}
