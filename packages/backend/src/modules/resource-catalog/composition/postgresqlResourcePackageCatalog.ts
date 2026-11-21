import type { SkillPackageContentReader } from '../application/skills/packageContentReader'
import type {
  ResourcePackagePluginArtifactOwner,
  ResourcePackageSkillArtifactOwner,
} from '../application/package/artifactOwners'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { ResourceCurrentAuthorityResolver } from '../application/participants/resourceAuthorization'
import {
  createPostgresqlResourcePackageMutationSessionFactory,
  type PostgresqlCapabilityTemplatePackageMutationOwner,
  type PostgresqlResourcePackageMutationSessionFactory,
} from '../infrastructure/aggregateAdapters/postgresqlResourcePackageMutationParticipants'
import type { McpTransactionLifecycle } from '../infrastructure/mcpRepository'
import { currentPluginSpecReader } from '../infrastructure/pluginPersistence'
import {
  createFileResourcePackagePluginArtifactOwner,
  createFileResourcePackageSkillArtifactOwner,
} from '../infrastructure/local/fileResourcePackageArtifacts'
import { composeResourcePackageProvider } from './resourcePackageProvider'
import { createResourcePackageAtomicApplyOperations } from './resourcePackageAtomicApply'
import { createPostgresqlResourcePackageExecutionAdapter } from './resourcePackageExecution'
import { createResourceAuthorityRegistry } from '../application/participants/resourceAuthorityRegistry'
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
/** RFC-431: the standalone selection — plugin generations under a local plugin root. */
export { createFileResourcePackagePluginArtifactOwner }
/** RFC-432: the standalone session factory — package skill artifacts in the session's database and app home. */
export { createFileResourcePackageSkillArtifactOwner }
/** RFC-525: the standalone package content — the local skill package reader under an app home. */
export { createFileSkillPackageContentReader } from '../infrastructure/local/fileSkillPackageContentReader'

export interface PostgresqlResourcePackageProviderComposition extends ResourcePackageProviderComposition {
  readonly mutationSessionFactory: PostgresqlResourcePackageMutationSessionFactory
}

/** RFC-525: the package content and both artifact owners are the caller's selections (daemon: the deployment's; the
 * package command: the local ones this file offers). */
export interface PostgresqlResourcePackageProviderDependencies {
  readonly db: PersistenceDb
  readonly appHome: string
  readonly skillPackageContent: SkillPackageContentReader
  readonly skillArtifacts: ResourcePackageSkillArtifactOwner
  readonly pluginArtifacts: ResourcePackagePluginArtifactOwner
  readonly authorityResolver: ResourceCurrentAuthorityResolver
  readonly mcpLifecycle: McpTransactionLifecycle
  readonly capabilityTemplates: PostgresqlCapabilityTemplatePackageMutationOwner
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
  const mutationSessionFactory = createPostgresqlResourcePackageMutationSessionFactory({
    authorityResolver: input.authorityResolver,
    currentPluginSpec: currentPluginSpecReader(input.db),
    mcpLifecycle: input.mcpLifecycle,
    pluginArtifacts: input.pluginArtifacts,
    skillArtifacts: input.skillArtifacts,
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

/** Every arm of the provider dependencies, without the authority resolver the runtime owns. */
type WithoutAuthorityResolver<T> = T extends unknown ? Omit<T, 'authorityResolver'> : never

export type ResourcePackageRuntimeDependencies =
  WithoutAuthorityResolver<PostgresqlResourcePackageProviderDependencies> & {
    readonly box: Parameters<typeof createResourcePackageAtomicApplyOperations>[0]['box']
  }

/**
 * RFC-520 — the one resource-package graph the package command and the daemon routes share: the provider, the atomic apply
 * and the catalog over them, with the authority registry the provider resolves actors through. Each caller registers the
 * actor of every context it hands out.
 */
export function composeResourcePackageRuntime(input: ResourcePackageRuntimeDependencies) {
  const authorities = createResourceAuthorityRegistry()
  const provider = composePostgresqlResourcePackageProvider({
    ...input,
    authorityResolver: authorities.resolver,
  })
  const atomicApply = createResourcePackageAtomicApplyOperations({ db: input.db, box: input.box })
  const catalog = composePostgresqlResourcePackageCatalog({
    provider,
    execution: createPostgresqlResourcePackageExecutionAdapter({
      box: input.box,
      provider,
      atomicApply,
    }),
  })
  return Object.freeze({ provider, atomicApply, catalog, registerAuthority: authorities.register })
}
