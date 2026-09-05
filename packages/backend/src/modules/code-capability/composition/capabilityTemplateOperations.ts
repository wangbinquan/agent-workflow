import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  createCapabilityTemplateOperations,
  type CapabilityTemplateOperations,
  type CapabilityTemplateResourceAccess,
} from '../application/capabilityTemplateOperations'
import { createCapabilityTemplatePersistence } from '../infrastructure/capabilityTemplatePersistence'

/** RFC-359：两个 provider 共用一份实现；旧名保留为装配别名，bootstrap 收敛后删除。 */
export const createSqliteCapabilityTemplatePersistence = createCapabilityTemplatePersistence
export const createPostgresqlCapabilityTemplatePersistence = createCapabilityTemplatePersistence

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
    persistence: createCapabilityTemplatePersistence(input.db),
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
    persistence: createCapabilityTemplatePersistence(input.db),
    access: input.access,
    ...(input.now === undefined ? {} : { now: input.now }),
  })
}
