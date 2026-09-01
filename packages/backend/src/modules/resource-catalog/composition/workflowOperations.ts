import type { Workflow } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { WORKFLOWS_CHANNEL, workflowsBroadcaster } from '@/ws/broadcaster'
import {
  canViewResource,
  composeProviderResourceAclOperationApplication,
  composeResourceAclOperationApplication,
  filterVisibleRows,
  requireResourceEdit,
  requireResourceGovern,
} from './resourceAcl'
import type { ProviderResourceCatalogComposition } from './providerResourceCatalog'
import { assertNotBuiltin, excludeBuiltinWorkflows } from '@/services/systemResources'
import { createWorkflowApplication } from '../application/workflows/workflowApplication'
import { createWorkflowValidationApplication } from '../application/workflows/workflowValidation'
import type {
  WorkflowAccessPort,
  WorkflowAccessRow,
  WorkflowPolicyPort,
  WorkflowReferenceAdmissionPort,
  WorkflowRepository,
  WorkflowValidationPort,
} from '../application/workflows/ports'
import { createSqliteWorkflowRepository } from '../infrastructure/sqliteWorkflowRepository'
import {
  createPostgresqlWorkflowRepository,
  type PostgresqlWorkflowPersistenceSemantics,
} from '../infrastructure/postgresqlWorkflowRepository'
import { createWorkflowOperationDescriptors } from './catalogOperationDescriptors'
import type { WorkflowCatalogModule } from '../public/operations'
import type { WorkflowOperationContext } from '../public/participants'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { PostgresqlSkillContentLifecycle } from '../infrastructure/postgresqlSkillRepository'
import {
  createSqliteWorkflowReferenceAdmissionPort,
  createSqliteWorkflowValidationPort,
} from '../infrastructure/sqliteWorkflowValidation'
import {
  createPostgresqlWorkflowReferenceAdmissionPort,
  createPostgresqlWorkflowValidationPort,
} from '../infrastructure/postgresqlWorkflowValidation'

export interface WorkflowCatalogCompositionDependencies {
  readonly db: DbClient
}

type WorkflowAclOperationApplication = Parameters<typeof createWorkflowOperationDescriptors>[2]

export interface WorkflowCatalogAdapterCompositionDependencies {
  readonly repository: WorkflowRepository
  readonly access: WorkflowAccessPort
  readonly policy: WorkflowPolicyPort
  readonly acl: WorkflowAclOperationApplication
  readonly validation: WorkflowValidationPort
  readonly admission: WorkflowReferenceAdmissionPort
}

export interface PostgresqlWorkflowCatalogCompositionDependencies {
  readonly db: PostgresqlDatabaseClient
  readonly persistence: PostgresqlWorkflowPersistenceSemantics
  readonly skillContent: Pick<PostgresqlSkillContentLifecycle, 'isAvailable'>
  readonly resourceCatalog: Pick<ProviderResourceCatalogComposition, 'authorization' | 'acl'>
}

export function composeWorkflowCatalogFromAdapters(
  input: WorkflowCatalogAdapterCompositionDependencies,
): WorkflowCatalogModule {
  const application = createWorkflowApplication({
    repository: input.repository,
    access: input.access,
    policy: input.policy,
  })
  const operations = createWorkflowOperationDescriptors(
    application.commands,
    application.queries,
    input.acl,
  )
  const validationQueries = createWorkflowValidationApplication({
    validation: input.validation,
    admission: input.admission,
  })
  return Object.freeze({ queries: application.queries, validationQueries, operations })
}

export function composePostgresqlWorkflowCatalog(
  input: PostgresqlWorkflowCatalogCompositionDependencies,
): WorkflowCatalogModule {
  const repository = createPostgresqlWorkflowRepository({
    db: input.db,
    semantics: input.persistence,
  })
  const access = Object.freeze({
    filterVisible: (authority: WorkflowOperationContext, rows: readonly Workflow[]) =>
      input.resourceCatalog.authorization.filterVisibleRows(authority, 'workflow', rows),
    canView: (authority: WorkflowOperationContext, row: WorkflowAccessRow) =>
      input.resourceCatalog.authorization.canViewResource(authority, 'workflow', row),
    requireResourceEdit: async (authority: WorkflowOperationContext, row: WorkflowAccessRow) => {
      await input.resourceCatalog.authorization.requireResourceEdit(authority, 'workflow', row)
    },
    requireResourceGovern: (authority: WorkflowOperationContext, row: WorkflowAccessRow) =>
      input.resourceCatalog.authorization.requireResourceGovern(authority, 'workflow', row),
  } satisfies WorkflowAccessPort)
  const policy = Object.freeze({
    excludeBuiltin: (rows: readonly Workflow[]) => excludeBuiltinWorkflows([...rows]),
    assertMutable: (row: WorkflowAccessRow) => assertNotBuiltin('workflow', row),
  } satisfies WorkflowPolicyPort)
  const acl = composeProviderResourceAclOperationApplication<
    WorkflowOperationContext,
    'workflow',
    WorkflowAccessRow
  >({
    ...input.resourceCatalog,
    type: 'workflow',
    load: (id) => repository.getAclIdentity(id),
    afterUpdated: (workflowId) => {
      workflowsBroadcaster.broadcast(WORKFLOWS_CHANNEL, {
        type: 'workflow.acl.updated',
        workflowId,
      })
    },
  })
  return composeWorkflowCatalogFromAdapters({
    repository,
    access,
    policy,
    acl,
    validation: createPostgresqlWorkflowValidationPort({
      db: input.db,
      skillContent: input.skillContent,
    }),
    admission: createPostgresqlWorkflowReferenceAdmissionPort({
      db: input.db,
      authorization: input.resourceCatalog.authorization,
    }),
  })
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
  return composeWorkflowCatalogFromAdapters({
    repository,
    access,
    policy,
    acl,
    validation: createSqliteWorkflowValidationPort(input.db),
    admission: createSqliteWorkflowReferenceAdmissionPort(input.db),
  })
}
