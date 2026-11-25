// RFC-580 — the workflow operation descriptors and their catalog inputs / receipts. They left `public/` with the
// workflow HTTP binding (now `inbound/http/workflowRoutes.ts`): nothing outside the module reads them.
import type {
  CommandOperationDescriptor,
  QueryOperationDescriptor,
} from '@/platform/operations/contracts'
import type { CopyWorkflowRequest, SaveWorkflowReceipt, Workflow } from '@agent-workflow/shared'
import type { ResourceAclOperationDescriptors } from '../../public/operations'
import type { WorkflowOperationContext } from '../../public/participants'
import type {
  GetWorkflowCatalogInput,
  JsonBodySubmission,
  WorkflowCatalogDetail,
} from '../../public/types'

export interface CreateWorkflowCatalogInput {
  readonly submission: JsonBodySubmission
}

export interface CopyWorkflowCatalogInput {
  readonly id: string
  readonly copy: CopyWorkflowRequest
}

export interface UpdateWorkflowCatalogInput {
  readonly id: string
  readonly submission: JsonBodySubmission
}

export interface DeleteWorkflowCatalogInput {
  readonly id: string
  readonly submission: JsonBodySubmission
}

export type UpdateWorkflowCatalogReceipt = SaveWorkflowReceipt

export interface DeleteWorkflowCatalogReceipt {
  readonly deleted: Readonly<{
    readonly id: string
    readonly name: string
    readonly ownerUserId: string | null
    readonly visibility: 'public' | 'private'
    readonly builtin: boolean
  }>
  readonly clientMutationId: string
  readonly deletedVersion: number
}

export interface WorkflowOperationDescriptors extends ResourceAclOperationDescriptors<WorkflowOperationContext> {
  readonly list: QueryOperationDescriptor<
    Record<never, never>,
    Workflow[],
    WorkflowOperationContext
  >
  readonly get: QueryOperationDescriptor<
    GetWorkflowCatalogInput,
    WorkflowCatalogDetail | null,
    WorkflowOperationContext
  >
  readonly create: CommandOperationDescriptor<
    CreateWorkflowCatalogInput,
    WorkflowCatalogDetail,
    WorkflowOperationContext
  >
  readonly copy: CommandOperationDescriptor<
    CopyWorkflowCatalogInput,
    WorkflowCatalogDetail,
    WorkflowOperationContext
  >
  readonly update: CommandOperationDescriptor<
    UpdateWorkflowCatalogInput,
    UpdateWorkflowCatalogReceipt,
    WorkflowOperationContext
  >
  readonly delete: CommandOperationDescriptor<
    DeleteWorkflowCatalogInput,
    DeleteWorkflowCatalogReceipt,
    WorkflowOperationContext
  >
}
