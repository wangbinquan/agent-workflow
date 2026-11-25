// RFC-523 — intent apply composed the way the composition used to when a caller gave nothing but `db` + `appHome`: the standalone
// artifact owners and content, the legacy skill artifact binding, a fresh MCP transaction lifecycle and the ACL identity read port
// over the database. The composition now takes the resource binding and the artifact lifecycle from its caller; tests take them here.
import type { Actor } from '../../src/auth/actor'
import { join } from 'node:path'
import {
  composeIntentApplyArtifactLifecycle,
  composeIntentApplyOperations,
  composeLocalIntentArtifactContent,
  type ApplyIntentFaults,
} from '../../src/modules/intent/composition/apply'
import type { IntentArtifactContentPort } from '../../src/modules/intent/application/ports/intentArtifactContent'
import type { IntentApplyEngine } from '../../src/modules/intent/infrastructure/intentApplyEngine'
import type { LegacyIntentSkillArtifactCompat } from '../../src/modules/intent/ports/skillArtifactCompensation'
import type { ResourceCatalogAclIdentityReadPort } from '../../src/modules/resource-catalog/application/ports/providerResourceCatalogPersistence'
import {
  composeIntentApplyResourceBinding,
  composeLegacyIntentSkillArtifactCompat,
  createFileIntentPluginArtifactOwner,
  createFileIntentSkillArtifactOwner,
} from '../../src/modules/resource-catalog/composition/intentApply'
import { createMcpTransactionLifecycle } from '../../src/modules/resource-catalog/composition/mcpRuntimeTestPersistence'
import { createResourceCatalogAclIdentityReadPort } from '../../src/modules/resource-catalog/infrastructure/aclReadRepository'
import type {
  IntentPluginArtifactOwner,
  IntentSkillArtifactOwner,
  ResourceRequestContext,
} from '../../src/modules/resource-catalog/public/participants'
import type { PersistenceDb } from '../../src/platform/persistence/persistenceDb'
import type { Logger } from '../../src/platform/logging/logger'

/** The artifact lifecycle the compositions used to build (plugins under `appHome/plugins` unless a test names the directory). */
export function composeStandaloneIntentArtifacts(input: {
  readonly db: PersistenceDb
  readonly appHome: string
  readonly pluginsDir?: string
  readonly content?: IntentArtifactContentPort
  readonly legacySkillArtifacts?: LegacyIntentSkillArtifactCompat
}) {
  const pluginsDir = input.pluginsDir ?? join(input.appHome, 'plugins')
  return composeIntentApplyArtifactLifecycle({
    db: input.db,
    appHome: input.appHome,
    pluginsDir,
    content:
      input.content ?? composeLocalIntentArtifactContent({ appHome: input.appHome, pluginsDir }),
    legacySkillArtifacts: input.legacySkillArtifacts ?? composeLegacyIntentSkillArtifactCompat(),
  })
}

/** The resource binding and artifact lifecycle the composition used to build; any member a test gives replaces the standalone one. */
export function composeStandaloneIntentApply(input: {
  readonly db: PersistenceDb
  readonly appHome: string
  readonly aclIdentities?: ResourceCatalogAclIdentityReadPort
  readonly pluginArtifacts?: IntentPluginArtifactOwner
  readonly skillArtifacts?: IntentSkillArtifactOwner
  readonly artifactContent?: IntentArtifactContentPort
  readonly legacySkillArtifacts?: LegacyIntentSkillArtifactCompat
}) {
  // Each standalone member is built only when the test gives none, exactly as the old per-member fallbacks did.
  const pluginsDir = join(input.appHome, 'plugins')
  return {
    resources: composeIntentApplyResourceBinding({
      db: input.db,
      mcpLifecycle: createMcpTransactionLifecycle(),
      pluginArtifacts: input.pluginArtifacts ?? createFileIntentPluginArtifactOwner({ pluginsDir }),
      skillArtifacts:
        input.skillArtifacts ??
        createFileIntentSkillArtifactOwner({ appHome: input.appHome, db: input.db }),
      aclIdentities: input.aclIdentities ?? createResourceCatalogAclIdentityReadPort(input.db),
    }),
    artifacts: composeStandaloneIntentArtifacts({
      db: input.db,
      appHome: input.appHome,
      ...(input.artifactContent === undefined ? {} : { content: input.artifactContent }),
      ...(input.legacySkillArtifacts === undefined
        ? {}
        : { legacySkillArtifacts: input.legacySkillArtifacts }),
    }),
  }
}

/**
 * RFC-355 T7 的便捷入口（原在 intent 的组合层）：给 db + appHome，按单机装好资源会话与工件生命周期再跑 apply。RFC-523 起只有用例
 * 调用，移到这里。
 */
export interface ApplyIntentDeps {
  readonly db: PersistenceDb
  readonly appHome: string
  readonly actor: Actor
  readonly authority: ResourceRequestContext
  readonly aclIdentities?: ResourceCatalogAclIdentityReadPort
  readonly faults?: ApplyIntentFaults
  readonly log?: Logger
}

export function applyIntentChangeset(
  dependencies: ApplyIntentDeps,
  input: Parameters<IntentApplyEngine['apply']>[0]['command'],
) {
  return composeIntentApplyOperations({
    db: dependencies.db,
    ...composeStandaloneIntentApply({
      db: dependencies.db,
      appHome: dependencies.appHome,
      ...(dependencies.aclIdentities === undefined
        ? {}
        : { aclIdentities: dependencies.aclIdentities }),
    }),
  }).apply({
    actor: dependencies.actor,
    authority: dependencies.authority,
    command: input,
    ...(dependencies.faults === undefined ? {} : { faults: dependencies.faults }),
    ...(dependencies.log === undefined ? {} : { log: dependencies.log }),
  })
}
