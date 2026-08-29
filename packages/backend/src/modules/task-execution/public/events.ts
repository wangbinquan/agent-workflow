import type { TaskStatus } from '@agent-workflow/shared'

import type { EventObservationInput } from '@/modules/event-center/public/types'

export const TASK_LIFECYCLE_SOURCE_REF = {
  id: 'platform.task-lifecycle',
  revision: 1,
} as const

export const TASK_STATUS_CHANGED_EVENT_REF = {
  id: 'platform.task.status-changed',
  revision: 1,
} as const

/** Stable catalog contribution owned by task-execution, not Event Center. */
export const taskLifecycleEventCatalogJson = JSON.stringify({
  typeRef: { typeId: 'task-execution', revision: 1 },
  eventSources: [
    {
      sourceId: TASK_LIFECYCLE_SOURCE_REF.id,
      version: TASK_LIFECYCLE_SOURCE_REF.revision,
      displayName: { 'zh-CN': '编排任务生命周期', 'en-US': 'Orchestration task lifecycle' },
      description: {
        'zh-CN': '由任务状态事务提交后发布的平台事实。',
        'en-US': 'Platform facts published from committed task status transactions.',
      },
      observationMode: 'passive',
      observerProgramRef: null,
      pollIntervalMs: 60_000,
      batchSize: 100,
    },
  ],
  eventTypes: [
    {
      eventTypeId: TASK_STATUS_CHANGED_EVENT_REF.id,
      version: TASK_STATUS_CHANGED_EVENT_REF.revision,
      subjectTypeId: 'platform.task',
      payloadSchemaId: 'platform.task-status-change',
      displayName: { 'zh-CN': '编排任务状态变化', 'en-US': 'Orchestration task status changed' },
      description: {
        'zh-CN': '一个编排任务已进入新的生命周期状态。',
        'en-US': 'An orchestration task entered a new lifecycle state.',
      },
      deliveryClass: 'platform.task-status',
      sourceRef: TASK_LIFECYCLE_SOURCE_REF,
      triggerParameters: {
        namespace: 'task',
        fields: [
          ['task_id', '任务 ID', 'Task ID'],
          ['status', '当前状态', 'Current status'],
          ['previous_status', '上一状态', 'Previous status'],
          ['revision', '生命周期修订', 'Lifecycle revision'],
        ].map(([fieldId, zh, en]) => ({
          fieldId,
          displayName: { 'zh-CN': zh, 'en-US': en },
          description: { 'zh-CN': zh, 'en-US': en },
        })),
      },
    },
  ],
})

export function taskLifecycleObservation(input: {
  readonly taskId: string
  readonly revision: number
  readonly previousStatus: TaskStatus | null
  readonly status: TaskStatus
  readonly occurredAt: number
}): EventObservationInput {
  return {
    sourceRef: TASK_LIFECYCLE_SOURCE_REF,
    eventTypeRef: TASK_STATUS_CHANGED_EVENT_REF,
    subject: { typeId: 'platform.task', subjectRef: input.taskId },
    occurredAt: input.occurredAt,
    dedupeKey: `task:${input.taskId}:lifecycle:${input.revision}`,
    summary: `Task ${input.taskId}: ${input.previousStatus ?? 'created'} → ${input.status}`,
    payloadArtifactRef: null,
    routingFactsJson: JSON.stringify({
      taskId: input.taskId,
      status: input.status,
      previousStatus: input.previousStatus,
      revision: input.revision,
    }),
    triggerParameters: {
      task_id: input.taskId,
      status: input.status,
      previous_status: input.previousStatus ?? '',
      revision: String(input.revision),
    },
  }
}
