import type { SkillPackageContentReader } from '../application/skills/packageContentReader'
import type {
  ResourcePackagePluginArtifactOwner,
  ResourcePackageSkillArtifactOwner,
} from '../application/package/artifactOwners'
import { join } from 'node:path'

import type { ProviderNeutralDatabase } from '@/db/query'
import type { ResourceCurrentAuthorityResolver } from '../application/participants/resourceAuthorization'
import {
  createPostgresqlResourcePackageMutationSessionFactory,
  type PostgresqlCapabilityTemplatePackageMutationOwner,
  type PostgresqlResourcePackageMutationSessionFactory,
} from '../infrastructure/aggregateAdapters/postgresqlResourcePackageMutationParticipants'
import type { McpTransactionLifecycle } from '../infrastructure/mcpRepository'
import {
  createFileResourcePackagePluginArtifactOwner,
  createFileResourcePackageSkillArtifactOwner,
  type FileResourcePackagePluginInstaller,
} from '../infrastructure/local/fileResourcePackageArtifacts'
import { composeResourcePackageProvider } from './resourcePackageProvider'
import {
  composeResourcePackageOperations,
  type ComposedResourcePackageCatalog,
  type ResourcePackageExecutionAdapter,
  type ResourcePackageProviderComposition,
} from './resourcePackageOperations'

export type {
  ResourcePackageSkillArtifactOwner,
  ResourcePackagePluginArtifactOwner,
  SkillPackageContentReader,
}

export interface PostgresqlResourcePackageProviderComposition extends ResourcePackageProviderComposition {
  readonly mutationSessionFactory: PostgresqlResourcePackageMutationSessionFactory
}

interface PostgresqlResourcePackageProviderBaseDependencies {
  readonly db: ProviderNeutralDatabase
  readonly appHome: string
  readonly skillPackageContent?: SkillPackageContentReader
  readonly skillArtifacts?: ResourcePackageSkillArtifactOwner
  readonly authorityResolver: ResourceCurrentAuthorityResolver
  readonly mcpLifecycle: McpTransactionLifecycle
  readonly capabilityTemplates: PostgresqlCapabilityTemplatePackageMutationOwner
  readonly pluginsDir?: string
  readonly id?: () => string
  readonly now?: () => number
}

export type PostgresqlResourcePackageProviderDependencies =
  PostgresqlResourcePackageProviderBaseDependencies &
    (
      | Readonly<{
          pluginArtifacts: ResourcePackagePluginArtifactOwner
          pluginInstaller?: FileResourcePackagePluginInstaller
        }>
      | Readonly<{
          pluginArtifacts?: undefined
          pluginInstaller: FileResourcePackagePluginInstaller
        }>
    )

export interface PostgresqlResourcePackageCatalogDependencies {
  readonly provider: PostgresqlResourcePackageProviderComposition
  readonly execution: ResourcePackageExecutionAdapter
  readonly id?: () => string
}

/** Provider-owned reads, artifact owners, and request-local seven-arm sessions. */
export function composePostgresqlResourcePackageProvider(
  input: PostgresqlResourcePackageProviderDependencies,
): PostgresqlResourcePackageProviderComposition {
  const pluginsDir = input.pluginsDir ?? join(input.appHome, 'plugins')
  const pluginArtifacts =
    input.pluginArtifacts !== undefined
      ? input.pluginArtifacts
      : createFileResourcePackagePluginArtifactOwner({
          pluginsDir,
          installer: input.pluginInstaller,
        })
  const mutationSessionFactory = createPostgresqlResourcePackageMutationSessionFactory({
    authorityResolver: input.authorityResolver,
    mcpLifecycle: input.mcpLifecycle,
    pluginArtifacts,
    skillArtifacts:
      input.skillArtifacts ??
      createFileResourcePackageSkillArtifactOwner({
        appHome: input.appHome,
      }),
    capabilityTemplates: input.capabilityTemplates,
    ...(input.id === undefined ? {} : { id: input.id }),
    ...(input.now === undefined ? {} : { now: input.now }),
  })
  return Object.freeze({
    ...composeResourcePackageProvider(input),
    mutationSessionFactory,
  })
}

/**
 * Binds the provider-neutral ResourcePackage application to the W6 execution
 * adapter selected by bootstrap. Provider reads/session factories are composed
 * separately so the external lifecycle owner can build that adapter without a
 * Resource Catalog -> service dependency.
 */
export function composePostgresqlResourcePackageCatalog(
  input: PostgresqlResourcePackageCatalogDependencies,
): ComposedResourcePackageCatalog {
  return composeResourcePackageOperations({
    execution: input.execution,
    resources: input.provider.resources,
    ...(input.id === undefined ? {} : { id: input.id }),
  })
}
