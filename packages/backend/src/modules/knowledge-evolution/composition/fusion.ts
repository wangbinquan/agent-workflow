import type { ProviderNeutralDatabase } from '@/db/query'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import {
  createFusionPersistence,
  type FusionMemoryMembership,
  type FusionSkillVersionCommit,
} from '../infrastructure/fusionRepository'
import type { MemoryCatalogOperations } from '../../memory/public/catalog'
import type {
  FusionEngineTaskOperations,
  FusionOperations,
  FusionPersistence,
} from '../public/participants'

interface FusionCompositionDependencies {
  readonly appHome: string
  readonly memories: MemoryCatalogOperations
  readonly tasks: FusionEngineTaskOperations
}

/** 跨聚合的两半（memory 的成员关系、resource-catalog 的版本提交），两个 provider 同一份 tx-bound 工厂。 */
export interface FusionParticipants {
  readonly memoryMembership: FusionMemoryMembership
  readonly skillVersionCommit: FusionSkillVersionCommit
}

/**
 * RFC-353 T6/T7：跨聚合的两半由**调用方注入**。
 *
 * 为什么不在这里自己去取：模块之间只能经 exact `public/*` 交换合同（RFC-317 R2），而
 * public 面又不许直接点名 provider 适配器（RFC-349 的 provider-cutover 账本「只能缩不能涨」）。
 * 两条约束叠起来只剩一个自洽解——**跨 context 的 provider 装配在 bootstrap /
 * system-operation 根上完成**，模块之间只传 provider 中性的端口。
 * RFC-359 W4-D5 起仓库实现只有一份，provider 只在交来的数据库客户端上体现；旧 provider 名保留为装配别名。
 */
export function composeFusionPersistenceFor(
  input: {
    readonly db: ProviderNeutralDatabase
    readonly appHome: string
  } & FusionParticipants,
): FusionPersistence {
  const { memoryMembership } = input
  const session = databaseSessionFor(input.db)
  return createFusionPersistence({
    ...input,
    // RFC-353 T6/T7：provenance 修复也走 memory 的同一个 participant。逐条各自开事务——
    // 单条 UPDATE 与此前的裸写等价，但不再需要把 provider 的原始 client 泄漏到 public 面上。
    fusedSkillReassignment: Object.freeze({
      reassign: async (repair: { readonly memoryId: string; readonly skillId: string }) =>
        await session.transaction(
          async (tx) => await memoryMembership.inTransaction(tx).reassignFusedSkill(repair),
        ),
    }),
  })
}

export function composeFusionOperationsFor(
  input: FusionCompositionDependencies & {
    readonly db: ProviderNeutralDatabase
  } & FusionParticipants,
): FusionOperations {
  return Object.freeze({
    persistence: composeFusionPersistenceFor({
      db: input.db,
      appHome: input.appHome,
      memoryMembership: input.memoryMembership,
      skillVersionCommit: input.skillVersionCommit,
    }),
    memories: input.memories,
    tasks: input.tasks,
  })
}

/** 旧名保留为装配别名，PG 装配收敛后删除。 */
export {
  composeFusionOperationsFor as composePostgresqlFusionOperations,
  composeFusionOperationsFor as composeSqliteFusionOperations,
  composeFusionPersistenceFor as composePostgresqlFusionPersistence,
  composeFusionPersistenceFor as composeSqliteFusionPersistence,
}
