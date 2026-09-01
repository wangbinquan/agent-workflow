import { join } from 'node:path'

import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { ResourceCurrentAuthorityResolver } from '../application/participants/resourceAuthorization'
import {
  createPostgresqlResourcePackageMutationSessionFactory,
  type PostgresqlCapabilityTemplatePackageMutationOwner,
  type PostgresqlResourcePackageMutationSessionFactory,
} from '../infrastructure/aggregateAdapters/postgresqlResourcePackageMutationParticipants'
import type { PostgresqlMcpTransactionLifecycle } from '../infrastructure/postgresqlMcpRepository'
import {
  createPostgresqlResourcePackageOwnedResourceLookup,
  createPostgresqlResourcePackageReadPort,
} from '../infrastructure/postgresqlPackageResourceRows'
import {
  createPostgresqlResourcePackagePluginArtifactOwner,
  createPostgresqlResourcePackageSkillArtifactOwner,
  readPostgresqlPackageSkillTree,
  type PostgresqlResourcePackagePluginInstaller,
} from '../infrastructure/postgresqlResourcePackageArtifacts'
import {
  composeResourcePackageOperations,
  type ComposedResourcePackageCatalog,
  type ResourcePackageExecutionAdapter,
  type ResourcePackageProviderComposition,
} from './resourcePackageOperations'

export interface PostgresqlResourcePackageProviderComposition extends ResourcePackageProviderComposition {
  readonly mutationSessionFactory: PostgresqlResourcePackageMutationSessionFactory
}

export interface PostgresqlResourcePackageProviderDependencies {
  readonly db: PostgresqlDatabaseClient
  readonly appHome: string
  readonly authorityResolver: ResourceCurrentAuthorityResolver
  readonly mcpLifecycle: PostgresqlMcpTransactionLifecycle
  readonly capabilityTemplates: PostgresqlCapabilityTemplatePackageMutationOwner
  readonly pluginInstaller: PostgresqlResourcePackagePluginInstaller
  readonly pluginsDir?: string
  readonly id?: () => string
  readonly now?: () => number
}

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
  const mutationSessionFactory = createPostgresqlResourcePackageMutationSessionFactory({
    authorityResolver: input.authorityResolver,
    mcpLifecycle: input.mcpLifecycle,
    pluginArtifacts: createPostgresqlResourcePackagePluginArtifactOwner({
      pluginsDir,
      installer: input.pluginInstaller,
    }),
    skillArtifacts: createPostgresqlResourcePackageSkillArtifactOwner({
      appHome: input.appHome,
    }),
    capabilityTemplates: input.capabilityTemplates,
    ...(input.id === undefined ? {} : { id: input.id }),
    ...(input.now === undefined ? {} : { now: input.now }),
  })
  return Object.freeze({
    resources: createPostgresqlResourcePackageOwnedResourceLookup(input.db),
    reads: createPostgresqlResourcePackageReadPort(input.db),
    readSkillTree: (skillId: string) =>
      readPostgresqlPackageSkillTree(input.db, input.appHome, skillId),
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
