import { expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  committedEventDeliveries,
  committedEventFamilyCutovers,
  committedEvents,
} from '@/db/schema'
import {
  collaborationCommittedEventCodec,
  createCollaborationDurableConsumerDefinitions,
} from '@/modules/collaboration/composition/committedEvents'
import { COLLABORATION_COMMITTED_EVENT_TYPES } from '@/modules/collaboration/domain/collaborationCommittedEvent'
import {
  appendHumanGateOpenedCommittedEvent,
  appendReviewSelectionChangedCommittedEvent,
} from '@/modules/collaboration/infrastructure/collaborationCommittedEvents'
import { createColdAfterCommitEventPump } from '@/platform/events/committed/afterCommitEventPump'
import { createCommittedEventDeliveryPersistence } from '@/platform/events/committed/deliveryPersistence'
import { createCommittedEventDispatcher } from '@/platform/events/committed/dispatcherWorker'
import {
  createCommittedEventProjectionLedger,
  type CommittedEventConsumerDefinition,
  type CommittedEventRef,
} from '@/platform/events/committed/types'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { describeEachProvider } from './helpers/eachProvider'
import { eventually } from './helpers/eventually'

const NOW = 1_788_001_734_000
const gate = {
  taskId: 'task-review',
  nodeRunId: 'review-run-1',
  gateKind: 'review' as const,
  gateId: 'review:review-run-1',
  roundId: 'review-run-1',
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function lifetime() {
  return {
    valid: true,
    current() {
      return this.valid
    },
  }
}

async function appendReviewOpen(
  db: ProviderNeutralDatabase,
  operationRef: string,
): Promise<CommittedEventRef> {
  const receipt = await databaseSessionFor(db).transaction((tx) =>
    appendHumanGateOpenedCommittedEvent(tx, {
      family: 'review',
      gate,
      occurredAt: NOW,
      identity: { operationRef, eventGroupId: `group:${operationRef}`, eventGroupOrdinal: 0 },
    }),
  )
  if (receipt === null) throw new Error('expected original dispatchable review receipt')
  return receipt
}

describeEachProvider(
  'RFC-370 cold after-commit original persistence and projection tails',
  (harness) => {
    test('loss retains the whole real projection tail and durable recovery delivers an unpumped receipt', async () => {
      const db = harness.db
      await db
        .update(committedEventFamilyCutovers)
        .set({
          mode: 'dispatchable',
          epoch: 2,
          changedAt: NOW,
          changeRef: 'rfc370-after-commit-tail',
        })
        .where(
          and(
            eq(committedEventFamilyCutovers.producer, 'collaboration'),
            eq(committedEventFamilyCutovers.epoch, 1),
          ),
        )
        .run()
      const first = await appendReviewOpen(db, 'rfc370-pumped-group')
      const second = await harness.session.transaction(async (tx) => {
        const receipt = await appendReviewSelectionChangedCommittedEvent(tx, {
          gate,
          occurredAt: NOW + 1,
          projectionFrames: [
            {
              id: -1,
              type: 'review.selection_changed',
              nodeRunId: gate.nodeRunId,
              docVersionId: 'document-1',
              selection: 'accepted',
            },
          ],
          identity: {
            operationRef: 'rfc370-pumped-group',
            eventGroupId: first.eventGroupId,
            eventGroupOrdinal: 1,
          },
        })
        if (receipt === null) throw new Error('expected original dispatchable selection receipt')
        return receipt
      })
      const persistence = createCommittedEventDeliveryPersistence(db)
      const projectionLedger = createCommittedEventProjectionLedger()
      const projectWait = deferred()
      const entered: string[] = []
      const completed: string[] = []
      let nudges = 0
      const projector: CommittedEventConsumerDefinition = {
        id: 'rfc370-original-provider-projector',
        eventTypes: COLLABORATION_COMMITTED_EVENT_TYPES,
        deliveryClass: 'ephemeral',
        settle: 'projection-attempted',
        async handle(event) {
          // This is an awaited query through the original SQLite/PG persistence,
          // not a synthetic SQL-success response or an empty drain adapter.
          const actual = await persistence.getStored([event.eventId])
          expect(actual.map((stored) => stored.envelope.eventId)).toEqual([event.eventId])
          entered.push(event.eventId)
          if (event.eventId === first.eventId) await projectWait.promise
          completed.push(event.eventId)
        },
      }
      const pump = createColdAfterCommitEventPump({
        persistence,
        codecs: collaborationCommittedEventCodec,
        projectors: [projector],
        projectionLedger,
        nudgeDispatcher() {
          nudges += 1
        },
      })
      const firstLifetime = lifetime()
      const secondLifetime = lifetime()
      let publishing: Promise<void> | undefined
      let starting: Promise<void> | undefined
      try {
        await pump.start(firstLifetime)
        publishing = pump.publishNow([second, first])
        await eventually(
          async () => entered.length,
          (count) => count === 1,
        )
        expect(entered).toEqual([first.eventId])
        firstLifetime.valid = false
        await pump.quiesce(firstLifetime)
        await expect(pump.awaitDrained(firstLifetime, 17)).rejects.toThrow(
          'after-commit execution actual drain timed out',
        )
        expect(completed).toEqual([])
        pump.nudge()
        await expect(pump.publishNow([second])).rejects.toThrow(
          'after-commit execution is not ready',
        )
        starting = pump.start(secondLifetime)
        let ready = false
        void starting.then(
          () => {
            ready = true
          },
          () => undefined,
        )
        expect(ready).toBe(false)
        expect(nudges).toBe(0)
        projectWait.resolve()
        await Promise.all([publishing, starting, pump.awaitDrained(firstLifetime)])
        expect(ready).toBe(true)
        expect(completed).toEqual([first.eventId, second.eventId])
        expect(nudges).toBe(0)
        await pump.publishNow([second, first])
        expect(completed).toEqual([first.eventId, second.eventId])
        expect(nudges).toBe(1)
        await pump.quiesce(secondLifetime)
        await pump.awaitDrained(secondLifetime)

        // No immediate pump receives this committed ref. Original durable claims,
        // consumers and settlement recover it from the same real database.
        const unpumped = await appendReviewOpen(db, 'rfc370-unpumped')
        const observed: string[] = []
        const durable = createCollaborationDurableConsumerDefinitions({
          events: {
            async observe(input) {
              observed.push(input.dedupeKey)
              return {
                eventId: input.dedupeKey,
                duplicate: false,
                deliveryCount: 0,
                deliveryIds: [],
              }
            },
          },
          nudgeContinuation() {},
          enqueueReviewDistill() {},
        })
        const dispatcher = createCommittedEventDispatcher({
          persistence,
          workerId: 'rfc370-original-provider-dispatcher',
          codecs: collaborationCommittedEventCodec,
          consumers: [...durable, projector],
          projectionLedger,
          now: () => NOW + 100,
        })
        await dispatcher.drain(32)
        expect(completed).toEqual([first.eventId, second.eventId, unpumped.eventId])
        expect(entered).toEqual(completed)
        expect(observed.length).toBeGreaterThan(0)
        expect(await db.select().from(committedEvents).all()).toHaveLength(3)
        expect(
          (
            await db
              .select()
              .from(committedEventDeliveries)
              .where(eq(committedEventDeliveries.state, 'accepted'))
              .all()
          ).length,
        ).toBeGreaterThan(0)
        expect(await persistence.health()).toMatchObject({ pending: 0, claimed: 0, deadLetter: 0 })
      } finally {
        firstLifetime.valid = false
        secondLifetime.valid = false
        await Promise.all([pump.quiesce(firstLifetime), pump.quiesce(secondLifetime)])
        projectWait.resolve()
        await Promise.allSettled([publishing, starting])
        await Promise.all([pump.awaitDrained(firstLifetime), pump.awaitDrained(secondLifetime)])
      }
    }, 40_000)
  },
)
