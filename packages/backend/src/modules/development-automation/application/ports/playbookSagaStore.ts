import type { StepRunState } from '../../domain/stepSaga'

export interface StepRunRow {
  readonly id: string
  readonly missionId: string
  readonly employeeId: string
  readonly employeeRevision: number
  readonly stepId: string
  readonly attempt: number
  readonly inputDigest: string
  readonly producerKind: string
  readonly state: StepRunState
  readonly decisionId: string | null
  readonly actionRunId: string | null
  readonly deadlineAt: number | null
  readonly outputRef: string | null
  readonly outputRevision: string | null
  readonly failureCategory: string | null
  readonly failureCode: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface MissionLinkRow {
  readonly id: string
  readonly parentMissionId: string
  readonly parentStepRunId: string
  readonly targetRepositoryId: string
  readonly targetEmployeeId: string
  readonly targetEmployeeRevision: number
  readonly inputDigest: string
  readonly idempotencyKey: string
  readonly childMissionId: string | null
  readonly completion: 'automation-ready' | 'ready-to-merge' | 'merged' | 'completed'
  readonly state: string
  readonly latestChildRevision: number | null
  readonly latestStatus: string | null
  readonly completionSatisfied: boolean
  readonly outputRef: string | null
  readonly observedAt: number | null
}

export interface ApprovalSagaRow {
  readonly id: string
  readonly missionId: string
  readonly stepRunId: string
  readonly adapterId: string
  readonly adapterRevision: number
  readonly draftRef: string
  readonly submitIntentDigest: string
  readonly idempotencyKey: string
  readonly correlationRef: string | null
  readonly externalRequestRef: string | null
  readonly submittedRevision: string | null
  readonly latestStatus:
    | 'submitting'
    | 'pending'
    | 'approved'
    | 'rejected'
    | 'expired'
    | 'unavailable'
  readonly observedRevision: string | null
  readonly evidenceRef: string | null
  readonly deadlineAt: number
  readonly attemptOrdinal: number
  readonly nextObserveAt: number | null
  readonly updatedAt: number
}

export interface StepJoinRow {
  readonly missionId: string
  readonly groupId: string
  readonly memberStepId: string
  readonly mode: 'all' | 'any' | 'quorum'
  readonly quorum: number | null
  readonly deadlineAt: number
  readonly memberState: 'pending' | 'succeeded' | 'failed' | 'expired'
  readonly receiptRevision: string | null
  readonly settledResult: string | null
}

export interface PlaybookSagaStore {
  claimStepRun(input: {
    readonly id: string
    readonly missionId: string
    readonly employeeId: string
    readonly employeeRevision: number
    readonly stepId: string
    readonly attempt: number
    readonly inputDigest: string
    readonly producerKind: string
    readonly deadlineAt: number | null
    readonly now: number
  }): { readonly created: boolean; readonly row: StepRunRow }
  getStepRun(id: string): StepRunRow | null
  listStepRuns(missionId: string): StepRunRow[]
  findStepRunByAction(actionRunId: string): StepRunRow | null
  updateStepRun(input: {
    readonly id: string
    readonly from: readonly StepRunState[]
    readonly state: StepRunState
    readonly decisionId?: string | null
    readonly actionRunId?: string | null
    readonly outputRef?: string | null
    readonly outputRevision?: string | null
    readonly failureCategory?: string | null
    readonly failureCode?: string | null
    readonly now: number
  }): boolean

  claimMissionLink(input: {
    readonly id: string
    readonly parentMissionId: string
    readonly parentStepRunId: string
    readonly targetRepositoryId: string
    readonly targetEmployeeId: string
    readonly targetEmployeeRevision: number
    readonly inputDigest: string
    readonly idempotencyKey: string
    readonly completion: MissionLinkRow['completion']
    readonly now: number
  }): { readonly created: boolean; readonly row: MissionLinkRow }
  getMissionLinkByStepRun(stepRunId: string): MissionLinkRow | null
  findParentMissionLink(childMissionId: string): MissionLinkRow | null
  listMissionLinks(missionId: string): MissionLinkRow[]
  observeMissionLink(input: {
    readonly id: string
    readonly childMissionId: string
    readonly childRevision: number
    readonly status: string
    readonly completionSatisfied: boolean
    readonly outputRef: string | null
    readonly observedAt: number
  }): void

  claimApprovalSaga(input: {
    readonly id: string
    readonly missionId: string
    readonly stepRunId: string
    readonly adapterId: string
    readonly adapterRevision: number
    readonly draftRef: string
    readonly submitIntentDigest: string
    readonly idempotencyKey: string
    readonly deadlineAt: number
    readonly now: number
  }): { readonly created: boolean; readonly row: ApprovalSagaRow }
  getApprovalSaga(id: string): ApprovalSagaRow | null
  getApprovalSagaByStepRun(stepRunId: string): ApprovalSagaRow | null
  listApprovalSagas(missionId: string): ApprovalSagaRow[]
  recordApprovalSubmitted(input: {
    readonly id: string
    readonly correlationRef: string
    readonly externalRequestRef: string
    readonly submittedRevision: string
    readonly now: number
  }): void
  recordApprovalObservation(input: {
    readonly id: string
    readonly status: ApprovalSagaRow['latestStatus']
    readonly observedRevision: string
    readonly evidenceRef: string | null
    readonly nextObserveAt: number | null
    readonly now: number
  }): void

  upsertJoinMember(input: StepJoinRow & { readonly now: number }): void
  listJoinMembers(missionId: string, groupId: string): StepJoinRow[]
  settleJoin(missionId: string, groupId: string, result: string, now: number): void
  sagaDigest(missionId: string): string
}
