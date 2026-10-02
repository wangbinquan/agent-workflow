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
