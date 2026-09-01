import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  createPortableImportReferenceApplication,
  createPortableImportReferenceSyncFence,
} from '../application/portableImportReferences'
import {
  createPostgresqlAgentImportReferenceReadPort,
  createPostgresqlImportReferenceReadPortInTransaction,
} from '../infrastructure/postgresqlAgentImportQueries'
import type { PostgresqlResourceCatalogTransaction } from '../infrastructure/postgresql/repositorySupport'
import {
  createSqliteAgentImportReferenceReadPort,
  createSqliteImportReferenceSyncReadPort,
} from '../infrastructure/sqliteAgentImportQueries'

export function composeSqlitePortableImportReferences(db: DbClient) {
  return createPortableImportReferenceApplication(createSqliteAgentImportReferenceReadPort(db))
}

export function composeSqlitePortableImportReferenceSyncFence(transaction: DbTxSync) {
  return createPortableImportReferenceSyncFence(
    createSqliteImportReferenceSyncReadPort(transaction),
  )
}

export function composePostgresqlPortableImportReferences(db: PostgresqlDatabaseClient) {
  return createPortableImportReferenceApplication(createPostgresqlAgentImportReferenceReadPort(db))
}

export function composePostgresqlPortableImportReferencesInTransaction(
  transaction: PostgresqlResourceCatalogTransaction,
) {
  return createPortableImportReferenceApplication(
    createPostgresqlImportReferenceReadPortInTransaction(transaction),
  )
}
