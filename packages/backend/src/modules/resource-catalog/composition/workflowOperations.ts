import type { Workflow } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import { WORKFLOWS_CHANNEL, workflowsBroadcaster } from '@/ws/broadcaster'
import { composeProviderResourceAclOperationApplication } from './resourceAcl'
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
import {
  loadWorkflowValidationContext,
  type ValidatorContext,
} from '../infrastructure/legacy/workflow.validator'
import {
  createWorkflowRepository,
  type WorkflowPersistenceSemantics,
} from '../infrastructure/workflowRepository'
import { createWorkflowPersistenceSemantics } from '../infrastructure/workflowPersistenceSemantics'
import {
  createSkillContentAvailability,
  type SkillContentAvailability,
} from '../infrastructure/skillContentAvailability'
import { createWorkflowOperationDescriptors } from './catalogOperationDescriptors'
import type { WorkflowCatalogModule } from '../public/operations'
import type { WorkflowOperationContext } from '../public/participants'
import {
  createWorkflowReferenceAdmissionPort,
  createWorkflowValidationPort,
} from '../infrastructure/workflowValidation'

type WorkflowAclOperationApplication = Parameters<typeof createWorkflowOperationDescriptors>[2]

export interface WorkflowCatalogAdapterCompositionDependencies {
  readonly repository: WorkflowRepository
  readonly access: WorkflowAccessPort
  readonly policy: WorkflowPolicyPort
  readonly acl: WorkflowAclOperationApplication
  readonly validation: WorkflowValidationPort
  readonly admission: WorkflowReferenceAdmissionPort
}

export interface WorkflowCatalogCompositionDependencies {
  readonly db: ProviderNeutralDatabase
  readonly persistence: WorkflowPersistenceSemantics
  readonly skillContent: SkillContentAvailability
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

/** 一份装配，两个 provider 共用（RFC-359 W4-D15）：仓库 / 语义 / 校验 / ACL 应用都已是中立实现。 */
export function composeWorkflowCatalog(
  input: WorkflowCatalogCompositionDependencies,
): WorkflowCatalogModule {
  const repository = createWorkflowRepository({
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
    validation: createWorkflowValidationPort({
      db: input.db,
      skillContent: input.skillContent,
    }),
    admission: createWorkflowReferenceAdmissionPort({
      db: input.db,
      authorization: input.resourceCatalog.authorization,
    }),
  })
}

/** 目录变更向 `/ws/workflows` 的广播：两个 provider 同一份事件接线。 */
function workflowBroadcastEvents(): NonNullable<
  Parameters<typeof createWorkflowPersistenceSemantics>[0]['events']
> {
  return {
    created(created) {
      workflowsBroadcaster.broadcast(WORKFLOWS_CHANNEL, {
        type: 'workflow.created',
        workflowId: created.id,
        name: created.name,
        version: created.version,
      })
    },
    updated(receipt) {
      workflowsBroadcaster.broadcast(WORKFLOWS_CHANNEL, {
        type: 'workflow.updated',
        workflowId: receipt.revision.workflowId,
        clientMutationId: receipt.clientMutationId,
        version: receipt.revision.version,
        snapshotHash: receipt.revision.snapshotHash,
        updatedAt: receipt.revision.updatedAt,
      })
    },
    deleted(workflowId, deletedVersion, deletion, audience) {
      // 受众随帧旁路带给注册表（不进客户端线协议）：冷缓存的私有观众靠它收到 delete 帧。
      workflowsBroadcaster.broadcast(
        WORKFLOWS_CHANNEL,
        {
          type: 'workflow.deleted',
          workflowId,
          clientMutationId: deletion.clientMutationId,
          deletedVersion,
        },
        {
          kind: 'workflow.deleted-audience',
          workflowId,
          visibility: audience.visibility,
          ownerUserId: audience.ownerUserId,
          grantedUserIds: audience.grantedUserIds,
        },
      )
    },
  }
}

/** managed skill 可用性判据只有一份；bootstrap 经这里取，不碰 infrastructure。 */
export function composeSkillContentAvailability(input: {
  readonly appHome: string
}): SkillContentAvailability {
  return createSkillContentAvailability(input)
}

/**
 * Bootstrap 装配：从数据库句柄直接装出 Workflow 目录——语义层与广播事件在这里接，bootstrap 不碰 infrastructure
 * （RFC-294 §3.1 的 offered 边只允许 bootstrap → composition）。
 */
export function composeDatabaseWorkflowCatalog(input: {
  readonly db: ProviderNeutralDatabase
  readonly resourceCatalog: Pick<ProviderResourceCatalogComposition, 'authorization' | 'acl'>
  readonly skillContent: SkillContentAvailability
}): WorkflowCatalogModule {
  return composeWorkflowCatalog({
    db: input.db,
    persistence: createWorkflowPersistenceSemantics({
      authorization: input.resourceCatalog.authorization,
      events: workflowBroadcastEvents(),
    }),
    skillContent: input.skillContent,
    resourceCatalog: input.resourceCatalog,
  })
}

/**
 * RFC-345 T9 — the dynamic-workflow validation context is Resource Catalog's
 * own legacy loader. Bootstrap used to import it through the `@/services`
 * compatibility facade only to hand it straight back into the task engine; the
 * PostgreSQL daemon already builds its source from the public catalog queries,
 * so the SQLite side owns its loader here instead of borrowing the facade.
 */
export function composeSqliteDynamicWorkflowValidationContext(db: DbClient): Readonly<{
  load(): Promise<ValidatorContext>
}> {
  return Object.freeze({
    load: () => loadWorkflowValidationContext(db),
  })
}
