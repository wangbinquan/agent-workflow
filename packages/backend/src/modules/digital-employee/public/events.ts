import type { EventObservationInput } from '@/modules/event-center/public/types'

export interface EmployeeCaseProjectionInvalidated {
  readonly caseId: string
  readonly revision: number
  readonly reason: 'context' | 'attention' | 'queue' | 'round' | 'channel' | 'terminal'
}

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

export const digitalEmployeeLifecycleEventCatalogJson = JSON.stringify({
  typeRef: { typeId: 'digital-employee', revision: 1 },
  eventSources: [
    {
      sourceId: EMPLOYEE_LIFECYCLE_SOURCE_REF.id,
      version: EMPLOYEE_LIFECYCLE_SOURCE_REF.revision,
      displayName: { 'zh-CN': '数字员工生命周期', 'en-US': 'Digital employee lifecycle' },
      description: {
        'zh-CN': '由数字员工 Case 事务提交后发布的平台事实。',
        'en-US': 'Platform facts published from committed employee Case transactions.',
      },
      observationMode: 'passive',
      observerProgramRef: null,
      pollIntervalMs: 60_000,
      batchSize: 100,
    },
  ],
  eventTypes: [
    {
      eventTypeId: EMPLOYEE_CASE_STATE_CHANGED_EVENT_REF.id,
      version: EMPLOYEE_CASE_STATE_CHANGED_EVENT_REF.revision,
      subjectTypeId: 'digital-employee.case',
      payloadSchemaId: 'digital-employee.case-state-change',
      displayName: { 'zh-CN': '数字员工任务状态变化', 'en-US': 'Employee Case state changed' },
      description: {
        'zh-CN': '一个数字员工任务已进入新的生命周期状态。',
        'en-US': 'A Digital Employee Case entered a new lifecycle state.',
      },
      deliveryClass: 'digital-employee.case-state',
      sourceRef: EMPLOYEE_LIFECYCLE_SOURCE_REF,
      triggerParameters: {
        namespace: 'employee_case',
        fields: [
          ['case_id', '任务 ID', 'Case ID'],
          ['employee_id', '数字员工 ID', 'Digital employee ID'],
          ['state', '当前状态', 'Current state'],
          ['previous_state', '上一状态', 'Previous state'],
          ['revision', '任务修订', 'Case revision'],
          ['terminal_kind', '终态类型', 'Terminal kind'],
        ].map(([fieldId, zh, en]) => ({
          fieldId,
          displayName: { 'zh-CN': zh, 'en-US': en },
          description: { 'zh-CN': zh, 'en-US': en },
        })),
      },
    },
    {
      eventTypeId: EMPLOYEE_INVOCATION_RESULT_EVENT_REF.id,
      version: EMPLOYEE_INVOCATION_RESULT_EVENT_REF.revision,
      subjectTypeId: 'employee-invocation',
      payloadSchemaId: 'digital-employee.invocation-result',
      displayName: {
        'zh-CN': '协同数字员工已返回结果',
        'en-US': 'Collaborating employee returned a result',
      },
      description: {
        'zh-CN': '被调起的数字员工已返回完成、失败或超时结果。',
        'en-US': 'An invoked employee returned a completed, failed, or expired result.',
      },
      deliveryClass: 'digital-employee.invocation-result',
      sourceRef: EMPLOYEE_LIFECYCLE_SOURCE_REF,
      triggerParameters: {
        namespace: 'employee_result',
        fields: [
          ['invocation_ref', '协同调用', 'Employee invocation'],
          ['state', '返回状态', 'Result state'],
          ['terminal_kind', '终态类型', 'Terminal kind'],
        ].map(([fieldId, zh, en]) => ({
          fieldId,
          displayName: { 'zh-CN': zh, 'en-US': en },
          description: { 'zh-CN': zh, 'en-US': en },
        })),
      },
    },
  ],
})

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
