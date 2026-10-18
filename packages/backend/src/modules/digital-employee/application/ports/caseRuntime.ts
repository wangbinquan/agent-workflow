// RFC-375 — case runtime contracts stay inside the Digital Employee context.
import type { ExactResourceRef } from '../../domain/model'

export interface EmployeeCaseRef {
  readonly id: string
  readonly revision: number
}

export interface EventSubjectInput {
  readonly typeId: string
  readonly subjectRef: string
}

export interface EmployeeCaseLaunchInput {
  readonly employeeRef: ExactResourceRef
  readonly primaryContextTypeId: string
  readonly primaryContextSchemaVersion: number
  readonly primaryContextState: 'active' | 'waiting' | 'terminal'
  readonly primaryContextJson: string
  readonly artifactRefs: readonly string[]
  readonly workSubject: EventSubjectInput
}

export interface EmployeeCaseProjectionDocument {
  readonly caseRef: EmployeeCaseRef
  readonly state: 'active' | 'waiting' | 'blocked' | 'terminal'
  readonly currentWorkItemRef: string | null
  readonly projectionJson: string
  readonly projectionRevision: number
}
