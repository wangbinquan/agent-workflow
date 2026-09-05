import type { Plugin } from '@agent-workflow/shared'
import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '@/db/query'
import { checkForUpdate, cleanupInstallGeneration, installPlugin } from '@/services/pluginInstaller'
import { monotonicNow } from '@/util/time'
import { createPluginApplication } from '../application/plugins/pluginApplication'
import type {
  PluginAccessPort,
  PluginInstallerPort,
  PluginMutationClock,
  PluginOperationCoordinatorPort,
  PluginProjection,
  PluginRepository,
} from '../application/plugins/ports'
import type { PluginOperationContext } from '../public/participants'
import { createPluginRepository } from '../infrastructure/pluginRepository'
import { composeProviderResourceAclOperationApplication } from './resourceAcl'
import type { ProviderResourceCatalogComposition } from './providerResourceCatalog'
import { createPluginOperationDescriptors } from './catalogOperationDescriptors'
import type { PluginCatalogModule } from '../public/operations'

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

/**
 * RFC-359 W4-D17 —— Plugin 目录一份装配（此前 SQLite / PG 各一份）：仓库是中立的 `createPluginRepository`，访问判定与
 * ACL 操作都经资源目录的 provider 中立应用；bootstrap 不再拿数据库句柄重建访问阶梯。
 */
export interface PluginCatalogCompositionDependencies extends Omit<
  PluginCatalogAdapterCompositionDependencies,
  'repository' | 'projection' | 'access' | 'acl'
> {
  readonly db: ProviderNeutralDatabase
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

export function composePluginCatalog(
  input: PluginCatalogCompositionDependencies,
): PluginCatalogModule {
  const { repository, projection } = createPluginRepository({ db: input.db })
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
