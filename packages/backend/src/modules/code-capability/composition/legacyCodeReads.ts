import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { CapabilityParamRead } from '../application/ports/capabilityParamRead'
import type { CodeWorkspaceRead } from '../application/ports/codeWorkspaceRead'
import { createCapabilityParamRead } from '../infrastructure/capabilityParamRead'
import { createCodeWorkspaceRead } from '../infrastructure/codeWorkspaceRead'

export interface LegacyCodeReadProviders {
  readonly workspace: CodeWorkspaceRead
  readonly capabilityParams: CapabilityParamRead
}

export function composeSqliteLegacyCodeReadProviders(db: DbClient): LegacyCodeReadProviders {
  return Object.freeze({
    workspace: createCodeWorkspaceRead(db),
    capabilityParams: createCapabilityParamRead(db),
  })
}

export function composePostgresqlLegacyCodeReadProviders(
  db: PostgresqlDatabaseClient,
): LegacyCodeReadProviders {
  return Object.freeze({
    workspace: createCodeWorkspaceRead(db),
    capabilityParams: createCapabilityParamRead(db),
  })
}
