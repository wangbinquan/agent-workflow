import {
  EMPLOYEE_CASE_STATE_CHANGED_EVENT_REF,
  EMPLOYEE_INVOCATION_RESULT_EVENT_REF,
  EMPLOYEE_LIFECYCLE_SOURCE_REF,
} from '../application/lifecycleEvents'

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
