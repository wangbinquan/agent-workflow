import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createDemoResourceCatalogSeedParticipant } from '../application/demoResourceCatalogSeed'
import { createPostgresqlDemoResourceCatalogSeedPersistence } from '../infrastructure/postgresqlDemoResourceCatalogSeed'
import { createSqliteDemoResourceCatalogSeedPersistence } from '../infrastructure/sqliteDemoResourceCatalogSeed'
import type { DemoResourceCatalogSeedParticipant } from '../public/participants'

export function composeSqliteDemoResourceCatalogSeedParticipant(
  db: DbClient,
): DemoResourceCatalogSeedParticipant {
  return createDemoResourceCatalogSeedParticipant(
    createSqliteDemoResourceCatalogSeedPersistence(db),
  )
}

export function composePostgresqlDemoResourceCatalogSeedParticipant(
  db: PostgresqlDatabaseClient,
): DemoResourceCatalogSeedParticipant {
  return createDemoResourceCatalogSeedParticipant(
    createPostgresqlDemoResourceCatalogSeedPersistence(db),
  )
}
