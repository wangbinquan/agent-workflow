import { isTerminalTaskStatus, type TaskStatus } from '@agent-workflow/shared'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  collaborationCommittedEventCodec,
  createCollaborationWsProjector,
  createCollaborationCommittedEventProjection,
} from '@/modules/collaboration/composition/committedEvents'
import { taskLifecycleCommittedEventCodec } from '@/modules/task-execution/application/taskLifecycleConsumers'
import {
  decodeTaskLifecycleCommittedEvent,
  TASK_LIFECYCLE_COMMITTED_EVENT_TYPES,
} from '@/modules/task-execution/domain/taskLifecycleCommittedEvent'
import { createDatabaseTaskLifecycleWsProjector } from '@/modules/task-execution/composition/committedEvents'
import { createAfterCommitEventPump } from '@/platform/events/committed/afterCommitEventPump'
import { combineCommittedEventCodecRegistries } from '@/platform/events/committed/dispatcherWorker'
import { registerAfterCommitEventPump } from '@/platform/events/committed/runtime'
import { createCommittedEventDeliveryPersistence } from '@/platform/events/committed/deliveryPersistence'

export interface TaskLifecycleAfterCommitTestCallbacks {
  readonly onTerminalTask?: (
    db: PersistenceDb,
    taskId: string,
    to: TaskStatus,
  ) => void | Promise<unknown>
  readonly onExecutionWatch?: (
    db: PersistenceDb,
    taskId: string,
    to: TaskStatus,
  ) => void | Promise<unknown>
  readonly onWorkspacePrune?: (
    db: PersistenceDb,
    taskId: string,
    to: 'done' | 'canceled',
  ) => void | Promise<unknown>
}

/**
 * Test-only composition of the production receipt/pump path. It always owns
 * the canonical task WebSocket projection; tests that isolate a durable
 * consumer can additionally inject that consumer's synchronous test effect
 * without resurrecting lifecycle's removed ambient hook slots.
 */
export function installTaskLifecycleAfterCommitTestPump(
  db: PersistenceDb,
  callbacks: TaskLifecycleAfterCommitTestCallbacks,
): () => void {
  const effects: Promise<unknown>[] = []
  const track = (effect: void | Promise<unknown>) => {
    if (effect) {
      effects.push(effect)
      // Observe rejection immediately; the harness drain still reports it.
      void effect.catch(() => undefined)
    }
  }
  const pump = createAfterCommitEventPump({
    persistence: createCommittedEventDeliveryPersistence(db),
    codecs: combineCommittedEventCodecRegistries(
      taskLifecycleCommittedEventCodec,
      collaborationCommittedEventCodec,
    ),
    projectors: [
      createDatabaseTaskLifecycleWsProjector(db),
      createCollaborationWsProjector(createCollaborationCommittedEventProjection(db)),
      {
        id: 'task-lifecycle-test-effect-projector',
        eventTypes: TASK_LIFECYCLE_COMMITTED_EVENT_TYPES,
        deliveryClass: 'ephemeral',
        settle: 'projection-attempted',
        handle(value) {
          const event = decodeTaskLifecycleCommittedEvent(value)
          if (event.type !== 'task.lifecycle-transitioned.v1') return
          // RFC-359 W8：与生产的 `task-execution-watch` 同口径——多段式续跑准入的内部交棒
          // （`continuationHandoff`）不是任务的结局，不得当成终态。SQLite 的一段式准入从不
          // 置这个标记，所以今天这里一行行为都不变；写上是为了这份**影子实现**不会在将来
          // 被拿去跑 PG 的事件时给出与生产相反的结论。
          if (event.payload.continuationHandoff) return
          if (isTerminalTaskStatus(event.payload.status)) {
            track(callbacks.onExecutionWatch?.(db, event.payload.taskId, event.payload.status))
          }
          if (event.payload.status === 'done' || event.payload.status === 'canceled') {
            track(callbacks.onTerminalTask?.(db, event.payload.taskId, event.payload.status))
          }
          if (
            event.payload.workspacePruneClaim !== null &&
            (event.payload.status === 'done' || event.payload.status === 'canceled')
          ) {
            track(callbacks.onWorkspacePrune?.(db, event.payload.taskId, event.payload.status))
          }
        },
      },
    ],
    nudgeDispatcher() {},
  })
  drains.set(db, async () => {
    await pump.awaitDrained()
    while (effects.length > 0) {
      await Promise.all(effects.splice(0))
      await pump.awaitDrained()
    }
  })
  registerAfterCommitEventPump(pump)
  return () => registerAfterCommitEventPump(null)
}

const drains = new WeakMap<PersistenceDb, () => Promise<void>>()
/** Drain outside the serialized projector: a terminal sweep publishes a new receipt itself. */
export async function drainTaskLifecycleTestEffects(db: PersistenceDb): Promise<void> {
  await drains.get(db)?.()
  drains.delete(db)
}
