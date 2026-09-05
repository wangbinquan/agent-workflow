import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  createCodeCapabilityDemoSeedParticipant,
  type CodeCapabilityDemoSeedParticipant,
  type CodeCapabilityDemoSeedReceipt,
} from '../application/demoSeed'
import { createCodeCapabilityDemoSeedPersistence } from '../infrastructure/demoSeedPersistence'

export type { CodeCapabilityDemoSeedParticipant, CodeCapabilityDemoSeedReceipt }

export function composeSqliteCodeCapabilityDemoSeedParticipant(
  db: DbClient,
): CodeCapabilityDemoSeedParticipant {
  return createCodeCapabilityDemoSeedParticipant(createCodeCapabilityDemoSeedPersistence(db))
}

export function composePostgresqlCodeCapabilityDemoSeedParticipant(
  db: PostgresqlDatabaseClient,
): CodeCapabilityDemoSeedParticipant {
  return createCodeCapabilityDemoSeedParticipant(createCodeCapabilityDemoSeedPersistence(db))
}
