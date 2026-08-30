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
} from '../application/plugins/ports'
import type { PluginOperationContext } from '../public/participants'
import { createPluginAclIdentityParticipant } from '../application/participants/pluginAclIdentity'
import { createSqlitePluginRepository } from '../infrastructure/sqlitePluginRepository'
import {
  canViewResource,
  discloseRefs,
  filterVisibleRows,
  requireResourceEdit,
  requireResourceGovern,
} from './resourceAcl'
import { createPluginOperationDescriptors, type PluginCatalogModule } from '../public/operations'

export interface PluginCatalogCompositionDependencies {
  readonly db: DbClient
  readonly coordinator: PluginOperationCoordinatorPort
  readonly installer?: PluginInstallerPort
  readonly id?: () => string
  readonly now?: () => number
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
  const application = createPluginApplication({
    repository,
    projection,
    access,
    coordinator: input.coordinator,
    installer: input.installer ?? createLegacyPluginInstaller(),
    clock,
    id: input.id ?? ulid,
    now: input.now ?? Date.now,
  })
  const aclIdentity = createPluginAclIdentityParticipant({ repository, clock })
  const operations = createPluginOperationDescriptors(
    application.commands,
    application.updateCommands,
    application.queries,
  )
  return Object.freeze({
    commands: application.commands,
    updateCommands: application.updateCommands,
    queries: application.queries,
    operations,
    participants: Object.freeze({ aclIdentity }),
  })
}
