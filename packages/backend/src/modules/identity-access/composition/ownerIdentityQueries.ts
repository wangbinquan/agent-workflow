import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  createOwnerIdentityQueries,
  type OwnerIdentityQueries,
} from '../application/ports/ownerIdentityQueries'
import { DrizzleOwnerIdentityPersistence } from '../infrastructure/ownerIdentityQueries'

export function composeSqliteOwnerIdentityQueries(db: DbClient): OwnerIdentityQueries {
  return createOwnerIdentityQueries({
    persistence: new DrizzleOwnerIdentityPersistence(db),
    systemUserId: SYSTEM_USER_ID,
  })
}

export function composePostgresqlOwnerIdentityQueries(
  db: PostgresqlDatabaseClient,
): OwnerIdentityQueries {
  return createOwnerIdentityQueries({
    persistence: new DrizzleOwnerIdentityPersistence(db),
    systemUserId: SYSTEM_USER_ID,
  })
}
