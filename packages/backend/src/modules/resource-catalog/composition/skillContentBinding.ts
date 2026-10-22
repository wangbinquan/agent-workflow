import type { ClassicCatalogCompositionDependencies } from './classicCatalogs'
import type { composeSkillCatalogBoot } from './skillCatalogBoot'
import type { SkillTreeContentStore } from '../application/skills/treeContentStore'

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
  /** RFC-370 §10 V20: strict version trees and fusion candidates; absent → the
   * local store under `rootReference`. */
  readonly treeContent?: SkillTreeContentStore
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

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { SkillPackageContentReader } from '../application/skills/packageContentReader'
import { createDatabaseSkillContent } from '../infrastructure/databaseSkillContent'

/** RFC-370 — skill content selections of a CrewStation-hosted control plane.
 * Plugin installation and resource-package artifacts are the hosted artifact
 * owners (`composeCrewStationResourceArtifacts`, M2). */
export interface CrewStationResourceContentSelections {
  readonly skillContent: SkillContentBinding
  readonly resourcePackageSkillContent: SkillPackageContentReader
}

/** Skill trees live in the database (the service slot has no persistent disk). */
export function composeCrewStationResourceContent(input: {
  readonly db: PersistenceDb
}): CrewStationResourceContentSelections {
  const skills = createDatabaseSkillContent({ db: input.db })
  return Object.freeze({
    skillContent: skills,
    resourcePackageSkillContent: skills.packageContent,
  })
}
