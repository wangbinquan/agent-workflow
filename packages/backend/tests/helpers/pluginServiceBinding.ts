// RFC-031 / RFC-345 — test-only PluginCatalog compatibility helpers.
//
// Production callers consume the typed Resource Catalog module directly. These
// helpers retain the focused legacy-behaviour fixtures without keeping a
// zero-production-consumer service facade under src/services.

import {
  CreatePluginSchema,
  type Plugin,
  type RenamePlugin,
  type UpdatePlugin,
} from '@agent-workflow/shared'
import type { z } from 'zod'
import { buildActor, type Actor } from '../../src/auth/actor'
import type { DbClient } from '../../src/db/client'
import { AuthorityClaimRegistry } from '../../src/modules/identity-access/application/operationContext'
import type {
  PluginAccessPort,
  PluginAgentReference,
  PluginInstallerPort,
  PluginRepository,
} from '../../src/modules/resource-catalog/application/plugins/ports'
import { composePluginCatalogFromAdapters } from '../../src/modules/resource-catalog/composition/pluginOperations'
import {
  canViewResource,
  composeResourceAclOperationApplication,
  discloseRefs,
  filterVisibleRows,
  requireResourceEdit,
  requireResourceGovern,
} from '../../src/modules/resource-catalog/composition/resourceAcl'
import { createSqlitePluginRepository } from '../../src/modules/resource-catalog/infrastructure/sqlitePluginRepository'
import type { PluginCatalogModule } from '../../src/modules/resource-catalog/public/operations'
import type { PluginOperationContext } from '../../src/modules/resource-catalog/public/participants'
import {
  checkForUpdate,
  cleanupInstallGeneration,
  installPlugin,
} from '../../src/services/pluginInstaller'
import { ResourceOperationCoordinator } from '../../src/services/resourceOperationCoordinator'
import { NotFoundError } from '../../src/util/errors'
import { monotonicNow } from '../../src/util/time'

type CreatePluginInput = z.input<typeof CreatePluginSchema>

export interface PluginServiceBinding {
  readonly catalog: PluginCatalogModule
  readonly authority: PluginOperationContext
}

export interface PluginServiceTestCompositionOptions {
  readonly actor?: Actor
  readonly pluginsDir?: string
  readonly npmBin?: string
  readonly installTimeoutMs?: number
  readonly beforePublish?: (
    captured: Plugin,
    prepared: Readonly<{ cachedPath: string }>,
  ) => Promise<void>
  readonly beforeDelete?: (captured: Plugin) => Promise<void>
}

function defaultActor(): Actor {
  return buildActor({
    user: {
      id: 'plugin-test-admin',
      username: 'plugin-test-admin',
      displayName: 'Plugin Test Admin',
      role: 'admin',
      status: 'active',
    },
    source: 'session',
  })
}

/**
 * Test-only bootstrap for focused PluginCatalog fixtures. Production code
 * receives its already-composed module and authority from the real bootstrap.
 */
export function composePluginServiceBindingForTest(
  db: DbClient,
  options: PluginServiceTestCompositionOptions = {},
): PluginServiceBinding {
  const actor = options.actor ?? defaultActor()
  const authority = new AuthorityClaimRegistry().mintDirectAuthority(
    { userId: actor.user.id, source: actor.source },
    { ...actor, userId: actor.user.id },
  ).actor
  const coordinator = new ResourceOperationCoordinator()
  const sqlite = createSqlitePluginRepository(db)
  const baseRepository = sqlite.repository
  const repository: PluginRepository = Object.freeze({
    ...baseRepository,
    async publish(input: Parameters<PluginRepository['publish']>[0]) {
      const captured = await baseRepository.get(input.id)
      if (captured !== null) {
        await options.beforePublish?.(captured, { cachedPath: input.set.cachedPath })
      }
      return baseRepository.publish(input)
    },
    async delete(input: Parameters<PluginRepository['delete']>[0]) {
      const captured = await baseRepository.get(input.id)
      if (captured !== null) await options.beforeDelete?.(captured)
      return baseRepository.delete(input)
    },
  })
  const access: PluginAccessPort = Object.freeze({
    filterVisible: (candidate: PluginOperationContext, rows: readonly Plugin[]) =>
      filterVisibleRows(db, candidate, 'plugin', rows),
    canView: (candidate: PluginOperationContext, row: Plugin) =>
      canViewResource(db, candidate, 'plugin', row),
    async requireResourceEdit(candidate: PluginOperationContext, row: Plugin) {
      await requireResourceEdit(db, candidate, 'plugin', row)
    },
    requireResourceGovern: (candidate: PluginOperationContext, row: Plugin) =>
      requireResourceGovern(db, candidate, 'plugin', row),
    discloseAgentReferences: (
      candidate: PluginOperationContext,
      references: readonly PluginAgentReference[],
    ) => discloseRefs(db, candidate, 'agent', references),
  })
  const installer: PluginInstallerPort = Object.freeze({
    async install(pluginId: string, spec: string) {
      const installed = await installPlugin(pluginId, spec, {
        pluginsDir: options.pluginsDir,
        npmBin: options.npmBin,
        timeoutMs: options.installTimeoutMs,
      })
      return Object.freeze({
        sourceKind: installed.sourceKind,
        cachedPath: installed.cachedPath,
        resolvedVersion: installed.resolvedVersion,
        cleanup: () => cleanupInstallGeneration(installed),
      })
    },
    checkForUpdate: (pluginId: string, spec: string, currentCachedPath: string) =>
      checkForUpdate(pluginId, spec, currentCachedPath, {
        pluginsDir: options.pluginsDir,
        npmBin: options.npmBin,
        timeoutMs: options.installTimeoutMs,
      }),
  })
  const acl = composeResourceAclOperationApplication<PluginOperationContext, Plugin>({
    db,
    type: 'plugin',
    load: (id) => repository.get(id),
    linearizer: {
      runExclusive: (resourceId, task) => coordinator.runExclusive(resourceId, task),
      loadById: (resourceId) => repository.get(resourceId),
      nextUpdatedAt: async (row) => monotonicNow(row.updatedAt),
    },
  })
  const catalog = composePluginCatalogFromAdapters({
    repository,
    projection: sqlite.projection,
    access,
    acl,
    coordinator,
    installer,
  })
  return Object.freeze({ catalog, authority })
}

export async function listPlugins(binding: PluginServiceBinding): Promise<Plugin[]> {
  return [...(await binding.catalog.queries.list(binding.authority))]
}

export async function getPlugin(binding: PluginServiceBinding, id: string): Promise<Plugin | null> {
  return binding.catalog.queries.get(binding.authority, { id })
}

export const getPluginById = getPlugin

export async function createPlugin(
  binding: PluginServiceBinding,
  input: CreatePluginInput,
): Promise<Plugin> {
  return binding.catalog.operations.create.invoke(
    binding.authority,
    CreatePluginSchema.parse(input),
  )
}

async function requirePlugin(binding: PluginServiceBinding, id: string) {
  const plugin = await binding.catalog.queries.get(binding.authority, { id })
  if (plugin === null) throw new NotFoundError('plugin-not-found', `plugin '${id}' not found`)
  return plugin
}

export async function updatePlugin(
  binding: PluginServiceBinding,
  id: string,
  patch: UpdatePlugin,
): Promise<Plugin> {
  const existing = await requirePlugin(binding, id)
  return binding.catalog.operations.update.invoke(binding.authority, {
    id,
    update: { ...patch, expectedConfigHash: existing.operationConfigHash },
  })
}

export async function reinstallPlugin(binding: PluginServiceBinding, id: string): Promise<Plugin> {
  const existing = await requirePlugin(binding, id)
  const receipt = await binding.catalog.operations.upgrade.invoke(binding.authority, {
    id,
    operation: { expectedConfigHash: existing.operationConfigHash },
  })
  return receipt.resource
}

export async function deletePlugin(binding: PluginServiceBinding, id: string): Promise<void> {
  const existing = await requirePlugin(binding, id)
  await binding.catalog.operations.delete.invoke(binding.authority, {
    id,
    deletion: { confirm: existing.name, expectedConfigHash: existing.operationConfigHash },
  })
}

export async function renamePlugin(
  binding: PluginServiceBinding,
  id: string,
  input: RenamePlugin,
): Promise<Plugin> {
  const existing = await requirePlugin(binding, id)
  return binding.catalog.operations.rename.invoke(binding.authority, {
    id,
    rename: { ...input, expectedConfigHash: existing.operationConfigHash },
  })
}
