import type {
  CopyWorkflowRequest,
  CreateWorkflow,
  DeleteWorkflow,
  SaveWorkflowReceipt,
  Workflow,
  WorkflowDetail,
  UpdateWorkflow,
} from '@agent-workflow/shared'
import type { WorkflowOperationContext } from '../../public/participants'
import type { WorkflowAclIdentity } from '../../public/types'

export type WorkflowAccessRow = Workflow | WorkflowAclIdentity

export interface WorkflowRepository {
  list(): Promise<readonly Workflow[]>
  get(id: string): Promise<WorkflowDetail | null>
  getAclIdentity(id: string): Promise<WorkflowAclIdentity | null>
  create(authority: WorkflowOperationContext, input: CreateWorkflow): Promise<WorkflowDetail>
  copy(
    authority: WorkflowOperationContext,
    id: string,
    input: CopyWorkflowRequest,
  ): Promise<WorkflowDetail>
  update(
    authority: WorkflowOperationContext,
    id: string,
    input: UpdateWorkflow,
  ): Promise<SaveWorkflowReceipt>
  delete(authority: WorkflowOperationContext, id: string, input: DeleteWorkflow): Promise<void>
}

export interface WorkflowAccessPort {
  filterVisible(
    authority: WorkflowOperationContext,
    rows: readonly Workflow[],
  ): Promise<readonly Workflow[]>
  canView(authority: WorkflowOperationContext, row: WorkflowAccessRow): Promise<boolean>
  requireResourceEdit(authority: WorkflowOperationContext, row: WorkflowAccessRow): Promise<void>
  requireResourceGovern(authority: WorkflowOperationContext, row: WorkflowAccessRow): Promise<void>
}

export interface WorkflowPolicyPort {
  excludeBuiltin(rows: readonly Workflow[]): Workflow[]
  assertMutable(row: WorkflowAccessRow): void
}
