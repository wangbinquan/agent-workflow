import { describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  collaborationGateOperations,
  committedEventDeliveries,
  committedEventFamilyCutovers,
  committedEvents,
  taskQuestions,
  tasks,
} from '@/db/schema'
import { createCollaborationCommandContext } from '@/modules/collaboration/composition/commandContext'
import {
  collaborationCommittedEventCodec,
  createCollaborationDurableConsumerDefinitions,
} from '@/modules/collaboration/composition/committedEvents'
import {
  COLLABORATION_COMMITTED_EVENT_TYPES,
  decodeCollaborationCommittedEvent,
} from '@/modules/collaboration/domain/collaborationCommittedEvent'
import {
  appendHumanGateOpenedCommittedEvent,
  appendReviewSelectionChangedCommittedEvent,
} from '@/modules/collaboration/infrastructure/collaborationCommittedEvents'
import { createManualQuestionOpen } from '@/modules/collaboration/public/commands'
import { createAfterCommitEventPump } from '@/platform/events/committed/afterCommitEventPump'
import { createCommittedEventDeliveryPersistence } from '@/platform/events/committed/deliveryPersistence'
import {
  assertCommittedEventRegistry,
  combineCommittedEventCodecRegistries,
  createCommittedEventDispatcher,
} from '@/platform/events/committed/dispatcherWorker'
import {
  createCommittedEventProjectionLedger,
  type CommittedEventConsumerDefinition,
  type CommittedEventEnvelopeV1,
  type CommittedEventRef,
} from '@/platform/events/committed/types'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = 1_788_001_734_000

async function dispatchCollaboration(db: ProviderNeutralDatabase): Promise<void> {
  await db
    .update(committedEventFamilyCutovers)
    .set({ mode: 'dispatchable', epoch: 2, changedAt: NOW, changeRef: 'rfc341-test' })
    .where(
      and(
        eq(committedEventFamilyCutovers.producer, 'collaboration'),
        eq(committedEventFamilyCutovers.epoch, 1),
      ),
    )
    .run()
}

function reviewEnvelope(): CommittedEventEnvelopeV1 {
  return {
    eventId: 'event-review-open',
    eventGroupId: 'group-review-open',
    eventGroupOrdinal: 0,
    type: 'collaboration.human-gate-opened.v1',
    schemaVersion: 1,
    producer: 'collaboration',
    family: 'review',
    aggregate: { kind: 'review-round', id: 'review-run-1', seq: 1 },
    operationRef: 'operation-review-open',
    correlationRef: null,
    causationRef: null,
    occurredAt: new Date(NOW).toISOString(),
    payload: {
      gate: {
        taskId: 'task-review',
        nodeRunId: 'review-run-1',
        gateKind: 'review',
        gateId: 'review:review-run-1',
        roundId: 'review-run-1',
      },
      gateStatus: 'open',
      projectionFrames: [],
    },
  }
}

async function appendReviewOpen(input: {
  db: ProviderNeutralDatabase
  operationRef: string
  ordinal?: number
}): Promise<CommittedEventRef> {
  const eventRef = await databaseSessionFor(input.db).transaction((tx) =>
    appendHumanGateOpenedCommittedEvent(tx, {
      family: 'review',
      gate: {
        taskId: 'task-review',
        nodeRunId: 'review-run-1',
        gateKind: 'review',
        gateId: 'review:review-run-1',
        roundId: 'review-run-1',
      },
      occurredAt: NOW + (input.ordinal ?? 0),
      identity: {
        operationRef: input.operationRef,
        eventGroupId: `group:${input.operationRef}`,
        eventGroupOrdinal: input.ordinal ?? 0,
      },
    }),
  )
  if (eventRef === null) throw new Error('expected dispatchable review event')
  return eventRef
}

describe('RFC-341 collaboration committed-event contracts', () => {
  test('closed codec rejects wrong family, aggregate identity, unknown type and duplicate ownership', () => {
    const valid = reviewEnvelope()
    expect(decodeCollaborationCommittedEvent(valid)).toMatchObject({
      family: 'review',
      aggregate: { kind: 'review-round', id: 'review-run-1' },
    })
    expect(() =>
      decodeCollaborationCommittedEvent({
        ...valid,
        aggregate: { ...valid.aggregate, kind: 'clarify-round' },
      }),
    ).toThrow('collaboration event aggregate mismatch')
    expect(() =>
      decodeCollaborationCommittedEvent({
        ...valid,
        aggregate: { ...valid.aggregate, id: 'another-review' },
      }),
    ).toThrow('collaboration event aggregate mismatch')
    expect(() =>
      decodeCollaborationCommittedEvent({
        ...valid,
        family: 'clarify',
      }),
    ).toThrow('collaboration family mismatch')

    const combined = combineCommittedEventCodecRegistries(collaborationCommittedEventCodec)
    expect(combined.decode(valid).eventId).toBe(valid.eventId)
    expect(() => combined.decode({ ...valid, type: 'collaboration.unknown.v1' })).toThrow(
      'committed event codec type is unknown',
    )
    expect(() =>
      combineCommittedEventCodecRegistries(
        collaborationCommittedEventCodec,
        collaborationCommittedEventCodec,
      ),
    ).toThrow('committed event codec type has multiple owners')
  })

  test('consumer registry has durable coverage for the complete collaboration union', () => {
    const definitions = createCollaborationDurableConsumerDefinitions({
      events: {
        async observe(input) {
          return { eventId: input.dedupeKey, duplicate: false, deliveryCount: 0, deliveryIds: [] }
        },
      },
      nudgeContinuation() {},
      enqueueReviewDistill() {},
    })
    assertCommittedEventRegistry({
      codecs: collaborationCommittedEventCodec,
      consumers: definitions,
    })
    expect(new Set(definitions.flatMap((definition) => definition.eventTypes))).toEqual(
      new Set(COLLABORATION_COMMITTED_EVENT_TYPES),
    )
  })
})

describeEachProvider('RFC-341 collaboration committed-event contracts', (harness) => {
  test('domain write, operation and event all roll back when event insertion fails', async () => {
    const db = harness.db
    try {
      await dispatchCollaboration(db)
      await db
        .insert(tasks)
        .values({
          id: 'task-question-rollback',
          name: 'task-question-rollback',
          workflowId: 'workflow-question-rollback',
          workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
          repoPath: '/tmp/rfc341',
          worktreePath: '/tmp/rfc341',
          baseBranch: 'main',
          branch: 'agent-workflow/task-question-rollback',
          status: 'running',
          inputs: '{}',
          startedAt: NOW,
          executionLineageId: 'task-question-rollback',
          lineageSlotPathJson:
            '[{"stableNodeKey":"task-root","frozenOccurrenceKey":"task-question-rollback","workflowRevision":null}]',
        })
        .run()
      if (harness.capabilities.isolation === 'exclusive') {
        await harness.executeFixtureDdl(`
      CREATE TRIGGER rfc341_fail_collaboration_event
      BEFORE INSERT ON committed_events
      BEGIN SELECT RAISE(ABORT, 'rfc341-collaboration-event-fault'); END
    `)
      } else {
        await harness.executeFixtureDdl(`
        CREATE FUNCTION "agent_workflow"."rfc341_fail_collaboration_event_fn"() RETURNS trigger
        LANGUAGE plpgsql AS $rfc341_fault$
        BEGIN
          RAISE EXCEPTION USING MESSAGE = 'rfc341-collaboration-event-fault', ERRCODE = 'P0001';
        END;
        $rfc341_fault$;
      `)
        await harness.executeFixtureDdl(`
        CREATE TRIGGER rfc341_fail_collaboration_event
        BEFORE INSERT ON "agent_workflow"."committed_events"
        FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."rfc341_fail_collaboration_event_fn"();
      `)
      }

      await expect(
        createManualQuestionOpen(createCollaborationCommandContext({ db }), {
          taskId: 'task-question-rollback',
          title: 'Question',
          body: 'Investigate the failed append.',
          targetNodeId: 'designer',
          actorUserId: 'user-rfc341',
          now: NOW + 1,
        }),
      ).rejects.toThrow()
      expect(await db.select().from(taskQuestions).all()).toEqual([])
      expect(await db.select().from(collaborationGateOperations).all()).toEqual([])
      expect(await db.select().from(committedEvents).all()).toEqual([])
    } finally {
      if (harness.capabilities.isolation !== 'exclusive') {
        await harness.executeFixtureDdl(
          'DROP TRIGGER IF EXISTS "rfc341_fail_collaboration_event" ON "agent_workflow"."committed_events"',
        )
        await harness.executeFixtureDdl(
          'DROP FUNCTION IF EXISTS "agent_workflow"."rfc341_fail_collaboration_event_fn"()',
        )
      }
    }
  })

  test('immediate pump orders a group, dedupes it, and dispatcher recovers an unpumped event', async () => {
    const db = harness.db
    await dispatchCollaboration(db)
    const first = await appendReviewOpen({ db, operationRef: 'review-group', ordinal: 0 })
    const second = await harness.session.transaction(async (tx) => {
      const eventRef = await appendReviewSelectionChangedCommittedEvent(tx, {
        gate: {
          taskId: 'task-review',
          nodeRunId: 'review-run-1',
          gateKind: 'review',
          gateId: 'review:review-run-1',
          roundId: 'review-run-1',
        },
        occurredAt: NOW + 1,
        projectionFrames: [
          {
            id: -1,
            type: 'review.selection_changed',
            nodeRunId: 'review-run-1',
            docVersionId: 'document-1',
            selection: 'accepted',
          },
        ],
        identity: {
          operationRef: 'review-group',
          eventGroupId: 'group:review-group',
          eventGroupOrdinal: 1,
        },
      })
      if (eventRef === null) throw new Error('expected dispatchable selection event')
      return eventRef
    })
    const projected: string[] = []
    let dispatcherNudges = 0
    let continuationNudges = 0
    const projector: CommittedEventConsumerDefinition = {
      id: 'collaboration-test-projector',
      eventTypes: COLLABORATION_COMMITTED_EVENT_TYPES,
      deliveryClass: 'ephemeral',
      settle: 'projection-attempted',
      handle(event) {
        projected.push(`${event.eventGroupOrdinal}:${event.type}`)
      },
    }
    const projectionLedger = createCommittedEventProjectionLedger()
    const legacyContinuationWake = {
      nudgeContinuation() {
        continuationNudges += 1
      },
    }
    const pump = createAfterCommitEventPump({
      persistence: createCommittedEventDeliveryPersistence(db),
      codecs: collaborationCommittedEventCodec,
      projectors: [projector],
      projectionLedger,
      nudgeDispatcher() {
        dispatcherNudges += 1
      },
      // A committed event may carry this legacy-shaped extra property at runtime. The pump must
      // ignore it: only the exact durable human-gate decision consumer owns continuation wakes.
      ...legacyContinuationWake,
    })
    await pump.publishNow([second, first])
    await pump.publishNow([first, second])
    expect(projected).toEqual([
      '0:collaboration.human-gate-opened.v1',
      '1:collaboration.review-selection-changed.v1',
    ])
    expect(dispatcherNudges).toBe(2)
    expect(continuationNudges).toBe(0)

    const durable = createCollaborationDurableConsumerDefinitions({
      events: {
        async observe(input) {
          return { eventId: input.dedupeKey, duplicate: false, deliveryCount: 0, deliveryIds: [] }
        },
      },
      nudgeContinuation() {
        continuationNudges += 1
      },
      enqueueReviewDistill() {},
    })
    const continuationConsumer = durable.find(
      (definition) => definition.id === 'collaboration-continuation-nudge',
    )
    if (continuationConsumer === undefined) {
      throw new Error('expected collaboration continuation consumer')
    }
    expect(continuationConsumer.eventTypes).toEqual([
      'collaboration.human-gate-decision-committed.v1',
    ])
    continuationConsumer.handle({
      ...reviewEnvelope(),
      eventId: 'event-review-decision',
      type: 'collaboration.human-gate-decision-committed.v1',
      payload: {
        gate: {
          taskId: 'task-review',
          nodeRunId: 'review-run-1',
          gateKind: 'review',
          gateId: 'review:review-run-1',
          roundId: 'review-run-1',
        },
        decision: { gateKind: 'review', kind: 'approved' },
        gateStatus: 'committed',
        continuationRef: 'intent-review',
        distillSourceEventId: null,
        projectionFrames: [],
      },
    })
    expect(continuationNudges).toBe(1)

    const dispatcher = createCommittedEventDispatcher({
      persistence: createCommittedEventDeliveryPersistence(db),
      workerId: 'rfc341-dispatcher',
      codecs: collaborationCommittedEventCodec,
      consumers: [...durable, projector],
      projectionLedger,
      now: () => NOW + 100,
    })
    await dispatcher.drain(32)
    expect(projected).toHaveLength(2)

    await appendReviewOpen({ db, operationRef: 'review-unpumped' })
    await dispatcher.drain(32)
    expect(projected.at(-1)).toBe('0:collaboration.human-gate-opened.v1')
    expect(projected).toHaveLength(3)
    expect(
      (
        await db
          .select()
          .from(committedEventDeliveries)
          .where(eq(committedEventDeliveries.state, 'accepted'))
          .all()
      ).length,
    ).toBeGreaterThan(0)
  })
})
