import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  createAuthorizedSqliteIntentPersistence,
  createSqliteIntentPersistence,
} from '../infrastructure/sqliteIntentPersistence'
import {
  createAuthorizedPostgresqlIntentPersistence,
  createPostgresqlIntentPersistence,
} from '../infrastructure/postgresqlIntentPersistence'
import type { SqliteIntentContextResourceAuthorizationFactoryDependency } from '../infrastructure/sqliteIntentSqlProgramRunner'
import type { PostgresqlIntentContextResourceAuthorizationFactoryDependency } from '../infrastructure/postgresqlIntentSqlProgramRunner'

export { createSqliteIntentPersistence, createPostgresqlIntentPersistence }

/** Production SQLite composition; context mutations cannot omit RC binding. */
export function composeSqliteIntentPersistence(input: {
  readonly db: DbClient
  readonly contextAuthorization: SqliteIntentContextResourceAuthorizationFactoryDependency
}) {
  return createAuthorizedSqliteIntentPersistence(input)
}

/** Production PostgreSQL composition; context mutations share its reserved tx. */
export function composePostgresqlIntentPersistence(input: {
  readonly db: PostgresqlDatabaseClient
  readonly contextAuthorization: PostgresqlIntentContextResourceAuthorizationFactoryDependency
}) {
  return createAuthorizedPostgresqlIntentPersistence(input)
}

export type { IntentPersistence } from '../application/ports/intentPersistence'
