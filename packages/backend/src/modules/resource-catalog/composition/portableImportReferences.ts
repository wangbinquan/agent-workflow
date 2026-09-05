import type { ProviderNeutralDatabase } from '@/db/query'
import { createPortableImportReferenceApplication } from '../application/portableImportReferences'
import {
  createAgentImportReferenceReadPort,
  createImportReferenceReadPortInTransaction,
} from '../infrastructure/agentImportQueries'
import type { ResourceCatalogTransaction } from '../infrastructure/resourceCatalogTransaction'

/** 一份装配，两个 provider 共用（RFC-359 W4-D14）。 */
export function composePortableImportReferences(db: ProviderNeutralDatabase) {
  return createPortableImportReferenceApplication(createAgentImportReferenceReadPort(db))
}

/** 绑定到调用方已开的统一事务：终写围栏与写入同一快照。 */
export function composePortableImportReferencesInTransaction(
  transaction: ResourceCatalogTransaction,
) {
  return createPortableImportReferenceApplication(
    createImportReferenceReadPortInTransaction(transaction),
  )
}
