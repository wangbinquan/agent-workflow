import type { Mcp } from '@agent-workflow/shared'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import { transitionMcpAclRuntimeTestsInTx } from '@/services/mcpRuntimeTestTransitions'
import { createMcpApplication } from '../application/mcps/mcpApplication'
import type {
  McpAccessPort,
  McpOperationCoordinatorPort,
  McpRuntimeLifecyclePort,
} from '../application/mcps/ports'
import { createMcpAclIdentityParticipant } from '../application/participants/mcpAclIdentity'
import {
  createSqliteMcpRepository,
  type McpTransactionLifecycle,
} from '../infrastructure/sqliteMcpRepository'
import {
  canViewResource,
  composeResourceAclOperationApplication,
  discloseRefs,
  filterVisibleRows,
  requireResourceEdit,
  requireResourceGovern,
} from './resourceAcl'
import { createMcpOperationDescriptors, type McpCatalogModule } from '../public/operations'

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
  const application = createMcpApplication({
    repository,
    projection,
    access,
    coordinator: input.coordinator,
    clock,
    runtime: input.runtime,
    id: input.id ?? ulid,
    now: input.now ?? Date.now,
  })
  const aclIdentity = createMcpAclIdentityParticipant({ repository, clock })
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
  const operations = createMcpOperationDescriptors(application.commands, application.queries, acl)
  return Object.freeze({
    queries: application.queries,
    operations,
    participants: Object.freeze({ aclIdentity }),
  })
}
