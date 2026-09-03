import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  createPostgresqlFusionPersistence as createPostgresqlFusionPersistenceAdapter,
  type PostgresqlFusionMemoryMembership,
  type PostgresqlFusionSkillVersionCommit,
} from '../infrastructure/postgresqlFusionRepository'
import {
  createSqliteFusionPersistence as createSqliteFusionPersistenceAdapter,
  type FusionMemoryMembershipSync,
  type FusionSkillVersionCommitSync,
} from '../infrastructure/sqliteFusionRepository'
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

type SqliteFusionParticipants = {
  readonly memoryMembership: FusionMemoryMembershipSync
  readonly skillVersionCommit: FusionSkillVersionCommitSync
}

type PostgresqlFusionParticipants = {
  readonly memoryMembership: PostgresqlFusionMemoryMembership
  readonly skillVersionCommit: PostgresqlFusionSkillVersionCommit
}

/**
 * RFC-353 T6/T7：跨聚合的两半（memory 的成员关系、resource-catalog 的版本提交）由**调用方注入**。
 *
 * 为什么不在这里自己去取：模块之间只能经 exact `public/*` 交换合同（RFC-317 R2），而
 * public 面又不许直接点名 provider 适配器（RFC-349 的 provider-cutover 账本「只能缩不能涨」）。
 * 两条约束叠起来只剩一个自洽解——**跨 context 的 provider 装配在 bootstrap /
 * system-operation 根上完成**，模块之间只传 provider 中性的端口。
 */
export function composeSqliteFusionPersistence(input: {
  readonly db: DbClient
  readonly appHome: string
  readonly memoryMembership: FusionMemoryMembershipSync
  readonly skillVersionCommit: FusionSkillVersionCommitSync
}): FusionPersistence {
  return createSqliteFusionPersistenceAdapter(input)
}

export function composePostgresqlFusionPersistence(input: {
  readonly db: PostgresqlDatabaseClient
  readonly appHome: string
  readonly memoryMembership: PostgresqlFusionMemoryMembership
  readonly skillVersionCommit: PostgresqlFusionSkillVersionCommit
}): FusionPersistence {
  const { memoryMembership } = input
  return createPostgresqlFusionPersistenceAdapter({
    ...input,
    // RFC-353 T6/T7：provenance 修复也走 memory 的同一个 participant。逐条各自开事务——
    // 单条 UPDATE 与此前的裸写等价，但不再需要把 provider 的原始 client 泄漏到 public 面上。
    fusedSkillReassignment: Object.freeze({
      reassign: async (repair: { readonly memoryId: string; readonly skillId: string }) =>
        await input.db.transaction(
          async (tx) => await memoryMembership.inTransaction(tx).reassignFusedSkill(repair),
        ),
    }),
  })
}

export function composeSqliteFusionOperations(
  input: FusionCompositionDependencies & { readonly db: DbClient } & SqliteFusionParticipants,
): FusionOperations {
  return Object.freeze({
    persistence: composeSqliteFusionPersistence({
      db: input.db,
      appHome: input.appHome,
      memoryMembership: input.memoryMembership,
      skillVersionCommit: input.skillVersionCommit,
    }),
    memories: input.memories,
    tasks: input.tasks,
  })
}

export function composePostgresqlFusionOperations(
  input: FusionCompositionDependencies & {
    readonly db: PostgresqlDatabaseClient
  } & PostgresqlFusionParticipants,
): FusionOperations {
  return Object.freeze({
    persistence: composePostgresqlFusionPersistence({
      db: input.db,
      appHome: input.appHome,
      memoryMembership: input.memoryMembership,
      skillVersionCommit: input.skillVersionCommit,
    }),
    memories: input.memories,
    tasks: input.tasks,
  })
}
