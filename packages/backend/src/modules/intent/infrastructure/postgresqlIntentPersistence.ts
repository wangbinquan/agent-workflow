import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { IntentPersistence } from '../application/ports/intentPersistence'
import { IntentSqlPersistence } from './intentSqlPersistence'
import {
  PostgresqlAuthorizedIntentSqlProgramRunner,
  PostgresqlIntentSqlProgramRunner,
  type PostgresqlIntentContextResourceAuthorizationFactoryDependency,
} from './postgresqlIntentSqlProgramRunner'

export function createPostgresqlIntentPersistence(db: PostgresqlDatabaseClient): IntentPersistence {
  return new IntentSqlPersistence(new PostgresqlIntentSqlProgramRunner(db))
}

export function createAuthorizedPostgresqlIntentPersistence(input: {
  readonly db: PostgresqlDatabaseClient
  readonly contextAuthorization: PostgresqlIntentContextResourceAuthorizationFactoryDependency
}): IntentPersistence {
  return new IntentSqlPersistence(
    new PostgresqlAuthorizedIntentSqlProgramRunner(input.db, input.contextAuthorization),
  )
}
