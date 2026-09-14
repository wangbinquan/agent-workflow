// RFC-345 T4b — bootstrap-owned binding for the current Intent lifecycle.

import {
  markSkillBootVerified,
  unmarkSkillBootVerified,
} from '../infrastructure/legacy/skillBootVerify'
import {
  cleanupOpDirs,
  opCandidateDir,
  opStagedDir,
  swapInStaged,
} from '../infrastructure/legacy/skillFsPublish'
import { hashRegularFileTree } from '../infrastructure/legacy/skillHash'
import { skillFilesAbs, skillVersionAbs } from '../infrastructure/legacy/skillIdentityPaths'
import { finishOperation } from '../infrastructure/legacy/skillOperations'
import { publishStagedSkillVersion } from '../infrastructure/legacy/skillVersion'
import { skillOperationStateQuery } from '../infrastructure/skillOperationStateQuery'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { ResourceCatalogAclIdentityReadPort } from '../application/ports/providerResourceCatalogPersistence'
import {
  createPostgresqlIntentApplyResourceSession,
  type PostgresqlIntentApplyResourceSession,
  type PostgresqlIntentApplyResourceSessionOptions,
} from '../infrastructure/aggregateAdapters/postgresqlIntentApplyResourceParticipants'
import {
  createPostgresqlIntentApplyResourcePortFactory,
  type PostgresqlIntentApplyResourcePortFactoryDependencies,
} from '../infrastructure/aggregateAdapters/postgresqlIntentApplyResourcePorts'

export interface PostgresqlIntentApplyResourceCompositionDependencies extends PostgresqlIntentApplyResourcePortFactoryDependencies {
  readonly aclIdentities: ResourceCatalogAclIdentityReadPort
}

/**
 * Exact PostgreSQL binding consumed by Intent's provider-owned atomic commit
 * port. The factory closes over Resource Catalog persistence/lifecycles; the
 * caller supplies only the admitted authority pair and later its reserved
 * transaction.
 */
export function composePostgresqlIntentApplyResourceBinding(
  input: PostgresqlIntentApplyResourceCompositionDependencies,
): Readonly<{
  createSession(
    options: PostgresqlIntentApplyResourceSessionOptions,
  ): PostgresqlIntentApplyResourceSession
}> {
  const factory = createPostgresqlIntentApplyResourcePortFactory(input)
  return Object.freeze({
    createSession(options) {
      return createPostgresqlIntentApplyResourceSession(
        options,
        input.aclIdentities,
        factory.create(options),
      )
    },
  })
}

// RFC-355 T6 —— PostgreSQL 路径的技能 / 插件工件 owner。
//
// 这两个工厂此前住在 `modules/intent/infrastructure/postgresqlIntentApplyArtifactOwners.ts`，
// 但它们实现的是 RC 的端口、用的是 RC 自己的技能文件机制——对照 SQLite 路径就清楚：
// 同一件事在那边由 RC 的 `legacyIntentApplyResourceParticipants` 提供。
// 迁进 RC 之后从 composition 出（**不从 `public/` 出 provider 适配器**——RFC-349 的
// provider-cutover 账本「只能缩不能涨」，形态同 RFC-353 立下的口径）。
export {
  createPostgresqlIntentPluginArtifactLifecycle,
  createPostgresqlIntentSkillArtifactLifecycle,
} from '../infrastructure/aggregateAdapters/postgresqlIntentApplyArtifactOwners'

// RFC-355 T6 —— intent 恢复路径要的技能工件补偿原语，由 RC 提供、bootstrap 注入。
//
// intent 的 `ArtifactLifecycle` 负责编排「补偿 / 前滚」，但被补偿的对象是 RC 的技能工件。
// 此前 intent 直接深取 `infrastructure/legacy/*`（RFC-317 R2 禁止）；现在 intent 只声明它要的
// 窄端口（`modules/intent/ports/skillArtifactCompensation.ts`），实现从这里出。
//
// RFC-359 —— 此处此前是一对（`composeSqliteSkillArtifactCompensation` 走 legacy 的
// `publishStagedSkillVersion` / `finishOperation`，PG 这份走 `swapInStaged` + 活体哈希核对）。
// 两台 apply 引擎合一后只剩这一份。
export function composePostgresqlSkillArtifactCompensation() {
  return Object.freeze({
    cleanupOpDirs,
    opCandidateDir,
    opStagedDir,
    swapInStaged,
    hashRegularFileTree,
    skillFilesAbs,
    skillVersionAbs,
    markSkillBootVerified,
  })
}

/**
 * RFC-359 —— **合一之前**由 SQLite 那台引擎写下的 journal 工件，前滚时要用的那几件原语。
 *
 * 为什么不能随引擎一起删：journal 行比进程活得久。一台跑着旧引擎的 daemon 在 apply 的
 * 提交后阶段崩了，库里就留着一条 `committed` 的行，工件是旧词汇（`skill-version-stage` 装的是
 * `staged: StagedSkillVersionRecord`，不是新形状的 `{operationId, stagingDirectory, …}`）。
 * 升级到合一引擎之后，**收敛器仍然要把那条尾巴走完**——把暂存的技能版本发布出去、把
 * `skill_operations` 行收尾——否则那条 journal 行每小时被看一次、每次都前滚不了，
 * 技能版本永远停在暂存态。补偿那一侧本来就已经认旧词汇（`compensateLegacyArtifact`），
 * 缺的只有前滚这一半。
 *
 * 退役条件：确认没有部署会从 RFC-359 合一之前的版本直升上来。
 */
export function composeLegacyIntentSkillArtifactCompat() {
  return Object.freeze({
    publishStagedSkillVersion,
    finishOperation,
    unmarkSkillBootVerified,
    loadSkillOperationState: (db: ProviderNeutralDatabase, opId: string) =>
      skillOperationStateQuery(db, opId).get(),
  })
}
