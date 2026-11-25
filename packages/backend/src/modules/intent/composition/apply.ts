import { join } from 'node:path'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  createIntentApplyEngine,
  type IntentApplyArtifactLifecycle,
  type IntentApplyEngine,
  type IntentApplyResourceBinding,
} from '../infrastructure/intentApplyEngine'
import { createIntentApplyArtifactLifecycle } from '../infrastructure/intentApplyArtifactLifecycle'
import type { SkillContentLocationQuery } from '@/platform/content/contentStore'
import type {
  IntentPluginArtifactOwner,
  IntentSkillArtifactOwner,
} from '@/modules/resource-catalog/public/participants'
import type { IntentArtifactContentPort } from '../application/ports/intentArtifactContent'
import type {
  LegacyIntentSkillArtifactCompat,
  PostgresqlSkillArtifactCompensation,
} from '../ports/skillArtifactCompensation'
import { createFileIntentArtifactContent } from '../infrastructure/local/fileIntentArtifactContent'

import type { IntentApplyOperations } from '../application/ports/intentApplyOperations'

export type { ApplyIntentFaults } from '../infrastructure/intentApplyEngine'
export type { IntentApplyReceipt } from '../application/ports/intentApplyOperations'
export {
  __intentApplyLockCountForTests,
  __withSessionApplyLockForTests,
} from '../infrastructure/intentApplyEngine'

/**
 * RFC-359 —— Intent apply **一台引擎两个 provider**。
 *
 * 此前这里是两条并行的装配线：SQLite 根走 `composeSqliteIntentApplyOperations` +
 * legacy 资源会话（`sqliteIntentApplyOperations.ts` 762 行 +
 * `sqliteIntentApplyArtifactLifecycle.ts` 178 行 + `legacyIntentApplyResourceParticipants.ts`），
 * PostgreSQL 根走 `createIntentApplyEngine` + PG 资源会话。两条线做的是同一件
 * 事——claim → preflight → prepare → 图校验 → prestage → 大事务 → 前滚 → 收敛——而判据
 * 长期只喂其中一侧（`rfc294-apply-replay-recovery-parity` 的存在理由就是「两台 apply 引擎」）。
 *
 * 现在只剩一台：引擎与资源会话全部按 `PersistenceDb` 取参，事务走
 * `databaseSessionFor(db).transaction(...)` 这一个中立原语，两个 provider 共用同一份装配。
 */
export interface IntentApplyCompositionDependencies {
  readonly db: PersistenceDb
  /** RFC-523: the resource session binding the caller composed (the daemon in bootstrap, tests through their helper). */
  readonly resources: IntentApplyResourceBinding
  /** RFC-523: the artifact lifecycle the caller composed. */
  readonly artifacts: IntentApplyArtifactLifecycle
  readonly id?: () => string
  readonly now?: () => number
}

/** Select the complete write and recovery family together at the bootstrap root. */
export interface IntentArtifactSelection {
  readonly pluginArtifacts: IntentPluginArtifactOwner
  readonly skillArtifacts: IntentSkillArtifactOwner
  readonly artifactContent: IntentArtifactContentPort
}

/**
 * RFC-595: what the standalone family takes from Resource Catalog — its file artifact owners and the skill artifact
 * compensation. Resource Catalog composes them (`composeLocalIntentResourceArtifacts`) and bootstrap hands them over, as
 * the hosted family takes `HostedIntentResourceArtifacts`.
 */
export interface LocalIntentResourceArtifacts {
  readonly pluginArtifacts: IntentPluginArtifactOwner
  readonly skillArtifacts: IntentSkillArtifactOwner
  readonly skillArtifactCompensation: PostgresqlSkillArtifactCompensation
}

/**
 * RFC-432: the standalone family for one session — the same three local constructions each member falls back
 * to when a composition is given none (plugins under `appHome/plugins`, skills in the session's database).
 * RFC-595: the two Resource Catalog owners arrive built (bootstrap takes them from Resource Catalog's composition); this
 * assembles them with the local artifact content.
 */
export function composeLocalIntentArtifacts(input: {
  readonly appHome: string
  readonly resources: LocalIntentResourceArtifacts
}): IntentArtifactSelection {
  return Object.freeze({
    pluginArtifacts: input.resources.pluginArtifacts,
    skillArtifacts: input.resources.skillArtifacts,
    artifactContent: composeLocalIntentArtifactContent({
      appHome: input.appHome,
      pluginsDir: join(input.appHome, 'plugins'),
      skillArtifacts: input.resources.skillArtifactCompensation,
    }),
  })
}

/** RFC-523: the standalone artifact content (also the maintenance worker's when the deployment supplies no hosted one). */
export function composeLocalIntentArtifactContent(input: {
  readonly appHome: string
  readonly pluginsDir: string
  /** RFC-595: Resource Catalog's skill artifact compensation, handed over by bootstrap. */
  readonly skillArtifacts: PostgresqlSkillArtifactCompensation
}): IntentArtifactContentPort {
  return createFileIntentArtifactContent({
    appHome: input.appHome,
    pluginsDir: input.pluginsDir,
    skillArtifacts: input.skillArtifacts,
  })
}

/**
 * RFC-355 T6：技能工件的补偿原语归 resource-catalog 所有，intent 只消费端口。
 * 装配发生在 composition 层——engine / application / 兼容门面都不再自己拼 provider。
 */
export function composeIntentApplyArtifactLifecycle(input: {
  readonly db: PersistenceDb
  readonly appHome: string
  readonly pluginsDir?: string
  /** RFC-523: the caller states the artifact content and the legacy skill artifact binding. */
  readonly content: IntentArtifactContentPort
  readonly legacySkillArtifacts: LegacyIntentSkillArtifactCompat
  /** RFC-595: Resource Catalog's skill content-location query, handed over by bootstrap. */
  readonly skillContentLocations: SkillContentLocationQuery
}): IntentApplyArtifactLifecycle {
  const pluginsDir = input.pluginsDir ?? join(input.appHome, 'plugins')
  return createIntentApplyArtifactLifecycle({
    db: input.db,
    appHome: input.appHome,
    pluginsDir,
    content: input.content,
    skillContentLocations: input.skillContentLocations,
    legacySkillArtifacts: input.legacySkillArtifacts,
  })
}

/** The single Intent apply composition. Both bootstrap roots call exactly this. */
export function composeIntentApplyOperations(
  dependencies: IntentApplyCompositionDependencies,
): IntentApplyEngine {
  return createIntentApplyEngine({
    db: dependencies.db,
    resources: dependencies.resources,
    artifacts: dependencies.artifacts,
    ...(dependencies.id === undefined ? {} : { id: dependencies.id }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  })
}

/**
 * RFC-359 —— 两个根此前各有一个「把引擎包成窄端口」的适配函数
 * （`composeSqliteIntentApplyOperations` / `composeIntentApplyOperations`）。
 * 引擎合一之后只剩这一个：`IntentApplyEngine` 本来就 extends
 * `IntentApplyOperations`，窄化是为了让路由层只看见 `apply`。
 */
export function narrowIntentApplyOperations(operations: IntentApplyEngine): IntentApplyOperations {
  return operations
}

/**
 * RFC-355 T4b：会话事件的投递实现（进程内 WS）。三个 bootstrap 根共用这一个装配出口，
 * 免得各自 import 广播器再各拼一份。
 */
export { createIntentSessionWsPublisher } from '../infrastructure/intentSessionWsProjector'
