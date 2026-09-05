import type { ProviderNeutralDatabase } from '@/db/query'
import { createDevelopmentAdapterResourceCatalogAclAdapter } from '../application/adapters/resource-catalog-acl-adapter'
import { createDevelopmentAdapterStore } from '../infrastructure/developmentAdapterStore'

/** Owner composition for resource-catalog ACL identity persistence（两个 provider 同一份）。 */
export function createDevelopmentAdapterResourceCatalogAclProvider(db: ProviderNeutralDatabase) {
  return createDevelopmentAdapterResourceCatalogAclAdapter(createDevelopmentAdapterStore(db))
}
