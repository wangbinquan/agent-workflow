import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createDigitalEmployeeResourceCatalogAclAdapters as adaptResourceCatalogAcl } from '../application/adapters/resource-catalog-acl-adapter'
import { createDigitalEmployeeAuthoringPersistence } from '../infrastructure/authoringStore'

/** Owner composition for resource-catalog ACL identity persistence（两个 provider 同一份）。 */
export function createDigitalEmployeeResourceCatalogAclProviders(db: PersistenceDb) {
  return adaptResourceCatalogAcl(createDigitalEmployeeAuthoringPersistence(db))
}
