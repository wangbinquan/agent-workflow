// RFC-480: the task-lifecycle event identities and the observation builder moved here from public/events (no other context
// imports them); public/events keeps importing the two refs for the event catalog it offers.
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
