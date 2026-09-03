import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createPostgresqlFusionPersistence as createPostgresqlFusionPersistenceAdapter } from '../infrastructure/postgresqlFusionRepository'
import { createSqliteFusionPersistence as createSqliteFusionPersistenceAdapter } from '../infrastructure/sqliteFusionRepository'
import {
  composePostgresqlSkillMemoryFusionParticipantFactory,
  markFusedSync,
  reassignFusedSkillSync,
} from '../../memory/public/participants'
import {
  composePostgresqlSkillVersionCommitParticipantFactory,
  sqliteSkillVersionCommitSync,
} from '../../resource-catalog/public/participants'
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

export function composeSqliteFusionPersistence(input: {
  readonly db: DbClient
  readonly appHome: string
}): FusionPersistence {
  // RFC-353 T6：记忆成员关系那一半由 memory 提供。SQLite 侧的 `apply` 跑在 `dbTxSync` 的
  // 同步回调里，所以取 memory 的同步核心；判据（谁被标记、什么顺序、写哪几列）在 memory。
  return createSqliteFusionPersistenceAdapter({
    ...input,
    memoryMembership: { markFused: markFusedSync, reassignFusedSkill: reassignFusedSkillSync },
    // RFC-353 T6：`skills` / `skill_versions` 归 resource-catalog 单写，同上取它的同步核心。
    skillVersionCommit: { commit: sqliteSkillVersionCommitSync },
  })
}

export function composePostgresqlFusionPersistence(input: {
  readonly db: PostgresqlDatabaseClient
  readonly appHome: string
}): FusionPersistence {
  const memoryMembership = composePostgresqlSkillMemoryFusionParticipantFactory()
  return createPostgresqlFusionPersistenceAdapter({
    ...input,
    memoryMembership,
    // RFC-353 T6/T7：provenance 修复也走 memory 的同一个 participant。逐条各自开事务——
    // 单条 UPDATE 与此前的裸写等价，但不再需要把 provider 的原始 client 泄漏到 public 面上。
    fusedSkillReassignment: Object.freeze({
      reassign: async (repair: { readonly memoryId: string; readonly skillId: string }) =>
        await input.db.transaction(
          async (tx) => await memoryMembership.inTransaction(tx).reassignFusedSkill(repair),
        ),
    }),
    skillVersionCommit: composePostgresqlSkillVersionCommitParticipantFactory(),
  })
}

export function composeSqliteFusionOperations(
  input: FusionCompositionDependencies & { readonly db: DbClient },
): FusionOperations {
  return Object.freeze({
    persistence: composeSqliteFusionPersistence({ db: input.db, appHome: input.appHome }),
    memories: input.memories,
    tasks: input.tasks,
  })
}

export function composePostgresqlFusionOperations(
  input: FusionCompositionDependencies & { readonly db: PostgresqlDatabaseClient },
): FusionOperations {
  return Object.freeze({
    persistence: composePostgresqlFusionPersistence({ db: input.db, appHome: input.appHome }),
    memories: input.memories,
    tasks: input.tasks,
  })
}
