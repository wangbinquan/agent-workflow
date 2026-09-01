import type { DbClient } from '@/db/client'
import type { IntentPersistence } from '../application/ports/intentPersistence'
import { IntentSqlPersistence } from './intentSqlPersistence'
import {
  SqliteAuthorizedIntentSqlProgramRunner,
  SqliteIntentSqlProgramRunner,
  type SqliteIntentContextResourceAuthorizationFactoryDependency,
} from './sqliteIntentSqlProgramRunner'

export function createSqliteIntentPersistence(db: DbClient): IntentPersistence {
  return new IntentSqlPersistence(new SqliteIntentSqlProgramRunner(db))
}

export function createAuthorizedSqliteIntentPersistence(input: {
  readonly db: DbClient
  readonly contextAuthorization: SqliteIntentContextResourceAuthorizationFactoryDependency
}): IntentPersistence {
  return new IntentSqlPersistence(
    new SqliteAuthorizedIntentSqlProgramRunner(input.db, input.contextAuthorization),
  )
}
