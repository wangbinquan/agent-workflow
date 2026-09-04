// RFC-345 T4b — bootstrap-owned binding for the current Intent lifecycle.

import { compensateManagedSkillStage } from '../infrastructure/legacy/skill'
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
import {
  abortStagedSkillVersion,
  publishStagedSkillVersion,
} from '../infrastructure/legacy/skillVersion'
import { loadLegacyIntentSkillOperationState } from '../infrastructure/aggregateAdapters/legacyIntentApplyResourceParticipants'

import {
  createLegacyIntentApplyResourceSession,
  type LegacyIntentApplyResourceDependencies,
  type LegacyIntentApplyResourceSessionOptions,
} from '../infrastructure/aggregateAdapters/legacyIntentApplyResourceParticipants'
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

export function composeIntentApplyResourceBinding(
  dependencies: LegacyIntentApplyResourceDependencies,
  aclIdentities: ResourceCatalogAclIdentityReadPort,
) {
  return Object.freeze({
    createSession(options: LegacyIntentApplyResourceSessionOptions) {
      return createLegacyIntentApplyResourceSession(options, dependencies, aclIdentities)
    },
  })
}

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
export function composeSqliteSkillArtifactCompensation() {
  return Object.freeze({
    compensateManagedSkillStage,
    abortStagedSkillVersion,
    publishStagedSkillVersion,
    unmarkSkillBootVerified,
    finishOperation,
    loadSkillOperationState: loadLegacyIntentSkillOperationState,
  })
}

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
