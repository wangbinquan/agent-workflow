import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  createCodeCapabilityDemoSeedParticipant,
  type CodeCapabilityDemoSeedParticipant,
  type CodeCapabilityDemoSeedReceipt,
} from '../application/demoSeed'
import { createPostgresqlCodeCapabilityDemoSeedPersistence } from '../infrastructure/postgresqlDemoSeedPersistence'
import { createSqliteCodeCapabilityDemoSeedPersistence } from '../infrastructure/sqliteDemoSeedPersistence'

export type { CodeCapabilityDemoSeedParticipant, CodeCapabilityDemoSeedReceipt }

export function composeSqliteCodeCapabilityDemoSeedParticipant(
  db: DbClient,
): CodeCapabilityDemoSeedParticipant {
  return createCodeCapabilityDemoSeedParticipant(createSqliteCodeCapabilityDemoSeedPersistence(db))
}

export function composePostgresqlCodeCapabilityDemoSeedParticipant(
  db: PostgresqlDatabaseClient,
): CodeCapabilityDemoSeedParticipant {
  return createCodeCapabilityDemoSeedParticipant(
    createPostgresqlCodeCapabilityDemoSeedPersistence(db),
  )
}
