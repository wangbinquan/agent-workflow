import type { FusionResourceSeedParticipant } from '@/modules/resource-catalog/public/participants'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import {
  createFusionPersistence,
  type FusionMemoryMembership,
  type FusionSkillTrees,
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

/** 跨聚合的两半（memory 的成员关系、resource-catalog 的版本提交），两个 provider 同一份工厂。 */
export interface FusionParticipants {
  readonly memoryMembership: FusionMemoryMembership
  readonly skillVersionCommit: FusionSkillVersionCommit
  /** Restore-only recovery does not seed catalog resources. */
  readonly resourceSeed?: { bind(db: PersistenceDb): FusionResourceSeedParticipant }
}

/**
 * RFC-353 T6/T7：跨聚合的两半由**调用方注入**。
 *
 * 为什么不在这里自己去取：模块之间只能经 exact `public/*` 交换合同（RFC-317 R2），而
 * public 面又不许直接点名 provider 适配器（RFC-349 的 provider-cutover 账本「只能缩不能涨」）。
 * 两条约束叠起来只剩一个自洽解——**跨 context 的 provider 装配在 bootstrap /
 * system-operation 根上完成**，模块之间只传 provider 中性的端口。
 * RFC-359 W4-D5 起仓库实现只有一份，provider 只在交来的数据库客户端上体现；旧 provider 名保留为装配别名。
 * RFC-370 §10 V20：版本提交工厂在这里绑上本仓的数据库句柄（与 appHome——本地文件存储的根），
 * 绑出的同一个 participant 同时给仓库（暂存 / 提交 / 发布）与编排（种子树 / 候选树）。
 */
function persistenceOf(
  input: { readonly db: PersistenceDb } & Pick<
    FusionParticipants,
    'memoryMembership' | 'resourceSeed'
  >,
  skillTrees: FusionSkillTrees,
): FusionPersistence {
  const { memoryMembership } = input
  const session = databaseSessionFor(input.db)
  return createFusionPersistence({
    db: input.db,
    memoryMembership,
    skillVersionCommit: skillTrees,
    ...(input.resourceSeed === undefined
      ? {}
      : { resourceSeed: input.resourceSeed.bind(input.db) }),
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

export function composeFusionPersistenceFor(
  input: {
    readonly db: PersistenceDb
    readonly appHome: string
  } & FusionParticipants,
): FusionPersistence {
  return persistenceOf(
    input,
    input.skillVersionCommit.bind({ db: input.db, appHome: input.appHome }),
  )
}

export function composeFusionOperationsFor(
  input: FusionCompositionDependencies & {
    readonly db: PersistenceDb
  } & FusionParticipants &
    Required<Pick<FusionParticipants, 'resourceSeed'>>,
): FusionOperations {
  const skillTrees = input.skillVersionCommit.bind({ db: input.db, appHome: input.appHome })
  return Object.freeze({
    persistence: persistenceOf(input, skillTrees),
    memories: input.memories,
    tasks: input.tasks,
    skillTrees,
  })
}

/** RFC-381 起两个 provider 的融合运营都经 `composeFusionOperationsFor`；持久化旧名仍由系统运维恢复使用。 */
export { composeFusionPersistenceFor as composeSqliteFusionPersistence }
