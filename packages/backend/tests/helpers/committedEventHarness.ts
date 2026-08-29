import { and, eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { committedEventFamilyCutovers } from '@/db/schema'
import {
  collaborationCommittedEventCodec,
  createCollaborationWsProjector,
} from '@/modules/collaboration/composition/committedEvents'
import {
  createTaskLifecycleWsProjector,
  taskLifecycleCommittedEventCodec,
} from '@/modules/task-execution/composition/committedEvents'
import { createAfterCommitEventPump } from '@/platform/events/committed/afterCommitEventPump'
import { combineCommittedEventCodecRegistries } from '@/platform/events/committed/dispatcherWorker'
import { registerAfterCommitEventPump } from '@/platform/events/committed/runtime'

/** Install only the synchronous projection half of the RFC-341 bootstrap for
 * broadcaster-boundary tests. Durable consumer behavior has its own worker
 * harnesses; these tests need deterministic frame delivery in-process. */
export function installCommittedEventProjectionHarness(db: DbClient): () => void {
  db.update(committedEventFamilyCutovers)
    .set({ mode: 'dispatchable', epoch: 2, changedAt: Date.now(), changeRef: 'test-harness' })
    .where(
      and(
        eq(committedEventFamilyCutovers.producer, 'collaboration'),
        eq(committedEventFamilyCutovers.epoch, 1),
      ),
    )
    .run()
  const codecs = combineCommittedEventCodecRegistries(
    taskLifecycleCommittedEventCodec,
    collaborationCommittedEventCodec,
  )
  registerAfterCommitEventPump(
    createAfterCommitEventPump({
      db,
      codecs,
      projectors: [createTaskLifecycleWsProjector(db), createCollaborationWsProjector(db)],
      nudgeDispatcher() {},
    }),
  )
  return () => registerAfterCommitEventPump(null)
}
