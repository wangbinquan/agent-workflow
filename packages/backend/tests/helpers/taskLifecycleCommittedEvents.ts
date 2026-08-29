import { isTerminalTaskStatus, type TaskStatus } from '@agent-workflow/shared'

import type { DbClient } from '@/db/client'
import {
  collaborationCommittedEventCodec,
  createCollaborationWsProjector,
} from '@/modules/collaboration/composition/committedEvents'
import { taskLifecycleCommittedEventCodec } from '@/modules/task-execution/application/taskLifecycleConsumers'
import {
  decodeTaskLifecycleCommittedEvent,
  TASK_LIFECYCLE_COMMITTED_EVENT_TYPES,
} from '@/modules/task-execution/domain/taskLifecycleCommittedEvent'
import { createTaskLifecycleWsProjector } from '@/modules/task-execution/infrastructure/taskLifecycleWsProjector'
import { createAfterCommitEventPump } from '@/platform/events/committed/afterCommitEventPump'
import { combineCommittedEventCodecRegistries } from '@/platform/events/committed/dispatcherWorker'
import { registerAfterCommitEventPump } from '@/platform/events/committed/runtime'

export interface TaskLifecycleAfterCommitTestCallbacks {
  readonly onTerminalTask?: (db: DbClient, taskId: string, to: TaskStatus) => void
  readonly onExecutionWatch?: (db: DbClient, taskId: string, to: TaskStatus) => void
  readonly onWorkspacePrune?: (db: DbClient, taskId: string, to: 'done' | 'canceled') => void
}

/**
 * Test-only composition of the production receipt/pump path. It always owns
 * the canonical task WebSocket projection; tests that isolate a durable
 * consumer can additionally inject that consumer's synchronous test effect
 * without resurrecting lifecycle's removed ambient hook slots.
 */
export function installTaskLifecycleAfterCommitTestPump(
  db: DbClient,
  callbacks: TaskLifecycleAfterCommitTestCallbacks,
): () => void {
  const pump = createAfterCommitEventPump({
    db,
    codecs: combineCommittedEventCodecRegistries(
      taskLifecycleCommittedEventCodec,
      collaborationCommittedEventCodec,
    ),
    projectors: [
      createTaskLifecycleWsProjector(db),
      createCollaborationWsProjector(db),
      {
        id: 'task-lifecycle-test-effect-projector',
        eventTypes: TASK_LIFECYCLE_COMMITTED_EVENT_TYPES,
        deliveryClass: 'ephemeral',
        settle: 'projection-attempted',
        handle(value) {
          const event = decodeTaskLifecycleCommittedEvent(value)
          if (event.type !== 'task.lifecycle-transitioned.v1') return
          if (isTerminalTaskStatus(event.payload.status)) {
            callbacks.onExecutionWatch?.(db, event.payload.taskId, event.payload.status)
          }
          if (event.payload.status === 'done' || event.payload.status === 'canceled') {
            callbacks.onTerminalTask?.(db, event.payload.taskId, event.payload.status)
          }
          if (
            event.payload.workspacePruneClaim !== null &&
            (event.payload.status === 'done' || event.payload.status === 'canceled')
          ) {
            callbacks.onWorkspacePrune?.(db, event.payload.taskId, event.payload.status)
          }
        },
      },
    ],
    nudgeDispatcher() {},
  })
  registerAfterCommitEventPump(pump)
  return () => registerAfterCommitEventPump(null)
}
