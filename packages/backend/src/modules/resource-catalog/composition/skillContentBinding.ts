import type { ClassicCatalogCompositionDependencies } from './classicCatalogs'
import type { composeSkillCatalogBoot } from './skillCatalogBoot'

type CatalogContent = Required<
  Pick<
    ClassicCatalogCompositionDependencies,
    | 'content'
    | 'versionReader'
    | 'lifecycleContent'
    | 'deletionContent'
    | 'versionContent'
    | 'creationContent'
    | 'versionPresence'
  >
>
type BootContent = Required<Omit<Parameters<typeof composeSkillCatalogBoot>[0], 'db' | 'appHome'>>

/** One complete store selection serves editing, availability and restart recovery. */
export interface SkillContentBinding extends CatalogContent, BootContent {
  /** Logical namespace for the owner's existing persisted content references. */
  readonly rootReference: string
}

/** Read every capability explicitly; complete bindings may expose prototype getters. */
export function selectSkillContentDependencies(
  binding: SkillContentBinding | undefined,
  defaultRootReference: string,
): Pick<ClassicCatalogCompositionDependencies, 'appHome'> & Partial<CatalogContent & BootContent> {
  if (binding === undefined) return Object.freeze({ appHome: defaultRootReference })
  return Object.freeze({
    appHome: binding.rootReference,
    content: binding.content,
    versionReader: binding.versionReader,
    lifecycleContent: binding.lifecycleContent,
    deletionContent: binding.deletionContent,
    versionContent: binding.versionContent,
    creationContent: binding.creationContent,
    versionPresence: binding.versionPresence,
    snapshotInspector: binding.snapshotInspector,
    versionRecovery: binding.versionRecovery,
    identityContent: binding.identityContent,
    identityInspector: binding.identityInspector,
  })
}

import type { ProviderNeutralDatabase } from '@/db/query'
import type {
  ResourcePackagePluginArtifactOwner,
  ResourcePackageSkillArtifactOwner,
} from '../application/package/artifactOwners'
import type { PluginInstallerPort } from '../application/plugins/ports'
import type { SkillPackageContentReader } from '../application/skills/packageContentReader'
import { createDatabaseSkillContent } from '../infrastructure/databaseSkillContent'
import {
  createHostedPluginInstaller,
  createHostedResourcePackageArtifacts,
} from '../infrastructure/crewstation/hostedResourceCapabilities'

/** RFC-370 M0 — resource content selections of a CrewStation-hosted control plane. */
export interface CrewStationResourceContentSelections {
  readonly skillContent: SkillContentBinding
  readonly resourcePackageSkillContent: SkillPackageContentReader
  readonly pluginInstaller: PluginInstallerPort
  readonly resourcePackageSkillArtifacts: ResourcePackageSkillArtifactOwner
  readonly resourcePackagePluginArtifacts: ResourcePackagePluginArtifactOwner
}

/**
 * Skill trees live in the database (the service slot has no persistent disk);
 * plugin installation and resource packages wait for the platform's native
 * configuration overlay and are refused with the reason until then.
 */
export function composeCrewStationResourceContent(input: {
  readonly db: ProviderNeutralDatabase
}): CrewStationResourceContentSelections {
  const skills = createDatabaseSkillContent({ db: input.db })
  const packages = createHostedResourcePackageArtifacts()
  return Object.freeze({
    skillContent: skills,
    resourcePackageSkillContent: skills.packageContent,
    pluginInstaller: createHostedPluginInstaller(),
    resourcePackageSkillArtifacts: packages.skills,
    resourcePackagePluginArtifacts: packages.plugins,
  })
}
