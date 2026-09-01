import type { EmployeeCaseWorkspaceRow } from './employeeWorkspacePersistence'

export type EmployeeApprovalSagaStatus =
  | 'prepared'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'unavailable'

export interface EmployeeApprovalSagaRecord {
  readonly caseId: string
  readonly adapterId: string
  readonly adapterRevision: number
  readonly validatedDraftRef: string
  readonly intentDigest: string
  readonly correlationRef: string | null
  readonly externalRequestRef: string | null
  readonly submittedRevision: string | null
  readonly submittedAt: string | null
  readonly latestStatus: EmployeeApprovalSagaStatus
  readonly observedRevision: string | null
  readonly evidenceRef: string | null
}

export interface PrepareEmployeeApprovalSagaInput extends EmployeeApprovalSagaRecord {
  readonly id: string
  readonly submitRoundId: string
  readonly deadlineAt: string
  readonly idempotencyKey: string
  readonly observedAt: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface EmployeeChangeCandidateRecord {
  readonly candidateRef: string
  readonly baselineSha: string
  readonly treeOid: string
  readonly receiptJson: string
  readonly summarySource: string
  readonly state: 'prepared' | 'committed' | 'published' | 'obsolete'
  readonly commitSha: string | null
}

export interface EmployeePlatformWorkItemPersistence {
  currentWorkspace(caseId: string): Promise<{
    readonly row: EmployeeCaseWorkspaceRow
    readonly repositoryLocalPath: string
  } | null>
  prepareApprovalSaga(
    input: PrepareEmployeeApprovalSagaInput,
  ): Promise<EmployeeApprovalSagaRecord | null>
  approvalSaga(idempotencyKey: string): Promise<EmployeeApprovalSagaRecord | null>
  recordApprovalSubmission(input: {
    readonly idempotencyKey: string
    readonly correlationRef: string
    readonly externalRequestRef: string
    readonly submittedRevision: string
    readonly submittedAt: string
    readonly updatedAt: number
  }): Promise<void>
  recordApprovalObservation(input: {
    readonly idempotencyKey: string
    readonly latestStatus: Exclude<EmployeeApprovalSagaStatus, 'prepared'>
    readonly observedRevision: string | null
    readonly evidenceRef: string | null
    readonly observedAt: string
    readonly updatedAt: number
  }): Promise<void>
  insertCandidate(input: {
    readonly candidateRef: string
    readonly caseId: string
    readonly roundId: string
    readonly baselineSha: string
    readonly treeOid: string
    readonly receiptJson: string
    readonly summarySource: string
    readonly createdAt: number
    readonly updatedAt: number
  }): Promise<void>
  candidate(candidateRef: string): Promise<EmployeeChangeCandidateRecord | null>
  recordCandidateCommit(input: {
    readonly candidateRef: string
    readonly commitSha: string
    readonly updatedAt: number
  }): Promise<void>
  publishCandidateAndWorkspace(input: {
    readonly candidateRef: string
    readonly caseId: string
    readonly commitSha: string
    readonly pushReceiptJson: string
    readonly updatedAt: number
  }): Promise<void>
  updateWorkspaceHead(input: {
    readonly caseId: string
    readonly baselineSha: string
    readonly remoteHeadSha: string
    readonly updatedAt: number
  }): Promise<void>
  latestRoundValidation(roundId: string): Promise<string | null>
}
