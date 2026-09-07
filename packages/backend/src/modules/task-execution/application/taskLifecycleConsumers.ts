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

/**
 * RFC-359 W8 —— 这一跳是不是多段式续跑准入的**内部交棒**（`status` 是中转态，不是结局）。
 * 语义与来源见 `domain/taskLifecycleCommittedEvent.ts` 的 `continuationHandoff` 字段说明。
 */
function isContinuationHandoff(
  event: ReturnType<typeof decodeTaskLifecycleCommittedEvent>,
): boolean {
  return (
    event.type === 'task.lifecycle-transitioned.v1' && event.payload.continuationHandoff === true
  )
}

export function createTaskLifecycleDurableConsumerDefinitions(input: {
  readonly events: EventObservationParticipant
  readonly closeTerminalGates: (taskId: string, status: 'done' | 'canceled') => Promise<void>
  readonly notifyChildBudget: (taskId: string, status: TaskStatus) => Promise<void>
  readonly notifyExecutionWatch: (taskId: string, status: TaskStatus) => Promise<void>
  readonly nudgeWorkspacePrune: (taskId: string) => Promise<void>
}): readonly CommittedEventConsumerDefinition[] {
  return [
    {
      id: 'event-center.task-lifecycle',
      eventTypes: ['task.created.v1', 'task.lifecycle-transitioned.v1'],
      deliveryClass: 'critical',
      settle: 'durable-effect-recorded',
      async handle(value) {
        const event = decodeTaskLifecycleCommittedEvent(value)
        if (event.type === 'task.node-statuses-transitioned.v1') return
        await input.events.observe(
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
      async handle(value) {
        const event = decodeTaskLifecycleCommittedEvent(value)
        if (
          event.type === 'task.lifecycle-transitioned.v1' &&
          (event.payload.status === 'done' || event.payload.status === 'canceled')
        ) {
          await input.closeTerminalGates(event.payload.taskId, event.payload.status)
        }
      },
    },
    {
      id: 'task-child-budget',
      eventTypes: ['task.created.v1', 'task.lifecycle-transitioned.v1'],
      deliveryClass: 'rebuildable',
      settle: 'delivery-accepted',
      async handle(value) {
        const event = decodeTaskLifecycleCommittedEvent(value)
        if (event.type === 'task.node-statuses-transitioned.v1') return
        // RFC-359 W8: the continuation handoff is not an outcome — the task is
        // mid-retry and will be back in `pending` a moment later. Feeding the
        // handoff status in un-counts the task and re-scans the waiter queue, so a
        // queued sibling child launch gets admitted over the configured budget for
        // the length of the handoff window. SQLite's one-stage retry lands on
        // `pending` and never releases the unit; skipping here makes the two match.
        if (isContinuationHandoff(event)) return
        await input.notifyChildBudget(event.payload.taskId, event.payload.status)
      },
    },
    {
      id: 'task-execution-watch',
      eventTypes: ['task.lifecycle-transitioned.v1'],
      deliveryClass: 'rebuildable',
      settle: 'delivery-accepted',
      async handle(value) {
        const event = decodeTaskLifecycleCommittedEvent(value)
        if (
          event.type === 'task.lifecycle-transitioned.v1' &&
          isTerminalTaskStatus(event.payload.status) &&
          // RFC-359 W8: `interrupted` here is PostgreSQL's two-stage retry handing
          // the task to `children.resume`, not the task settling. Resolving the
          // watch on it wakes RFC-243's parent call node with "the child finished"
          // while the child is about to go back to `pending` and keep running —
          // the parent then walks on with an outcome that never happened. SQLite
          // never produces this frame (its admission CAS lands on `pending`).
          !event.payload.continuationHandoff
        ) {
          await input.notifyExecutionWatch(event.payload.taskId, event.payload.status)
        }
      },
    },
    {
      id: 'task-workspace-prune-nudge',
      eventTypes: ['task.lifecycle-transitioned.v1'],
      deliveryClass: 'rebuildable',
      settle: 'delivery-accepted',
      async handle(value) {
        const event = decodeTaskLifecycleCommittedEvent(value)
        if (
          event.type === 'task.lifecycle-transitioned.v1' &&
          event.payload.workspacePruneClaim !== null
        ) {
          await input.nudgeWorkspacePrune(event.payload.taskId)
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
