import { and, eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { committedEventFamilyCutovers } from '@/db/schema'
import {
  createCollaborationDurableConsumerDefinitions,
  collaborationCommittedEventCodec,
  createCollaborationWsProjector,
  createSqliteCollaborationCommittedEventProjection,
} from '@/modules/collaboration/composition/committedEvents'
import {
  createTaskLifecycleDurableConsumerDefinitions,
  createSqliteTaskLifecycleWsProjector,
  taskLifecycleCommittedEventCodec,
} from '@/modules/task-execution/composition/committedEvents'
import { createAfterCommitEventPump } from '@/platform/events/committed/afterCommitEventPump'
import {
  combineCommittedEventCodecRegistries,
  createCommittedEventDispatcher,
} from '@/platform/events/committed/dispatcherWorker'
import { createCommittedEventProjectionLedger } from '@/platform/events/committed/types'
import { registerAfterCommitEventPump } from '@/platform/events/committed/runtime'
import { createSqliteCommittedEventDeliveryPersistence } from '@/platform/events/committed/sqlitePersistence'
import { createSqliteMemoryDistillEnqueuer } from './memoryDistill'

function enableCollaborationCutover(db: DbClient): void {
  db.update(committedEventFamilyCutovers)
    .set({ mode: 'dispatchable', epoch: 2, changedAt: Date.now(), changeRef: 'test-harness' })
    .where(
      and(
        eq(committedEventFamilyCutovers.producer, 'collaboration'),
        eq(committedEventFamilyCutovers.epoch, 1),
      ),
    )
    .run()
}

/** Install only the synchronous projection half of the RFC-341 bootstrap for
 * broadcaster-boundary tests. Durable consumer behavior has its own worker
 * harnesses; these tests need deterministic frame delivery in-process. */
export function installCommittedEventProjectionHarness(db: DbClient): () => void {
  enableCollaborationCutover(db)
  const codecs = combineCommittedEventCodecRegistries(
    taskLifecycleCommittedEventCodec,
    collaborationCommittedEventCodec,
  )
  registerAfterCommitEventPump(
    createAfterCommitEventPump({
      persistence: createSqliteCommittedEventDeliveryPersistence(db),
      codecs,
      projectors: [
        createSqliteTaskLifecycleWsProjector(db),
        createCollaborationWsProjector(createSqliteCollaborationCommittedEventProjection(db)),
      ],
      nudgeDispatcher() {},
    }),
  )
  return () => registerAfterCommitEventPump(null)
}

export interface CommittedEventDeliveryTestHarness {
  /** Drain the same durable consumer definitions used by daemon bootstrap. */
  drain(maxSteps?: number): Promise<void>
  dispose(): void
}

function durableTestConsumers(db: DbClient) {
  const memoryDistill = createSqliteMemoryDistillEnqueuer(db)
  const events = {
    async observe(input: { readonly dedupeKey: string }) {
      return { eventId: input.dedupeKey, duplicate: false, deliveryCount: 0, deliveryIds: [] }
    },
  }
  return [
    ...createTaskLifecycleDurableConsumerDefinitions({
      events,
      async closeTerminalGates() {},
      async notifyChildBudget() {},
      async notifyExecutionWatch() {},
      async nudgeWorkspacePrune() {},
    }),
    ...createCollaborationDurableConsumerDefinitions({
      events,
      nudgeContinuation() {},
      async enqueueReviewDistill(input) {
        await memoryDistill.enqueue({
          sourceKind: 'review',
          sourceEventId: input.sourceEventId,
          taskId: input.taskId,
        })
      },
    }),
  ]
}

/** Drain only durable effects without installing or replaying any WS
 * projector. Useful when a test already owns a task-lifecycle projection
 * pump but needs to observe the later durable consumer boundary. */
export async function drainCommittedEventDeliveriesForTests(
  db: DbClient,
  maxSteps = 256,
): Promise<void> {
  enableCollaborationCutover(db)
  const dispatcher = createCommittedEventDispatcher({
    persistence: createSqliteCommittedEventDeliveryPersistence(db),
    workerId: 'committed-event-test-drain',
    codecs: combineCommittedEventCodecRegistries(
      taskLifecycleCommittedEventCodec,
      collaborationCommittedEventCodec,
    ),
    consumers: durableTestConsumers(db),
    maxAttempts: () => 1,
  })
  await dispatcher.drain(maxSteps)
}

/** Full RFC-341 test composition for legacy service tests that assert a
 * durable consumer effect (currently review distill) as well as immediate WS
 * projection. The caller chooses the deterministic drain point; request
 * services never run durable consumers inline. */
export function installCommittedEventDeliveryHarness(
  db: DbClient,
): CommittedEventDeliveryTestHarness {
  enableCollaborationCutover(db)
  const codecs = combineCommittedEventCodecRegistries(
    taskLifecycleCommittedEventCodec,
    collaborationCommittedEventCodec,
  )
  const projectors = [
    createSqliteTaskLifecycleWsProjector(db),
    createCollaborationWsProjector(createSqliteCollaborationCommittedEventProjection(db)),
  ]
  const projectionLedger = createCommittedEventProjectionLedger()
  const dispatcher = createCommittedEventDispatcher({
    persistence: createSqliteCommittedEventDeliveryPersistence(db),
    workerId: 'committed-event-test-harness',
    codecs,
    consumers: [...durableTestConsumers(db), ...projectors],
    projectionLedger,
    maxAttempts: () => 1,
  })
  registerAfterCommitEventPump(
    createAfterCommitEventPump({
      persistence: createSqliteCommittedEventDeliveryPersistence(db),
      codecs,
      projectors,
      projectionLedger,
      nudgeDispatcher() {},
    }),
  )
  return {
    async drain(maxSteps = 256) {
      await dispatcher.drain(maxSteps)
    },
    dispose() {
      registerAfterCommitEventPump(null)
    },
  }
}
