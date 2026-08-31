import {
  canonicalJson,
  McpLocalConfigSchema,
  McpRemoteConfigSchema,
  type Mcp,
} from '@agent-workflow/shared'
import { ConflictError, NotFoundError, ValidationError, staleConflictError } from '@/util/errors'
import { assertInitialResourceOwner, initialPrivateResourceAcl } from '../resourceDefaults'
import type {
  CreateMcpCatalogInput,
  DeleteMcpCatalogInput,
  RenameMcpCatalogInput,
  UpdateMcpCatalogInput,
} from '../../domain/catalogOperationTypes'
import type { McpOperationContext } from '../../public/participants'
import type { McpQueries } from '../../public/queries'
import type { McpCatalogResource } from '../../public/types'
import type {
  McpAccessPort,
  McpAgentReference,
  McpMutationClock,
  McpOperationCoordinatorPort,
  McpProjection,
  McpRepository,
  McpRuntimeLifecyclePort,
  McpUpdateSet,
} from './ports'

export interface McpApplicationDependencies {
  readonly repository: McpRepository
  readonly projection: McpProjection
  readonly access: McpAccessPort
  readonly coordinator: McpOperationCoordinatorPort
  readonly clock: McpMutationClock
  readonly runtime: McpRuntimeLifecyclePort
  readonly id: () => string
  readonly now: () => number
}

function validateConfigForType(type: 'local' | 'remote', config: unknown): Mcp['config'] {
  const parsed = (type === 'local' ? McpLocalConfigSchema : McpRemoteConfigSchema).safeParse(config)
  if (!parsed.success) {
    throw new ValidationError('mcp-config-invalid', `mcp ${type} config is invalid`, {
      issues: parsed.error.issues,
    })
  }
  return parsed.data
}

function assertExpectedHash(
  projection: McpProjection,
  mcp: Mcp,
  expectedConfigHash: string,
  action: 'modifying' | 'deleting',
): void {
  const currentConfigHash = projection.configHashOf(mcp)
  if (currentConfigHash === expectedConfigHash) return
  throw staleConflictError(
    'mcp',
    action === 'deleting'
      ? 'the MCP changed; reload before deleting'
      : 'the MCP changed; reload before modifying it',
    { expectedConfigHash, currentConfigHash },
  )
}

function assertDeleteConfirm(input: DeleteMcpCatalogInput['deletion'], expectedName: string): void {
  if (typeof input.confirm !== 'string') {
    throw new ValidationError('delete-confirm-required', 'type the mcp name to confirm deletion', {
      resourceType: 'mcp',
    })
  }
  if (input.confirm !== expectedName) {
    throw new ValidationError(
      'delete-confirm-mismatch',
      'the entered name does not match this mcp',
      { resourceType: 'mcp' },
    )
  }
}

export function createMcpApplication(deps: McpApplicationDependencies) {
  async function loadVisible(authority: McpOperationContext, id: string): Promise<Mcp> {
    const mcp = await deps.repository.get(id)
    if (mcp === null || !(await deps.access.canView(authority, mcp))) {
      throw new NotFoundError('mcp-not-found', 'mcp not found')
    }
    return mcp
  }

  async function refuseReferences(
    authority: McpOperationContext,
    mcp: Mcp,
    references: readonly McpAgentReference[],
  ): Promise<never> {
    throw new ConflictError(
      'mcp-still-referenced',
      `mcp '${mcp.name}' is referenced by ${references.length} agent(s)`,
      await deps.access.discloseAgentReferences(authority, references),
    )
  }

  const queries: McpQueries = Object.freeze({
    async list(authority: McpOperationContext): Promise<readonly McpCatalogResource[]> {
      const visible = await deps.access.filterVisible(authority, await deps.repository.list())
      return visible.map((mcp) => deps.projection.resourceOf(mcp))
    },
    async get(
      authority: McpOperationContext,
      input: { readonly id: string },
    ): Promise<McpCatalogResource | null> {
      const mcp = await deps.repository.get(input.id)
      if (mcp === null || !(await deps.access.canView(authority, mcp))) return null
      return deps.projection.resourceOf(mcp)
    },
  })

  const commands = Object.freeze({
    async create(
      authority: McpOperationContext,
      input: CreateMcpCatalogInput,
    ): Promise<McpCatalogResource> {
      assertInitialResourceOwner(authority, authority.user.id)
      validateConfigForType(input.type, input.config)
      const initialAcl = initialPrivateResourceAcl(authority.user.id)
      const created = await deps.repository.create({
        id: deps.id(),
        input,
        ownerUserId: authority.user.id,
        visibility: initialAcl.visibility,
        aclRevision: initialAcl.aclRevision,
        now: deps.now(),
      })
      return deps.projection.resourceOf(created)
    },

    async update(
      authority: McpOperationContext,
      input: UpdateMcpCatalogInput,
    ): Promise<McpCatalogResource> {
      const resolved = await loadVisible(authority, input.id)
      const updated = await deps.coordinator.runExclusive(resolved.id, async () => {
        const fresh = await loadVisible(authority, resolved.id)
        await deps.access.requireResourceEdit(authority, fresh)
        assertExpectedHash(deps.projection, fresh, input.update.expectedConfigHash, 'modifying')

        if (input.update.type !== undefined && input.update.type !== fresh.type) {
          throw new ValidationError(
            'mcp-type-immutable',
            `mcp '${fresh.name}' type cannot change`,
            { currentType: fresh.type, requestedType: input.update.type },
          )
        }
        const nextConfig =
          input.update.config === undefined
            ? fresh.config
            : validateConfigForType(fresh.type, input.update.config)
        const nextDescription = input.update.description ?? fresh.description
        const nextEnabled = input.update.enabled ?? fresh.enabled
        const configChanged = canonicalJson(nextConfig) !== canonicalJson(fresh.config)
        const changed =
          nextDescription !== fresh.description || nextEnabled !== fresh.enabled || configChanged
        // Preserve the RFC-201 causal clock observation even for a semantic no-op.
        const updatedAt = await deps.clock.next(fresh)
        if (!changed) return fresh

        const set: {
          description?: string
          config?: Mcp['config']
          enabled?: boolean
          updatedAt: number
        } = { updatedAt }
        if (nextDescription !== fresh.description) set.description = nextDescription
        if (nextEnabled !== fresh.enabled) set.enabled = nextEnabled
        if (configChanged) set.config = nextConfig
        return deps.repository.update({
          id: fresh.id,
          expectedConfigHash: input.update.expectedConfigHash,
          set: set satisfies McpUpdateSet,
        })
      })
      await deps.runtime.reconcileDurableIntents()
      return deps.projection.resourceOf(updated)
    },

    async delete(
      authority: McpOperationContext,
      input: DeleteMcpCatalogInput,
    ): Promise<{ readonly deleted: McpCatalogResource }> {
      const resolved = await loadVisible(authority, input.id)
      return deps.coordinator.runExclusive(resolved.id, async () => {
        const fresh = await loadVisible(authority, resolved.id)
        await deps.access.requireResourceGovern(authority, fresh)
        assertExpectedHash(deps.projection, fresh, input.deletion.expectedConfigHash, 'deleting')
        assertDeleteConfirm(input.deletion, fresh.name)
        await deps.runtime.prepareDelete(fresh.id)

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
      authority: McpOperationContext,
      input: RenameMcpCatalogInput,
    ): Promise<McpCatalogResource> {
      const resolved = await loadVisible(authority, input.id)
      const renamed = await deps.coordinator.runExclusive(resolved.id, async () => {
        const fresh = await loadVisible(authority, resolved.id)
        await deps.access.requireResourceGovern(authority, fresh)
        assertExpectedHash(deps.projection, fresh, input.rename.expectedConfigHash, 'modifying')
        const updatedAt = await deps.clock.next(fresh)
        if (input.rename.newName === fresh.name) return fresh
        return deps.repository.rename({
          id: fresh.id,
          newName: input.rename.newName,
          expectedConfigHash: input.rename.expectedConfigHash,
          updatedAt,
        })
      })
      await deps.runtime.reconcileDurableIntents()
      return deps.projection.resourceOf(renamed)
    },
  })

  return Object.freeze({ commands, queries })
}
