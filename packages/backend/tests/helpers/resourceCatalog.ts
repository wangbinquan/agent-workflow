// RFC-525 — what the resource-catalog compositions used to build when the caller left a selection out. The compositions now
// take these as required inputs (the daemon always gives them; the package command and the maintenance worker give the local
// ones explicitly). Tests that relied on the fallbacks give them through these helpers; each member is built only when the
// test did not give it, with the same factories and arguments the fallback used.
import { join } from 'node:path'
import type { SkillContentReader } from '@/modules/resource-catalog/application/skills/contentReader'
import type { SkillCreationContentStore } from '@/modules/resource-catalog/application/skills/creationContentStore'
import type { SkillDeletionContentStore } from '@/modules/resource-catalog/application/skills/deletionContentStore'
import type { SkillLifecycleContentStore } from '@/modules/resource-catalog/application/skills/lifecycleContentStore'
import type { SkillPackageContentReader } from '@/modules/resource-catalog/application/skills/packageContentReader'
import type { SkillVersionContentReader } from '@/modules/resource-catalog/application/skills/versionContentReader'
import type { SkillVersionContentStore } from '@/modules/resource-catalog/application/skills/versionContentStore'
import type {
  ResourcePackagePluginArtifactOwner,
  ResourcePackageSkillArtifactOwner,
} from '@/modules/resource-catalog/application/package/artifactOwners'
import type { ResourcePackageRecoveryEffectsFactory } from '@/modules/resource-catalog/application/package/recoveryContentEffects'
import {
  composeLocalResourcePackageArtifactRecovery,
  composeResourcePackageApplyMaintenance,
  requireExclusiveRecoverySelection,
  type ResourcePackageApplyArtifactRecoveryPort,
} from '@/modules/resource-catalog/composition/resourcePackageMaintenance'
import type { SkillVersionCommitParticipantFactory } from '@/modules/resource-catalog/composition/skillVersionCommit'
import { createFileSkillContentReader } from '@/modules/resource-catalog/infrastructure/local/fileSkillContentReader'
import { createFileSkillCreationContentStore } from '@/modules/resource-catalog/infrastructure/local/fileSkillCreationContentStore'
import { createFileSkillDeletionContentStore } from '@/modules/resource-catalog/infrastructure/local/fileSkillDeletionContentStore'
import { createFileSkillLifecycleContentStore } from '@/modules/resource-catalog/infrastructure/local/fileSkillLifecycleContentStore'
import { createFileSkillPackageContentReader } from '@/modules/resource-catalog/infrastructure/local/fileSkillPackageContentReader'
import { createFileSkillTreeContentStore } from '@/modules/resource-catalog/infrastructure/local/fileSkillTreeContentStore'
import { createFileSkillVersionContentReader } from '@/modules/resource-catalog/infrastructure/local/fileSkillVersionContentReader'
import { createFileSkillVersionContentStore } from '@/modules/resource-catalog/infrastructure/local/fileSkillVersionContentStore'
import { createFileSkillVersionPresenceQueries } from '@/modules/resource-catalog/infrastructure/local/fileSkillVersionPresenceQueries'
import {
  createFileResourcePackagePluginArtifactOwner,
  createFileResourcePackageSkillArtifactOwner,
  type FileResourcePackagePluginInstaller,
} from '@/modules/resource-catalog/infrastructure/local/fileResourcePackageArtifacts'
import { createSkillTreeVersionParticipant } from '@/modules/resource-catalog/infrastructure/skillTreeVersionParticipant'
import type { SkillVersionPresenceQueries } from '@/modules/resource-catalog/application/skills/contentAvailability'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createLogger, type Logger } from '@/util/log'

/** `composeSkillCatalog`'s former fallbacks, in their former order: the six local file stores under `appHome`. */
export function standaloneSkillCatalogContent(input: {
  readonly appHome: string
  readonly content?: SkillContentReader
  readonly versionReader?: SkillVersionContentReader
  readonly lifecycleContent?: SkillLifecycleContentStore
  readonly deletionContent?: SkillDeletionContentStore
  readonly versionContent?: SkillVersionContentStore
  readonly creationContent?: SkillCreationContentStore
}) {
  const creationContent =
    input.creationContent ?? createFileSkillCreationContentStore(input.appHome)
  const versionContent = input.versionContent ?? createFileSkillVersionContentStore(input.appHome)
  return {
    content: input.content ?? createFileSkillContentReader(input.appHome),
    versionReader: input.versionReader ?? createFileSkillVersionContentReader(input.appHome),
    lifecycleContent: input.lifecycleContent ?? createFileSkillLifecycleContentStore(input.appHome),
    deletionContent: input.deletionContent ?? createFileSkillDeletionContentStore(input.appHome),
    versionContent,
    creationContent,
  }
}

/** `composeSkillContentAvailability`'s former fallback: the local version presence under `appHome`. */
export function standaloneSkillVersionPresence(
  appHome: string,
  given?: SkillVersionPresenceQueries,
): SkillVersionPresenceQueries {
  return given ?? createFileSkillVersionPresenceQueries(appHome)
}

/** `composeSkillVersionCommitParticipantFactory()`'s former default branch, verbatim: a local tree participant at bind time. */
export function composeStandaloneSkillVersionCommitParticipantFactory(): SkillVersionCommitParticipantFactory {
  return Object.freeze({
    bind(input: { readonly db: PersistenceDb; readonly appHome: string }) {
      return createSkillTreeVersionParticipant({
        db: input.db,
        fs: { appHome: input.appHome },
        trees: createFileSkillTreeContentStore(input.appHome),
      })
    },
  })
}

/** The provider required an installer whenever it built the local plugin owner (the old dependency union). */
function localPluginArtifacts(input: {
  readonly appHome: string
  readonly pluginsDir?: string
  readonly pluginInstaller?: FileResourcePackagePluginInstaller
}): ResourcePackagePluginArtifactOwner {
  if (input.pluginInstaller === undefined)
    throw new Error('resource-package-test: give pluginArtifacts or pluginInstaller')
  return createFileResourcePackagePluginArtifactOwner({
    pluginsDir: input.pluginsDir ?? join(input.appHome, 'plugins'),
    installer: input.pluginInstaller,
  })
}

/** The resource-package provider's former fallbacks, in their former order: plugin owner, skill owner, package content. */
export function standaloneResourcePackageProviderSelections(input: {
  readonly db: PersistenceDb
  readonly appHome: string
  readonly pluginsDir?: string
  readonly pluginInstaller?: FileResourcePackagePluginInstaller
  readonly pluginArtifacts?: ResourcePackagePluginArtifactOwner
  readonly skillArtifacts?: ResourcePackageSkillArtifactOwner
  readonly skillPackageContent?: SkillPackageContentReader
}): {
  readonly pluginArtifacts: ResourcePackagePluginArtifactOwner
  readonly skillArtifacts: ResourcePackageSkillArtifactOwner
  readonly skillPackageContent: SkillPackageContentReader
} {
  const pluginArtifacts = input.pluginArtifacts ?? localPluginArtifacts(input)
  const skillArtifacts =
    input.skillArtifacts ??
    createFileResourcePackageSkillArtifactOwner({ db: input.db, appHome: input.appHome })
  return {
    pluginArtifacts,
    skillArtifacts,
    skillPackageContent:
      input.skillPackageContent ?? createFileSkillPackageContentReader(input.appHome),
  }
}

/**
 * `composeResourcePackageApplyMaintenance`'s former shape: the local versioned recovery unless the test selected one, with
 * the original conflict check (selecting both a recovery and recovery-content effects is still an error).
 */
export function composeStandaloneResourcePackageApplyMaintenance(input: {
  readonly db: PersistenceDb
  readonly appHome: string
  readonly pluginsDir: string
  readonly activitySource?: Parameters<
    typeof composeResourcePackageApplyMaintenance
  >[0]['activitySource']
  readonly artifacts?: ResourcePackageApplyArtifactRecoveryPort
  readonly recoveryEffectsFactory?: ResourcePackageRecoveryEffectsFactory
  readonly now?: () => number
  readonly log?: Logger
}): ReturnType<typeof composeResourcePackageApplyMaintenance> {
  const log = input.log ?? createLogger('resourcePackageMaintenance')
  requireExclusiveRecoverySelection(input)
  return composeResourcePackageApplyMaintenance({
    db: input.db,
    activitySource: input.activitySource,
    artifacts:
      input.artifacts ??
      composeLocalResourcePackageArtifactRecovery({
        db: input.db,
        appHome: input.appHome,
        pluginsDir: input.pluginsDir,
        recoveryEffectsFactory: input.recoveryEffectsFactory,
        log,
      }),
    now: input.now,
    log,
  })
}
