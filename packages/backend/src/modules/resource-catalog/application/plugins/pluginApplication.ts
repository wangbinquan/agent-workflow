import {
  CreatePluginSchema,
  PluginOptionsSchema,
  type Plugin,
  type PluginUpdateCheck,
  type PluginUpgradeResult,
} from '@agent-workflow/shared'
import { ConflictError, NotFoundError, ValidationError, staleConflictError } from '@/util/errors'
import { assertInitialResourceOwner, initialPrivateResourceAcl } from '../resourceDefaults'
import type {
  CheckPluginUpdateCatalogInput,
  CreatePluginCatalogInput,
  DeletePluginCatalogInput,
  RenamePluginCatalogInput,
  UpdatePluginCatalogInput,
  UpgradePluginCatalogInput,
} from '../../public/types'
import type { PluginOperationContext } from '../../public/participants'
import type { PluginQueries } from '../../public/queries'
import type { GetPluginCatalogInput, PluginCatalogResource } from '../../public/types'
import type {
  PluginAccessPort,
  PluginAgentReference,
  PluginInstallerPort,
  PluginMutationClock,
  PluginOperationCoordinatorPort,
  PluginProjection,
  PluginRepository,
} from './ports'

export interface PluginApplicationDependencies {
  readonly repository: PluginRepository
  readonly projection: PluginProjection
  readonly access: PluginAccessPort
  readonly coordinator: PluginOperationCoordinatorPort
  readonly installer: PluginInstallerPort
  readonly clock: PluginMutationClock
  readonly id: () => string
  readonly now: () => number
}

function assertExpectedHash(
  projection: PluginProjection,
  plugin: Plugin,
  expectedConfigHash: string,
): void {
  const currentConfigHash = projection.configHashOf(plugin)
  if (currentConfigHash === expectedConfigHash) return
  throw staleConflictError(
    'plugin',
    'plugin changed since this operation was prepared; reload and retry',
    { expectedConfigHash, currentConfigHash },
  )
}

function assertDeleteConfirm(
  input: DeletePluginCatalogInput['deletion'],
  expectedName: string,
): void {
  if (typeof input.confirm !== 'string') {
    throw new ValidationError(
      'delete-confirm-required',
      'type the plugin name to confirm deletion',
      {
        resourceType: 'plugin',
      },
    )
  }
  if (input.confirm !== expectedName) {
    throw new ValidationError(
      'delete-confirm-mismatch',
      'the entered name does not match this plugin',
      { resourceType: 'plugin' },
    )
  }
}

function assertOperationSupported(plugin: Plugin): void {
  if (plugin.sourceKind === 'file') {
    throw new ValidationError(
      'plugin-operation-unsupported',
      'file source is externally managed and does not support Check or Upgrade',
    )
  }
}

export function createPluginApplication(deps: PluginApplicationDependencies) {
  async function loadVisible(authority: PluginOperationContext, id: string): Promise<Plugin> {
    const plugin = await deps.repository.get(id)
    if (plugin === null || !(await deps.access.canView(authority, plugin))) {
      throw new NotFoundError('plugin-not-found', `plugin '${id}' not found`)
    }
    return plugin
  }

  async function refuseReferences(
    authority: PluginOperationContext,
    plugin: Plugin,
    references: readonly PluginAgentReference[],
  ): Promise<never> {
    throw new ConflictError(
      'plugin-still-referenced',
      `plugin '${plugin.name}' is referenced by ${references.length} agent(s)`,
      await deps.access.discloseAgentReferences(authority, references),
    )
  }

  async function publishInstalled(
    plugin: Plugin,
    expectedConfigHash: string,
    patch: Readonly<{
      spec: string
      options?: unknown
      description?: string
      enabled?: boolean
    }>,
  ): Promise<Plugin> {
    const install = await deps.installer.install(plugin.id, patch.spec)
    try {
      return await deps.repository.publish({
        id: plugin.id,
        expectedConfigHash,
        patch,
        installation: {
          sourceKind: install.sourceKind,
          cachedPath: install.cachedPath,
          resolvedVersion: install.resolvedVersion,
        },
        nextUpdatedAt: (current) => deps.clock.nextUpdatedAt(current),
        nextInstalledAt: (current) => deps.clock.nextInstalledAt(current),
      })
    } catch (error) {
      await install.cleanup()
      throw error
    }
  }

  const queries: PluginQueries = Object.freeze({
    async list(authority: PluginOperationContext): Promise<readonly PluginCatalogResource[]> {
      const visible = await deps.access.filterVisible(authority, await deps.repository.list())
      return visible.map((plugin) => deps.projection.resourceOf(plugin))
    },
    async get(
      authority: PluginOperationContext,
      input: GetPluginCatalogInput,
    ): Promise<PluginCatalogResource | null> {
      const plugin = await deps.repository.get(input.id)
      if (plugin === null || !(await deps.access.canView(authority, plugin))) return null
      return deps.projection.resourceOf(plugin)
    },
  })

  const commands = Object.freeze({
    async create(
      authority: PluginOperationContext,
      input: CreatePluginCatalogInput,
    ): Promise<PluginCatalogResource> {
      const parsed = CreatePluginSchema.parse(input)
      const options = PluginOptionsSchema.parse(parsed.options)
      assertInitialResourceOwner(authority, authority.user.id)
      const initialAcl = initialPrivateResourceAcl(authority.user.id)
      const id = deps.id()
      const created = await deps.coordinator.runExclusive(id, async () => {
        await deps.repository.assertNameAvailable({
          purpose: 'create',
          ownerUserId: authority.user.id,
          name: parsed.name,
        })
        const install = await deps.installer.install(id, parsed.spec)
        try {
          return await deps.repository.create({
            id,
            name: parsed.name,
            spec: parsed.spec,
            options,
            description: parsed.description,
            enabled: parsed.enabled,
            sourceKind: install.sourceKind,
            cachedPath: install.cachedPath,
            resolvedVersion: install.resolvedVersion,
            ownerUserId: authority.user.id,
            visibility: initialAcl.visibility,
            aclRevision: initialAcl.aclRevision,
            now: deps.now(),
          })
        } catch (error) {
          await install.cleanup()
          throw error
        }
      })
      return deps.projection.resourceOf(created)
    },

    async update(
      authority: PluginOperationContext,
      input: UpdatePluginCatalogInput,
    ): Promise<PluginCatalogResource> {
      const resolved = await loadVisible(authority, input.id)
      const updated = await deps.coordinator.runExclusive(resolved.id, async () => {
        const fresh = await loadVisible(authority, resolved.id)
        await deps.access.requireResourceEdit(authority, fresh)
        assertExpectedHash(deps.projection, fresh, input.update.expectedConfigHash)
        const patch = {
          ...(input.update.spec === undefined ? {} : { spec: input.update.spec }),
          ...(input.update.options === undefined ? {} : { options: input.update.options }),
          ...(input.update.description === undefined
            ? {}
            : { description: input.update.description }),
          ...(input.update.enabled === undefined ? {} : { enabled: input.update.enabled }),
        }
        // 规格改变才在事务前重新安装；其余（选项校验、no-op、发布）在唯一的 plugin 写入参与者里（RFC-401 A2）。
        if (patch.spec !== undefined && patch.spec !== fresh.spec) {
          return publishInstalled(fresh, input.update.expectedConfigHash, {
            ...patch,
            spec: patch.spec,
          })
        }
        return deps.repository.publish({
          id: fresh.id,
          expectedConfigHash: input.update.expectedConfigHash,
          patch,
          installation: null,
          nextUpdatedAt: (current) => deps.clock.nextUpdatedAt(current),
          nextInstalledAt: (current) => deps.clock.nextInstalledAt(current),
        })
      })
      return deps.projection.resourceOf(updated)
    },

    async delete(authority: PluginOperationContext, input: DeletePluginCatalogInput) {
      const resolved = await loadVisible(authority, input.id)
      return deps.coordinator.runExclusive(resolved.id, async () => {
        const fresh = await loadVisible(authority, resolved.id)
        await deps.access.requireResourceGovern(authority, fresh)
        assertExpectedHash(deps.projection, fresh, input.deletion.expectedConfigHash)
        assertDeleteConfirm(input.deletion, fresh.name)
        const references = await deps.repository.findAgentReferences(fresh.id)
        if (references.length > 0) await refuseReferences(authority, fresh, references)
        const finalReferences = await deps.repository.delete({
          id: fresh.id,
          expectedConfigHash: input.deletion.expectedConfigHash,
        })
        if (finalReferences.length > 0) {
          await refuseReferences(authority, fresh, finalReferences)
        }
        return Object.freeze({ deleted: deps.projection.resourceOf(fresh) })
      })
    },

    async rename(
      authority: PluginOperationContext,
      input: RenamePluginCatalogInput,
    ): Promise<PluginCatalogResource> {
      const resolved = await loadVisible(authority, input.id)
      const renamed = await deps.coordinator.runExclusive(resolved.id, async () => {
        const fresh = await loadVisible(authority, resolved.id)
        await deps.access.requireResourceGovern(authority, fresh)
        assertExpectedHash(deps.projection, fresh, input.rename.expectedConfigHash)
        if (input.rename.newName === fresh.name) return fresh
        await deps.repository.assertNameAvailable({
          purpose: 'rename',
          ownerUserId: fresh.ownerUserId ?? null,
          name: input.rename.newName,
          excludeId: fresh.id,
        })
        return deps.repository.rename({
          id: fresh.id,
          newName: input.rename.newName,
          expectedConfigHash: input.rename.expectedConfigHash,
          updatedAt: deps.clock.nextUpdatedAt(fresh),
        })
      })
      return deps.projection.resourceOf(renamed)
    },
  })

  const updateCommands = Object.freeze({
    async checkUpdate(
      authority: PluginOperationContext,
      input: CheckPluginUpdateCatalogInput,
    ): Promise<PluginUpdateCheck> {
      const resolved = await loadVisible(authority, input.id)
      await deps.access.requireResourceEdit(authority, resolved)
      assertOperationSupported(resolved)
      const expectedConfigHash = input.operation.expectedConfigHash
      return deps.coordinator.runDeduplicatedOperation(
        resolved.id,
        expectedConfigHash,
        async () => {
          const captured = await deps.coordinator.runExclusive(resolved.id, async () => {
            const fresh = await loadVisible(authority, resolved.id)
            await deps.access.requireResourceEdit(authority, fresh)
            assertExpectedHash(deps.projection, fresh, expectedConfigHash)
            assertOperationSupported(fresh)
            return fresh
          })
          const checked = await deps.installer.checkForUpdate(
            captured.id,
            captured.spec,
            captured.cachedPath,
          )
          return deps.coordinator.runExclusive(captured.id, async () => {
            const current = await loadVisible(authority, captured.id)
            await deps.access.requireResourceEdit(authority, current)
            assertExpectedHash(deps.projection, current, expectedConfigHash)
            return Object.freeze({
              ...checked,
              current: captured.resolvedVersion,
              configHashUsed: expectedConfigHash,
            })
          })
        },
      )
    },

    async upgrade(
      authority: PluginOperationContext,
      input: UpgradePluginCatalogInput,
    ): Promise<PluginUpgradeResult> {
      const resolved = await loadVisible(authority, input.id)
      const expectedConfigHash = input.operation.expectedConfigHash
      const updated = await deps.coordinator.runExclusive(resolved.id, async () => {
        const fresh = await loadVisible(authority, resolved.id)
        await deps.access.requireResourceEdit(authority, fresh)
        assertExpectedHash(deps.projection, fresh, expectedConfigHash)
        assertOperationSupported(fresh)
        await deps.installer.checkForUpdate(fresh.id, fresh.spec, fresh.cachedPath)
        // 显式 upgrade：同一规格重新解析版本，带新安装发布。
        return publishInstalled(fresh, expectedConfigHash, { spec: fresh.spec })
      })
      return Object.freeze({
        configHashUsed: expectedConfigHash,
        resource: deps.projection.resourceOf(updated),
      })
    },
  })

  return Object.freeze({ commands, updateCommands, queries })
}
