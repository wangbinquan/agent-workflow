import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  createCapabilityTemplateOperations,
  type CapabilityTemplateOperations,
  type CapabilityTemplateResourceAccess,
} from '../application/capabilityTemplateOperations'
import { createPostgresqlCapabilityTemplatePersistence } from '../infrastructure/postgresqlCapabilityTemplatePersistence'
import { createSqliteCapabilityTemplatePersistence } from '../infrastructure/sqliteCapabilityTemplatePersistence'

export { createPostgresqlCapabilityTemplatePersistence, createSqliteCapabilityTemplatePersistence }

export {
  createPostgresqlCapabilityTemplatePackageCommit,
  createSqliteCapabilityTemplatePackageCommitSync,
} from '../infrastructure/capabilityTemplatePackageCommit'
export { createPostgresqlCapabilityTemplatePackageMutationOwner } from '../infrastructure/postgresqlCapabilityTemplatePackageMutationOwner'
export type { SqliteCapabilityTemplatePackageCommitSync } from '../infrastructure/capabilityTemplatePackageCommit'
export type {
  CapabilityTemplatePackageCommit,
  PreparedCapabilityTemplateWrite,
} from '../application/ports/capabilityTemplatePersistence'

export function composeSqliteCapabilityTemplateOperations(input: {
  readonly db: DbClient
  readonly access: CapabilityTemplateResourceAccess
  readonly now?: () => number
}): CapabilityTemplateOperations {
  return createCapabilityTemplateOperations({
    persistence: createSqliteCapabilityTemplatePersistence(input.db),
    access: input.access,
    ...(input.now === undefined ? {} : { now: input.now }),
  })
}

export function composePostgresqlCapabilityTemplateOperations(input: {
  readonly db: PostgresqlDatabaseClient
  readonly access: CapabilityTemplateResourceAccess
  readonly now?: () => number
}): CapabilityTemplateOperations {
  return createCapabilityTemplateOperations({
    persistence: createPostgresqlCapabilityTemplatePersistence(input.db),
    access: input.access,
    ...(input.now === undefined ? {} : { now: input.now }),
  })
}
