import type { ProviderNeutralDatabase } from '@/db/query'
import {
  createCapabilityTemplateOperations,
  type CapabilityTemplateOperations,
  type CapabilityTemplateResourceAccess,
} from '../application/capabilityTemplateOperations'
import { createCapabilityTemplatePersistence } from '../infrastructure/capabilityTemplatePersistence'

// RFC-359 AC-1（plan §5fu）：两个品牌别名退役后，中立名从这里继续对外可见——
// 消费者原来 import 的就是这个模块，改名不该顺带改 import 路径。
export { createCapabilityTemplatePersistence }

/** RFC-359：两个 provider 共用一份实现；旧名保留为装配别名，bootstrap 收敛后删除。 */

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
