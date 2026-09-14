import type { ProviderNeutralDatabase } from '@/db/query'
import {
  createCapabilityTemplateOperations,
  type CapabilityTemplateOperations,
  type CapabilityTemplateResourceAccess,
} from '../application/capabilityTemplateOperations'
import { createCapabilityTemplatePersistence } from '../infrastructure/capabilityTemplatePersistence'

/** RFC-359：两个 provider 共用一份实现；旧名保留为装配别名，bootstrap 收敛后删除。 */
export const createSqliteCapabilityTemplatePersistence = createCapabilityTemplatePersistence
export const createPostgresqlCapabilityTemplatePersistence = createCapabilityTemplatePersistence

export { createPostgresqlCapabilityTemplatePackageCommit } from '../infrastructure/capabilityTemplatePackageCommit'
export { createPostgresqlCapabilityTemplatePackageMutationOwner } from '../infrastructure/postgresqlCapabilityTemplatePackageMutationOwner'
export type {
  CapabilityTemplatePackageCommit,
  PreparedCapabilityTemplateWrite,
} from '../application/ports/capabilityTemplatePersistence'

/**
 * RFC-359：此前是两个**函数体逐字相同**的孪生，唯一差别是形参上 `db` 的声明类型——
 * 而 `createCapabilityTemplatePersistence` 本来就收中立客户端。收成一份（plan §5ds）。
 */
export function composeCapabilityTemplateOperations(input: {
  readonly db: ProviderNeutralDatabase
  readonly access: CapabilityTemplateResourceAccess
  readonly now?: () => number
}): CapabilityTemplateOperations {
  return createCapabilityTemplateOperations({
    persistence: createCapabilityTemplatePersistence(input.db),
    access: input.access,
    ...(input.now === undefined ? {} : { now: input.now }),
  })
}
