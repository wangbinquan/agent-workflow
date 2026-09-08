import { and, eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { committedEventFamilyCutovers } from '@/db/schema'
import {
  createCollaborationDurableConsumerDefinitions,
  collaborationCommittedEventCodec,
  createCollaborationWsProjector,
  createCollaborationCommittedEventProjection,
} from '@/modules/collaboration/composition/committedEvents'
import {
  createTaskLifecycleDurableConsumerDefinitions,
  createDatabaseTaskLifecycleWsProjector,
  taskLifecycleCommittedEventCodec,
} from '@/modules/task-execution/composition/committedEvents'
import { createAfterCommitEventPump } from '@/platform/events/committed/afterCommitEventPump'
import {
  combineCommittedEventCodecRegistries,
  createCommittedEventDispatcher,
} from '@/platform/events/committed/dispatcherWorker'
import { createCommittedEventProjectionLedger } from '@/platform/events/committed/types'
import { registerAfterCommitEventPump } from '@/platform/events/committed/runtime'
import { createCommittedEventDeliveryPersistence } from '@/platform/events/committed/deliveryPersistence'
import { createSqliteMemoryDistillEnqueuer } from './memoryDistill'

async function enableCollaborationCutover(db: ProviderNeutralDatabase): Promise<void> {
  await db
    .update(committedEventFamilyCutovers)
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
export async function installCommittedEventProjectionHarness(
  db: ProviderNeutralDatabase,
): Promise<() => void> {
  await enableCollaborationCutover(db)
  const codecs = combineCommittedEventCodecRegistries(
    taskLifecycleCommittedEventCodec,
    collaborationCommittedEventCodec,
  )
  registerAfterCommitEventPump(
    createAfterCommitEventPump({
      persistence: createCommittedEventDeliveryPersistence(db),
      codecs,
      projectors: [
        createDatabaseTaskLifecycleWsProjector(db),
        createCollaborationWsProjector(createCollaborationCommittedEventProjection(db)),
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

function durableTestConsumers(db: ProviderNeutralDatabase) {
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
  db: ProviderNeutralDatabase,
  maxSteps = 256,
): Promise<void> {
  await enableCollaborationCutover(db)
  const dispatcher = createCommittedEventDispatcher({
    persistence: createCommittedEventDeliveryPersistence(db),
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
export async function installCommittedEventDeliveryHarness(
  db: ProviderNeutralDatabase,
): Promise<CommittedEventDeliveryTestHarness> {
  await enableCollaborationCutover(db)
  const codecs = combineCommittedEventCodecRegistries(
    taskLifecycleCommittedEventCodec,
    collaborationCommittedEventCodec,
  )
  const projectors = [
    createDatabaseTaskLifecycleWsProjector(db),
    createCollaborationWsProjector(createCollaborationCommittedEventProjection(db)),
  ]
  const projectionLedger = createCommittedEventProjectionLedger()
  const dispatcher = createCommittedEventDispatcher({
    persistence: createCommittedEventDeliveryPersistence(db),
    workerId: 'committed-event-test-harness',
    codecs,
    consumers: [...durableTestConsumers(db), ...projectors],
    projectionLedger,
    maxAttempts: () => 1,
  })
  registerAfterCommitEventPump(
    createAfterCommitEventPump({
      persistence: createCommittedEventDeliveryPersistence(db),
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
