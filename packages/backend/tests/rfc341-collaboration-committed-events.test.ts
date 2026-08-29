import { describe, expect, test } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'

import { createInMemoryDb, type DbClient } from '@/db/client'
import {
  collaborationGateOperations,
  committedEventDeliveries,
  committedEventFamilyCutovers,
  committedEvents,
  taskQuestions,
  tasks,
} from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
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
  appendHumanGateOpenedCommittedEventTx,
  appendReviewSelectionChangedCommittedEventTx,
} from '@/modules/collaboration/infrastructure/collaborationCommittedEventParticipant'
import { createManualQuestionOpen } from '@/modules/collaboration/public/commands'
import { createAfterCommitEventPump } from '@/platform/events/committed/afterCommitEventPump'
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
import { MIGRATIONS } from './migration-freeze'

const NOW = 1_788_001_734_000

function dispatchCollaboration(db: DbClient): void {
  db.update(committedEventFamilyCutovers)
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

function appendReviewOpen(input: {
  db: DbClient
  operationRef: string
  ordinal?: number
}): CommittedEventRef {
  const eventRef = dbTxSync(input.db, (tx) =>
    appendHumanGateOpenedCommittedEventTx(tx, {
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
        observe(input) {
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

  test('domain write, operation and event all roll back when event insertion fails', () => {
    const db = createInMemoryDb(MIGRATIONS)
    dispatchCollaboration(db)
    db.insert(tasks)
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
      })
      .run()
    db.run(sql`
      CREATE TRIGGER rfc341_fail_collaboration_event
      BEFORE INSERT ON committed_events
      BEGIN SELECT RAISE(ABORT, 'rfc341-collaboration-event-fault'); END
    `)

    expect(() =>
      createManualQuestionOpen(createCollaborationCommandContext({ db }), {
        taskId: 'task-question-rollback',
        title: 'Question',
        body: 'Investigate the failed append.',
        targetNodeId: 'designer',
        actorUserId: 'user-rfc341',
        now: NOW + 1,
      }),
    ).toThrow()
    expect(db.select().from(taskQuestions).all()).toEqual([])
    expect(db.select().from(collaborationGateOperations).all()).toEqual([])
    expect(db.select().from(committedEvents).all()).toEqual([])
  })

  test('immediate pump orders a group, dedupes it, and dispatcher recovers an unpumped event', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    dispatchCollaboration(db)
    const first = appendReviewOpen({ db, operationRef: 'review-group', ordinal: 0 })
    const second = dbTxSync(db, (tx) => {
      const eventRef = appendReviewSelectionChangedCommittedEventTx(tx, {
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
    let nudges = 0
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
    const pump = createAfterCommitEventPump({
      db,
      codecs: collaborationCommittedEventCodec,
      projectors: [projector],
      projectionLedger,
      nudgeDispatcher() {
        nudges += 1
      },
    })
    pump.publishNow([second, first])
    pump.publishNow([first, second])
    expect(projected).toEqual([
      '0:collaboration.human-gate-opened.v1',
      '1:collaboration.review-selection-changed.v1',
    ])
    expect(nudges).toBe(2)

    const durable = createCollaborationDurableConsumerDefinitions({
      events: {
        observe(input) {
          return { eventId: input.dedupeKey, duplicate: false, deliveryCount: 0, deliveryIds: [] }
        },
      },
      nudgeContinuation() {},
      enqueueReviewDistill() {},
    })
    const dispatcher = createCommittedEventDispatcher({
      db,
      workerId: 'rfc341-dispatcher',
      codecs: collaborationCommittedEventCodec,
      consumers: [...durable, projector],
      projectionLedger,
      now: () => NOW + 100,
    })
    await dispatcher.drain(32)
    expect(projected).toHaveLength(2)

    appendReviewOpen({ db, operationRef: 'review-unpumped' })
    await dispatcher.drain(32)
    expect(projected.at(-1)).toBe('0:collaboration.human-gate-opened.v1')
    expect(projected).toHaveLength(3)
    expect(
      db
        .select()
        .from(committedEventDeliveries)
        .where(eq(committedEventDeliveries.state, 'accepted'))
        .all().length,
    ).toBeGreaterThan(0)
  })
})
