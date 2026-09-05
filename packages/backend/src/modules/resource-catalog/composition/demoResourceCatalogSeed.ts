import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createDemoResourceCatalogSeedParticipant } from '../application/demoResourceCatalogSeed'
import { createDemoResourceCatalogSeedPersistence } from '../infrastructure/demoResourceCatalogSeed'
import type { DemoResourceCatalogSeedParticipant } from '../public/participants'

export function composeSqliteDemoResourceCatalogSeedParticipant(
  db: DbClient,
): DemoResourceCatalogSeedParticipant {
  return createDemoResourceCatalogSeedParticipant(createDemoResourceCatalogSeedPersistence(db))
}

export function composePostgresqlDemoResourceCatalogSeedParticipant(
  db: PostgresqlDatabaseClient,
): DemoResourceCatalogSeedParticipant {
  return createDemoResourceCatalogSeedParticipant(createDemoResourceCatalogSeedPersistence(db))
}
