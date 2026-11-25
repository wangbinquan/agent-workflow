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
import { loadSkillOperationState } from '../infrastructure/skillOperationStateQuery'
import type { ResourceCatalogAclIdentityReadPort } from '../application/ports/providerResourceCatalogPersistence'
import {
  createIntentApplyResourceSession,
  type IntentApplyResourceSession,
  type IntentApplyResourceSessionOptions,
} from '../infrastructure/aggregateAdapters/intentApplyResourceParticipants'
import {
  createIntentApplyResourcePortFactory,
  type IntentApplyResourcePortFactoryDependencies,
} from '../infrastructure/aggregateAdapters/intentApplyResourcePorts'
import { join } from 'node:path'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  createFileIntentPluginArtifactOwner,
  createFileIntentSkillArtifactOwner,
} from '../infrastructure/local/fileIntentApplyArtifactOwners'

export interface IntentApplyResourceCompositionDependencies extends IntentApplyResourcePortFactoryDependencies {
  readonly aclIdentities: ResourceCatalogAclIdentityReadPort
}

/**
 * Exact PostgreSQL binding consumed by Intent's provider-owned atomic commit
 * port. The factory closes over Resource Catalog persistence/lifecycles; the
 * caller supplies only the admitted authority pair and later its reserved
 * transaction.
 */
export function composeIntentApplyResourceBinding(
  input: IntentApplyResourceCompositionDependencies,
): Readonly<{
  createSession(options: IntentApplyResourceSessionOptions): IntentApplyResourceSession
}> {
  const factory = createIntentApplyResourcePortFactory(input)
  return Object.freeze({
    createSession(options) {
      return createIntentApplyResourceSession(options, input.aclIdentities, factory.create(options))
    },
  })
}

// RFC-355 T6 —— PostgreSQL 路径的技能 / 插件工件 owner。
//
// 这两个工厂此前住在 `modules/intent/infrastructure/intentApplyArtifactOwners.ts`，
// 但它们实现的是 RC 的端口、用的是 RC 自己的技能文件机制——对照 SQLite 路径就清楚：
// 同一件事在那边由 RC 的 `legacyIntentApplyResourceParticipants` 提供。
// 迁进 RC 之后从 composition 出（**不从 `public/` 出 provider 适配器**——RFC-349 的
// provider-cutover 账本「只能缩不能涨」，形态同 RFC-353 立下的口径）。
export {
  createPostgresqlIntentPluginArtifactLifecycle,
  createPostgresqlIntentSkillArtifactLifecycle,
} from '../infrastructure/aggregateAdapters/intentApplyArtifactOwners'

export {
  createFileIntentPluginArtifactOwner,
  createFileIntentSkillArtifactOwner,
} from '../infrastructure/local/fileIntentApplyArtifactOwners'

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
    loadSkillOperationState,
  })
}

export { createSkillContentLocationQuery } from '../infrastructure/databaseSkillTrees'

/**
 * RFC-595 — the standalone Intent artifact family's Resource Catalog half, from the same three local constructions Intent's
 * composition used to make itself: the plugin owner under `appHome/plugins`, the skill owner on the session's database and
 * the skill artifact compensation. Bootstrap hands it to Intent's `composeLocalIntentArtifacts`, as the hosted family's
 * half comes from `composeCrewStationResourceArtifacts`.
 */
export function composeLocalIntentResourceArtifacts(input: {
  readonly db: PersistenceDb
  readonly appHome: string
}) {
  return Object.freeze({
    pluginArtifacts: createFileIntentPluginArtifactOwner({
      pluginsDir: join(input.appHome, 'plugins'),
    }),
    skillArtifacts: createFileIntentSkillArtifactOwner({ appHome: input.appHome, db: input.db }),
    skillArtifactCompensation: composePostgresqlSkillArtifactCompensation(),
  })
}
