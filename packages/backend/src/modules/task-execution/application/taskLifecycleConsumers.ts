import { isTerminalTaskStatus, type TaskStatus } from '@agent-workflow/shared'

import type { EventObservationParticipant } from '@/modules/event-center/public/participants'
import type { CommittedEventConsumerDefinition } from '@/platform/events/committed/types'
import { taskLifecycleObservation } from '../public/events'
import {
  decodeTaskLifecycleCommittedEvent,
  TASK_LIFECYCLE_COMMITTED_EVENT_TYPES,
} from '../domain/taskLifecycleCommittedEvent'

export const taskLifecycleCommittedEventCodec = {
  eventTypes: TASK_LIFECYCLE_COMMITTED_EVENT_TYPES,
  decode: decodeTaskLifecycleCommittedEvent,
} as const

export function createTaskLifecycleDurableConsumerDefinitions(input: {
  readonly events: EventObservationParticipant
  readonly closeTerminalGates: (taskId: string, status: 'done' | 'canceled') => void
  readonly notifyChildBudget: (taskId: string, status: TaskStatus) => void
  readonly notifyExecutionWatch: (taskId: string, status: TaskStatus) => void
  readonly nudgeWorkspacePrune: (taskId: string) => void
}): readonly CommittedEventConsumerDefinition[] {
  return [
    {
      id: 'event-center.task-lifecycle',
      eventTypes: ['task.created.v1', 'task.lifecycle-transitioned.v1'],
      deliveryClass: 'critical',
      settle: 'durable-effect-recorded',
      handle(value) {
        const event = decodeTaskLifecycleCommittedEvent(value)
        if (event.type === 'task.node-statuses-transitioned.v1') return
        input.events.observe(
          taskLifecycleObservation({
            taskId: event.payload.taskId,
            revision: event.payload.lifecycleRevision,
            previousStatus: event.payload.previousStatus,
            status: event.payload.status,
            occurredAt: Date.parse(event.occurredAt),
          }),
        )
      },
    },
    {
      id: 'task-terminal-gate-close',
      eventTypes: ['task.lifecycle-transitioned.v1'],
      deliveryClass: 'critical',
      settle: 'durable-effect-recorded',
      handle(value) {
        const event = decodeTaskLifecycleCommittedEvent(value)
        if (
          event.type === 'task.lifecycle-transitioned.v1' &&
          (event.payload.status === 'done' || event.payload.status === 'canceled')
        ) {
          input.closeTerminalGates(event.payload.taskId, event.payload.status)
        }
      },
    },
    {
      id: 'task-child-budget',
      eventTypes: ['task.created.v1', 'task.lifecycle-transitioned.v1'],
      deliveryClass: 'rebuildable',
      settle: 'delivery-accepted',
      handle(value) {
        const event = decodeTaskLifecycleCommittedEvent(value)
        if (event.type !== 'task.node-statuses-transitioned.v1') {
          input.notifyChildBudget(event.payload.taskId, event.payload.status)
        }
      },
    },
    {
      id: 'task-execution-watch',
      eventTypes: ['task.lifecycle-transitioned.v1'],
      deliveryClass: 'rebuildable',
      settle: 'delivery-accepted',
      handle(value) {
        const event = decodeTaskLifecycleCommittedEvent(value)
        if (
          event.type === 'task.lifecycle-transitioned.v1' &&
          isTerminalTaskStatus(event.payload.status)
        ) {
          input.notifyExecutionWatch(event.payload.taskId, event.payload.status)
        }
      },
    },
    {
      id: 'task-workspace-prune-nudge',
      eventTypes: ['task.lifecycle-transitioned.v1'],
      deliveryClass: 'rebuildable',
      settle: 'delivery-accepted',
      handle(value) {
        const event = decodeTaskLifecycleCommittedEvent(value)
        if (
          event.type === 'task.lifecycle-transitioned.v1' &&
          event.payload.workspacePruneClaim !== null
        ) {
          input.nudgeWorkspacePrune(event.payload.taskId)
        }
      },
    },
    {
      id: 'task-node-reconcile',
      eventTypes: ['task.node-statuses-transitioned.v1'],
      deliveryClass: 'rebuildable',
      settle: 'delivery-accepted',
      handle() {
        // The node rows are already durable. This receipt records that the
        // periodic/read-model recovery path may now treat the nudge as seen.
      },
    },
  ]
}
