import type { Workflow } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { WORKFLOWS_CHANNEL, workflowsBroadcaster } from '@/ws/broadcaster'
import {
  canViewResource,
  composeResourceAclOperationApplication,
  filterVisibleRows,
  requireResourceEdit,
  requireResourceGovern,
} from './resourceAcl'
import { assertNotBuiltin, excludeBuiltinWorkflows } from '@/services/systemResources'
import { createWorkflowApplication } from '../application/workflows/workflowApplication'
import type {
  WorkflowAccessPort,
  WorkflowAccessRow,
  WorkflowPolicyPort,
} from '../application/workflows/ports'
import { createSqliteWorkflowRepository } from '../infrastructure/sqliteWorkflowRepository'
import {
  createWorkflowOperationDescriptors,
  type WorkflowCatalogModule,
} from '../public/operations'
import type { WorkflowOperationContext } from '../public/participants'

export interface WorkflowCatalogCompositionDependencies {
  readonly db: DbClient
}

export function composeWorkflowCatalog(
  input: WorkflowCatalogCompositionDependencies,
): WorkflowCatalogModule {
  const repository = createSqliteWorkflowRepository(input.db)
  const access: WorkflowAccessPort = Object.freeze({
    filterVisible: (authority: WorkflowOperationContext, rows: readonly Workflow[]) =>
      filterVisibleRows(input.db, authority, 'workflow', [...rows]),
    canView: (authority: WorkflowOperationContext, row: WorkflowAccessRow) =>
      canViewResource(input.db, authority, 'workflow', row),
    requireResourceEdit: async (authority: WorkflowOperationContext, row: WorkflowAccessRow) => {
      await requireResourceEdit(input.db, authority, 'workflow', row)
    },
    requireResourceGovern: (authority: WorkflowOperationContext, row: WorkflowAccessRow) =>
      requireResourceGovern(input.db, authority, 'workflow', row),
  })
  const policy: WorkflowPolicyPort = Object.freeze({
    excludeBuiltin: (rows: readonly Workflow[]) => excludeBuiltinWorkflows([...rows]),
    assertMutable: (row: WorkflowAccessRow) => assertNotBuiltin('workflow', row),
  })
  const application = createWorkflowApplication({ repository, access, policy })
  const acl = composeResourceAclOperationApplication<WorkflowOperationContext, WorkflowAccessRow>({
    db: input.db,
    type: 'workflow',
    load: (id) => repository.getAclIdentity(id),
    afterUpdated: (workflowId) => {
      workflowsBroadcaster.broadcast(WORKFLOWS_CHANNEL, {
        type: 'workflow.acl.updated',
        workflowId,
      })
    },
  })
  const operations = createWorkflowOperationDescriptors(
    application.commands,
    application.queries,
    acl,
  )
  return Object.freeze({
    queries: application.queries,
    operations,
  })
}
