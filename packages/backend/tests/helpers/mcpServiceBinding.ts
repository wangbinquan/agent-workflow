// RFC-028 / RFC-345 — test-only MCP catalog composition.

import type { CreateMcp, Mcp, RenameMcp, UpdateMcp } from '@agent-workflow/shared'
import { buildActor, type Actor } from '../../src/auth/actor'
import type { DbClient } from '../../src/db/client'
import { AuthorityClaimRegistry } from '../../src/modules/identity-access/application/operationContext'
import type {
  McpAccessPort,
  McpAgentReference,
  McpRepository,
} from '../../src/modules/resource-catalog/application/mcps/ports'
import { composeMcpCatalogFromAdapters } from '../../src/modules/resource-catalog/composition/mcpOperations'
import {
  canViewResource,
  composeResourceAclOperationApplication,
  discloseRefs,
  filterVisibleRows,
  requireResourceEdit,
  requireResourceGovern,
} from '../../src/modules/resource-catalog/composition/resourceAcl'
import {
  createSqliteMcpRepository,
  type McpTransactionLifecycle,
} from '../../src/modules/resource-catalog/infrastructure/sqliteMcpRepository'
import type { McpCatalogModule } from '../../src/modules/resource-catalog/public/operations'
import type { McpOperationContext } from '../../src/modules/resource-catalog/public/participants'
import type { McpCatalogResource } from '../../src/modules/resource-catalog/public/types'
import { ResourceOperationCoordinator } from '../../src/services/resourceOperationCoordinator'
import type { McpClosureQuery } from '../../src/services/mcpClosure'
import { monotonicNow } from '../../src/util/time'

export interface McpCatalogTestBinding {
  readonly catalog: McpCatalogModule
  readonly authority: McpOperationContext
}

/**
 * Test-only conveniences over the real Resource Catalog operations. Keeping
 * these beside fixture composition avoids reviving the retired production
 * `services/mcp.ts` facade merely to seed focused tests.
 */
export async function createMcpForTest(
  binding: McpCatalogTestBinding,
  input: CreateMcp,
): Promise<Mcp> {
  return binding.catalog.operations.create.invoke(binding.authority, input)
}

export async function createMcpFixture(
  db: DbClient,
  input: CreateMcp,
  options: Readonly<{
    ownerUserId?: string
    actor?: Actor | null
  }> = {},
): Promise<Mcp> {
  const actor =
    options.actor ??
    (options.ownerUserId === undefined
      ? undefined
      : buildActor({
          user: {
            id: options.ownerUserId,
            username: options.ownerUserId,
            displayName: options.ownerUserId,
            role: 'user',
            status: 'active',
          },
          source: 'session',
        }))
  return createMcpForTest(composeMcpServiceBindingForTest(db, { actor }), input)
}

export async function listMcpsForTest(binding: McpCatalogTestBinding): Promise<readonly Mcp[]> {
  return binding.catalog.queries.list(binding.authority)
}

export async function getMcpByIdForTest(
  binding: McpCatalogTestBinding,
  id: string,
): Promise<McpCatalogResource | null> {
  return binding.catalog.queries.get(binding.authority, { id })
}

export async function getMcpFixtureById(
  db: DbClient,
  id: string,
): Promise<McpCatalogResource | null> {
  return getMcpByIdForTest(composeMcpServiceBindingForTest(db), id)
}

export function composeMcpClosureQueryForTest(db: DbClient): McpClosureQuery {
  const repository = createSqliteMcpRepository({
    db,
    lifecycle: Object.freeze({
      transitionMutation: () => undefined,
      deletePrepared: () => undefined,
    }),
  }).repository
  return Object.freeze({
    async loadByIds(ids: Parameters<McpClosureQuery['loadByIds']>[0]) {
      const loaded = await Promise.all(ids.map((id: string) => repository.get(id)))
      return Object.freeze(loaded.filter((mcp): mcp is Mcp => mcp !== null))
    },
  })
}

export async function updateMcpForTest(
  binding: McpCatalogTestBinding,
  id: string,
  update: UpdateMcp,
): Promise<Mcp> {
  const current = await getMcpByIdForTest(binding, id)
  return binding.catalog.operations.update.invoke(binding.authority, {
    id,
    update: { ...update, expectedConfigHash: current?.operationConfigHash ?? 'missing' },
  })
}

export async function renameMcpForTest(
  binding: McpCatalogTestBinding,
  id: string,
  rename: RenameMcp,
): Promise<Mcp> {
  const current = await getMcpByIdForTest(binding, id)
  return binding.catalog.operations.rename.invoke(binding.authority, {
    id,
    rename: { ...rename, expectedConfigHash: current?.operationConfigHash ?? 'missing' },
  })
}

export async function deleteMcpForTest(binding: McpCatalogTestBinding, id: string): Promise<void> {
  const current = await getMcpByIdForTest(binding, id)
  await binding.catalog.operations.delete.invoke(binding.authority, {
    id,
    deletion: {
      confirm: current?.name,
      expectedConfigHash: current?.operationConfigHash ?? 'missing',
    },
  })
}

export function composeMcpServiceBindingForTest(
  db: DbClient,
  options: Readonly<{
    actor?: Actor
    beforeDelete?: (captured: Mcp) => Promise<void>
    lifecycle?: McpTransactionLifecycle
  }> = {},
): McpCatalogTestBinding {
  const actor =
    options.actor ??
    buildActor({
      user: {
        id: 'mcp-test-admin',
        username: 'mcp-test-admin',
        displayName: 'MCP Test Admin',
        role: 'admin',
        status: 'active',
      },
      source: 'session',
    })
  const authority = new AuthorityClaimRegistry().mintDirectAuthority(
    { userId: actor.user.id, source: actor.source },
    { ...actor, userId: actor.user.id },
  ).actor
  const coordinator = new ResourceOperationCoordinator()
  const sqlite = createSqliteMcpRepository({
    db,
    lifecycle:
      options.lifecycle ??
      Object.freeze({
        transitionMutation: () => undefined,
        deletePrepared: () => undefined,
      }),
  })
  const baseRepository = sqlite.repository
  const repository: McpRepository = Object.freeze({
    ...baseRepository,
    async delete(input: Parameters<McpRepository['delete']>[0]) {
      const captured = await baseRepository.get(input.id)
      if (captured !== null) await options.beforeDelete?.(captured)
      return baseRepository.delete(input)
    },
  })
  const access: McpAccessPort = Object.freeze({
    filterVisible: (candidate: McpOperationContext, rows: readonly Mcp[]) =>
      filterVisibleRows(db, candidate, 'mcp', rows),
    canView: (candidate: McpOperationContext, row: Mcp) =>
      canViewResource(db, candidate, 'mcp', row),
    async requireResourceEdit(candidate: McpOperationContext, row: Mcp) {
      await requireResourceEdit(db, candidate, 'mcp', row)
    },
    requireResourceGovern: (candidate: McpOperationContext, row: Mcp) =>
      requireResourceGovern(db, candidate, 'mcp', row),
    discloseAgentReferences: (
      candidate: McpOperationContext,
      references: readonly McpAgentReference[],
    ) => discloseRefs(db, candidate, 'agent', references),
  })
  const clock = Object.freeze({ next: async (mcp: Mcp) => monotonicNow(mcp.updatedAt) })
  const acl = composeResourceAclOperationApplication<McpOperationContext, Mcp>({
    db,
    type: 'mcp',
    load: (id) => repository.get(id),
    linearizer: {
      runExclusive: (resourceId, task) => coordinator.runExclusive(resourceId, task),
      loadById: (resourceId) => repository.get(resourceId),
      nextUpdatedAt: (row) => clock.next(row),
    },
  })
  const catalog = composeMcpCatalogFromAdapters({
    repository,
    projection: sqlite.projection,
    access,
    acl,
    coordinator,
    nextMutationTimestamp: clock.next,
    runtime: Object.freeze({
      prepareDelete: async () => undefined,
      reconcileDurableIntents: async () => undefined,
    }),
  })
  return Object.freeze({ catalog, authority })
}
