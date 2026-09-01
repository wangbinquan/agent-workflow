import type { Mcp } from '@agent-workflow/shared'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import { transitionMcpAclRuntimeTestsInTx } from '../infrastructure/legacy/mcpRuntimeTestTransitions'
import { createMcpApplication } from '../application/mcps/mcpApplication'
import type {
  McpAccessPort,
  McpOperationCoordinatorPort,
  McpProjection,
  McpRepository,
  McpRuntimeLifecyclePort,
} from '../application/mcps/ports'
import { createMcpAclIdentityParticipant } from '../application/participants/mcpAclIdentity'
import {
  createSqliteMcpRepository,
  type McpTransactionLifecycle,
} from '../infrastructure/sqliteMcpRepository'
import {
  createPostgresqlMcpRepository,
  type PostgresqlMcpTransactionLifecycle,
} from '../infrastructure/postgresqlMcpRepository'
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
import { createMcpOperationDescriptors } from './catalogOperationDescriptors'
import type { McpCatalogModule } from '../public/operations'

export interface McpCatalogCompositionDependencies {
  readonly db: DbClient
  readonly coordinator: McpOperationCoordinatorPort
  readonly nextMutationTimestamp: (mcp: Mcp) => Promise<number>
  readonly runtime: McpRuntimeLifecyclePort
  readonly transitionMutationInTx: McpTransactionLifecycle['transitionMutation']
  readonly deletePreparedInTx: (tx: DbTxSync, mcpId: string) => void
  readonly id?: () => string
  readonly now?: () => number
}

type McpAclOperationApplication = Parameters<typeof createMcpOperationDescriptors>[2]

export interface McpCatalogAdapterCompositionDependencies {
  readonly repository: McpRepository
  readonly projection: McpProjection
  readonly access: McpAccessPort
  readonly acl: McpAclOperationApplication
  readonly coordinator: McpOperationCoordinatorPort
  readonly nextMutationTimestamp: (mcp: Mcp) => Promise<number>
  readonly runtime: McpRuntimeLifecyclePort
  readonly id?: () => string
  readonly now?: () => number
}

export interface PostgresqlMcpCatalogCompositionDependencies extends Omit<
  McpCatalogAdapterCompositionDependencies,
  'repository' | 'projection' | 'access' | 'acl'
> {
  readonly db: PostgresqlDatabaseClient
  readonly lifecycle: PostgresqlMcpTransactionLifecycle
  readonly resourceCatalog: Pick<ProviderResourceCatalogComposition, 'authorization' | 'acl'>
}

export function composeMcpCatalogFromAdapters(
  input: McpCatalogAdapterCompositionDependencies,
): McpCatalogModule {
  const clock = Object.freeze({ next: input.nextMutationTimestamp })
  const application = createMcpApplication({
    repository: input.repository,
    projection: input.projection,
    access: input.access,
    coordinator: input.coordinator,
    clock,
    runtime: input.runtime,
    id: input.id ?? ulid,
    now: input.now ?? Date.now,
  })
  const aclIdentity = createMcpAclIdentityParticipant({
    repository: input.repository,
    clock,
  })
  const operations = createMcpOperationDescriptors(
    application.commands,
    application.queries,
    input.acl,
  )
  return Object.freeze({
    queries: application.queries,
    operations,
    participants: Object.freeze({ aclIdentity }),
  })
}

export function composePostgresqlMcpCatalog(
  input: PostgresqlMcpCatalogCompositionDependencies,
): McpCatalogModule {
  const { repository, projection } = createPostgresqlMcpRepository({
    db: input.db,
    lifecycle: input.lifecycle,
  })
  const access = Object.freeze({
    filterVisible: (authority, rows) =>
      input.resourceCatalog.authorization.filterVisibleRows(authority, 'mcp', rows),
    canView: (authority, row) =>
      input.resourceCatalog.authorization.canViewResource(authority, 'mcp', row),
    requireResourceEdit: async (authority, row) => {
      await input.resourceCatalog.authorization.requireResourceEdit(authority, 'mcp', row)
    },
    requireResourceGovern: (authority, row) =>
      input.resourceCatalog.authorization.requireResourceGovern(authority, 'mcp', row),
    discloseAgentReferences: (authority, references) =>
      input.resourceCatalog.authorization.discloseRefs(authority, 'agent', references),
  } satisfies McpAccessPort)
  const acl = composeProviderResourceAclOperationApplication({
    ...input.resourceCatalog,
    type: 'mcp',
    load: (id) => repository.get(id),
    linearizer: {
      runExclusive: (resourceId, task) => input.coordinator.runExclusive(resourceId, task),
      loadById: (resourceId) => repository.get(resourceId),
      nextUpdatedAt: (row) => input.nextMutationTimestamp(row),
    },
    afterUpdated: () => input.runtime.reconcileDurableIntents(),
  })
  return composeMcpCatalogFromAdapters({ ...input, repository, projection, access, acl })
}

export function composeMcpCatalog(input: McpCatalogCompositionDependencies): McpCatalogModule {
  const lifecycle: McpTransactionLifecycle = Object.freeze({
    transitionMutation: input.transitionMutationInTx,
    deletePrepared: input.deletePreparedInTx,
  })
  const { repository, projection } = createSqliteMcpRepository({
    db: input.db,
    lifecycle,
  })
  const access: McpAccessPort = {
    filterVisible: (authority, rows) => filterVisibleRows<Mcp>(input.db, authority, 'mcp', rows),
    canView: (authority, row) => canViewResource(input.db, authority, 'mcp', row),
    requireResourceEdit: async (authority, row) => {
      await requireResourceEdit(input.db, authority, 'mcp', row)
    },
    requireResourceGovern: (authority, row) =>
      requireResourceGovern(input.db, authority, 'mcp', row),
    discloseAgentReferences: (authority, references) =>
      discloseRefs(input.db, authority, 'agent', references),
  }
  Object.freeze(access)
  const clock = Object.freeze({ next: input.nextMutationTimestamp })
  const acl = composeResourceAclOperationApplication({
    db: input.db,
    type: 'mcp',
    load: (id) => repository.get(id),
    linearizer: {
      runExclusive: (resourceId, task) => input.coordinator.runExclusive(resourceId, task),
      loadById: (resourceId) => repository.get(resourceId),
      nextUpdatedAt: (row) => clock.next(row),
    },
    afterWriteInTx: (tx, change) =>
      transitionMcpAclRuntimeTestsInTx(tx, {
        mcpId: change.resourceId,
        ownerUserId: change.ownerUserId,
        visibility: change.visibility,
        grantedUserIds: change.grantedUserIds,
        now: change.now,
      }),
    afterUpdated: () => input.runtime.reconcileDurableIntents(),
  })
  return composeMcpCatalogFromAdapters({
    repository,
    projection,
    access,
    acl,
    coordinator: input.coordinator,
    nextMutationTimestamp: clock.next,
    runtime: input.runtime,
    id: input.id,
    now: input.now,
  })
}
