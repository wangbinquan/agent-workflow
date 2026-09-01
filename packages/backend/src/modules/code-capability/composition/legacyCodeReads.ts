import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { CapabilityParamRead } from '../application/ports/capabilityParamRead'
import type { CodeWorkspaceRead } from '../application/ports/codeWorkspaceRead'
import { createPostgresqlCapabilityParamRead } from '../infrastructure/postgresqlCapabilityParamRead'
import { createPostgresqlCodeWorkspaceRead } from '../infrastructure/postgresqlCodeWorkspaceRead'
import { createSqliteCapabilityParamRead } from '../infrastructure/sqliteCapabilityParamRead'
import { createSqliteCodeWorkspaceRead } from '../infrastructure/sqliteCodeWorkspaceRead'

export interface LegacyCodeReadProviders {
  readonly workspace: CodeWorkspaceRead
  readonly capabilityParams: CapabilityParamRead
}

export function composeSqliteLegacyCodeReadProviders(db: DbClient): LegacyCodeReadProviders {
  return Object.freeze({
    workspace: createSqliteCodeWorkspaceRead(db),
    capabilityParams: createSqliteCapabilityParamRead(db),
  })
}

export function composePostgresqlLegacyCodeReadProviders(
  db: PostgresqlDatabaseClient,
): LegacyCodeReadProviders {
  return Object.freeze({
    workspace: createPostgresqlCodeWorkspaceRead(db),
    capabilityParams: createPostgresqlCapabilityParamRead(db),
  })
}
