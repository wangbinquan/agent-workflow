import type { Plugin } from '@agent-workflow/shared'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { checkForUpdate, cleanupInstallGeneration, installPlugin } from '@/services/pluginInstaller'
import { monotonicNow } from '@/util/time'
import { createPluginApplication } from '../application/plugins/pluginApplication'
import type {
  PluginAccessPort,
  PluginAgentReference,
  PluginInstallerPort,
  PluginMutationClock,
  PluginOperationCoordinatorPort,
  PluginProjection,
  PluginRepository,
} from '../application/plugins/ports'
import type { PluginOperationContext } from '../public/participants'
import { createSqlitePluginRepository } from '../infrastructure/sqlitePluginRepository'
import { createPostgresqlPluginRepository } from '../infrastructure/postgresqlPluginRepository'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  canViewResource,
  composeProviderResourceAclOperationApplication,
  composeResourceAclOperationApplication,
  discloseRefs,
  filterVisibleRows,
  requireResourceEdit,
  requireResourceGovern,
} from './resourceAcl'
import type { ProviderResourceCatalogComposition } from './providerResourceCatalog'
import { createPluginOperationDescriptors } from './catalogOperationDescriptors'
import type { PluginCatalogModule } from '../public/operations'

export interface PluginCatalogCompositionDependencies {
  readonly db: DbClient
  readonly coordinator: PluginOperationCoordinatorPort
  readonly installer?: PluginInstallerPort
  readonly id?: () => string
  readonly now?: () => number
}

type PluginAclOperationApplication = Parameters<typeof createPluginOperationDescriptors>[3]

export interface PluginCatalogAdapterCompositionDependencies {
  readonly repository: PluginRepository
  readonly projection: PluginProjection
  readonly access: PluginAccessPort
  readonly acl: PluginAclOperationApplication
  readonly coordinator: PluginOperationCoordinatorPort
  readonly installer?: PluginInstallerPort
  readonly id?: () => string
  readonly now?: () => number
}

export interface PostgresqlPluginCatalogCompositionDependencies extends Omit<
  PluginCatalogAdapterCompositionDependencies,
  'repository' | 'projection' | 'access' | 'acl'
> {
  readonly db: PostgresqlDatabaseClient
  readonly resourceCatalog: Pick<ProviderResourceCatalogComposition, 'authorization' | 'acl'>
}

function createLegacyPluginInstaller(): PluginInstallerPort {
  return Object.freeze({
    async install(pluginId: string, spec: string) {
      const installed = await installPlugin(pluginId, spec)
      return Object.freeze({
        sourceKind: installed.sourceKind,
        cachedPath: installed.cachedPath,
        resolvedVersion: installed.resolvedVersion,
        cleanup: () => cleanupInstallGeneration(installed),
      })
    },
    checkForUpdate: (pluginId: string, spec: string, currentCachedPath: string) =>
      checkForUpdate(pluginId, spec, currentCachedPath),
  })
}

export function composePluginCatalogFromAdapters(
  input: PluginCatalogAdapterCompositionDependencies,
): PluginCatalogModule {
  const clock: PluginMutationClock = Object.freeze({
    nextUpdatedAt: (plugin: Plugin) => monotonicNow(plugin.updatedAt),
    nextInstalledAt: (plugin: Plugin) => monotonicNow(plugin.installedAt),
  })
  const application = createPluginApplication({
    repository: input.repository,
    projection: input.projection,
    access: input.access,
    coordinator: input.coordinator,
    installer: input.installer ?? createLegacyPluginInstaller(),
    clock,
    id: input.id ?? ulid,
    now: input.now ?? Date.now,
  })
  const operations = createPluginOperationDescriptors(
    application.commands,
    application.updateCommands,
    application.queries,
    input.acl,
  )
  return Object.freeze({ queries: application.queries, operations })
}

export function composePostgresqlPluginCatalog(
  input: PostgresqlPluginCatalogCompositionDependencies,
): PluginCatalogModule {
  const { repository, projection } = createPostgresqlPluginRepository(input.db)
  const access = Object.freeze({
    filterVisible: (authority, rows) =>
      input.resourceCatalog.authorization.filterVisibleRows(authority, 'plugin', rows),
    canView: (authority, row) =>
      input.resourceCatalog.authorization.canViewResource(authority, 'plugin', row),
    requireResourceEdit: async (authority, row) => {
      await input.resourceCatalog.authorization.requireResourceEdit(authority, 'plugin', row)
    },
    requireResourceGovern: (authority, row) =>
      input.resourceCatalog.authorization.requireResourceGovern(authority, 'plugin', row),
    discloseAgentReferences: (authority, references) =>
      input.resourceCatalog.authorization.discloseRefs(authority, 'agent', references),
  } satisfies PluginAccessPort)
  const clock = Object.freeze({
    nextUpdatedAt: (plugin) => monotonicNow(plugin.updatedAt),
    nextInstalledAt: (plugin) => monotonicNow(plugin.installedAt),
  } satisfies PluginMutationClock)
  const acl = composeProviderResourceAclOperationApplication<
    PluginOperationContext,
    'plugin',
    Plugin
  >({
    ...input.resourceCatalog,
    type: 'plugin',
    load: (id) => repository.get(id),
    linearizer: {
      runExclusive: (resourceId, task) => input.coordinator.runExclusive(resourceId, task),
      loadById: (resourceId) => repository.get(resourceId),
      nextUpdatedAt: async (row) => clock.nextUpdatedAt(row),
    },
  })
  return composePluginCatalogFromAdapters({ ...input, repository, projection, access, acl })
}

export function composePluginCatalog(
  input: PluginCatalogCompositionDependencies,
): PluginCatalogModule {
  const { repository, projection } = createSqlitePluginRepository(input.db)
  const access: PluginAccessPort = Object.freeze({
    filterVisible: (authority: PluginOperationContext, rows: readonly Plugin[]) =>
      filterVisibleRows<Plugin>(input.db, authority, 'plugin', rows),
    canView: (authority: PluginOperationContext, row: Plugin) =>
      canViewResource(input.db, authority, 'plugin', row),
    requireResourceEdit: async (authority: PluginOperationContext, row: Plugin) => {
      await requireResourceEdit(input.db, authority, 'plugin', row)
    },
    requireResourceGovern: (authority: PluginOperationContext, row: Plugin) =>
      requireResourceGovern(input.db, authority, 'plugin', row),
    discloseAgentReferences: (
      authority: PluginOperationContext,
      references: readonly PluginAgentReference[],
    ) => discloseRefs(input.db, authority, 'agent', references),
  })
  const clock: PluginMutationClock = Object.freeze({
    nextUpdatedAt: (plugin: Plugin) => monotonicNow(plugin.updatedAt),
    nextInstalledAt: (plugin: Plugin) => monotonicNow(plugin.installedAt),
  })
  const acl = composeResourceAclOperationApplication<PluginOperationContext, Plugin>({
    db: input.db,
    type: 'plugin',
    load: (id) => repository.get(id),
    linearizer: {
      runExclusive: (resourceId, task) => input.coordinator.runExclusive(resourceId, task),
      loadById: (resourceId) => repository.get(resourceId),
      nextUpdatedAt: async (row) => clock.nextUpdatedAt(row),
    },
  })
  return composePluginCatalogFromAdapters({
    repository,
    projection,
    access,
    acl,
    coordinator: input.coordinator,
    installer: input.installer,
    id: input.id,
    now: input.now,
  })
}
