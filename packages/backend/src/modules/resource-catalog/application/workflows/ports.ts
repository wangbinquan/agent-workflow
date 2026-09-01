import type {
  ResourceVisibility,
  CopyWorkflowRequest,
  CreateWorkflow,
  DeleteWorkflow,
  SaveWorkflowReceipt,
  Workflow,
  WorkflowDetail,
  WorkflowCandidateHash,
  WorkflowDefinition,
  WorkflowValidationContextHash,
  WorkflowValidationResult,
  UpdateWorkflow,
} from '@agent-workflow/shared'
import type { WorkflowOperationContext } from '../../public/participants'

export interface WorkflowAclIdentity {
  readonly id: string
  readonly name: string
  readonly ownerUserId: string | null
  readonly visibility: ResourceVisibility
  readonly builtin: boolean
}

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

export interface WorkflowValidationCandidate {
  readonly definition: WorkflowDefinition
  readonly currentWorkflow: Readonly<{ id: string; name: string }>
}

/** Provider-owned inventory loader plus the shared pure validator. */
export interface WorkflowValidationPort {
  candidateHash(definition: WorkflowDefinition): WorkflowCandidateHash
  validate(candidate: WorkflowValidationCandidate): Promise<
    Readonly<{
      validationContextHash: WorkflowValidationContextHash
      result: WorkflowValidationResult
    }>
  >
}

export interface WorkflowReferenceAdmissionGroup {
  readonly resourceType: 'agent' | 'workflow' | 'workgroup'
  readonly references: readonly string[]
  readonly domain: 'id' | 'name'
}

/** Provider-specific visibility check for references newly added by a draft. */
export interface WorkflowReferenceAdmissionPort {
  assertUsable(
    authority: WorkflowOperationContext,
    groups: readonly WorkflowReferenceAdmissionGroup[],
  ): Promise<void>
}
