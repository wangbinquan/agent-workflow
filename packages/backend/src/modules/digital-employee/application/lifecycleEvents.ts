// RFC-550 (RFC-294 S9): the employee lifecycle event refs and the observations the module publishes. They sat on
// `public/events` without any other module consuming them; the event catalog that bootstrap reads stays public.
import type { EventObservationInput } from '@/modules/event-center/public/types'

export const EMPLOYEE_LIFECYCLE_SOURCE_REF = {
  id: 'platform.employee-lifecycle',
  revision: 1,
} as const

export const EMPLOYEE_CASE_STATE_CHANGED_EVENT_REF = {
  id: 'platform.employee-case.state-changed',
  revision: 1,
} as const

export const EMPLOYEE_INVOCATION_RESULT_EVENT_REF = {
  id: 'platform.employee-invocation.result-returned',
  revision: 1,
} as const

type EmployeeCaseState = 'active' | 'waiting' | 'blocked' | 'terminal'

export function employeeCaseLifecycleObservation(input: {
  readonly caseId: string
  readonly employeeId: string
  readonly revision: number
  readonly previousState: EmployeeCaseState | null
  readonly state: EmployeeCaseState
  readonly terminalKind: string | null
  readonly occurredAt: number
}): EventObservationInput {
  return {
    sourceRef: EMPLOYEE_LIFECYCLE_SOURCE_REF,
    eventTypeRef: EMPLOYEE_CASE_STATE_CHANGED_EVENT_REF,
    subject: { typeId: 'digital-employee.case', subjectRef: input.caseId },
    occurredAt: input.occurredAt,
    dedupeKey: `employee-case:${input.caseId}:lifecycle:${input.revision}`,
    summary: `Employee Case ${input.caseId}: ${input.previousState ?? 'created'} → ${input.state}`,
    payloadArtifactRef: null,
    routingFactsJson: JSON.stringify({
      caseId: input.caseId,
      employeeId: input.employeeId,
      state: input.state,
      previousState: input.previousState,
      revision: input.revision,
      terminalKind: input.terminalKind,
    }),
    triggerParameters: {
      case_id: input.caseId,
      employee_id: input.employeeId,
      state: input.state,
      previous_state: input.previousState ?? '',
      revision: String(input.revision),
      terminal_kind: input.terminalKind ?? '',
    },
  }
}

export function employeeInvocationResultObservation(input: {
  readonly invocationRef: string
  readonly state: 'satisfied' | 'failed'
  readonly terminalKind: string
  readonly summary: string
  readonly envelopeDigest: string
  readonly occurredAt: number
}): EventObservationInput {
  return {
    sourceRef: EMPLOYEE_LIFECYCLE_SOURCE_REF,
    eventTypeRef: EMPLOYEE_INVOCATION_RESULT_EVENT_REF,
    subject: { typeId: 'employee-invocation', subjectRef: input.invocationRef },
    occurredAt: input.occurredAt,
    dedupeKey: `employee-invocation-result:${input.envelopeDigest}`,
    summary: input.summary,
    payloadArtifactRef: null,
    triggerParameters: {
      invocation_ref: input.invocationRef,
      state: input.state,
      terminal_kind: input.terminalKind,
    },
  }
}
