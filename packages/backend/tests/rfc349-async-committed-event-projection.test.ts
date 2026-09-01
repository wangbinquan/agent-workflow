import { describe, expect, test } from 'bun:test'

import { createAfterCommitEventPump } from '@/platform/events/committed/afterCommitEventPump'
import type { CommittedEventDeliveryPersistencePort } from '@/platform/events/committed/persistence'
import type {
  CommittedEventConsumerDefinition,
  CommittedEventEnvelopeV1,
  CommittedEventRef,
  StoredCommittedEvent,
} from '@/platform/events/committed/types'

function envelope(id: string, ordinal: number): CommittedEventEnvelopeV1 {
  return {
    eventId: id,
    eventGroupId: 'group:async-projection',
    eventGroupOrdinal: ordinal,
    type: 'fixture.async.v1',
    schemaVersion: 1,
    producer: 'collaboration',
    family: 'review',
    aggregate: { kind: 'review-round', id: 'review:fixture', seq: ordinal + 1 },
    operationRef: `operation:${id}`,
    correlationRef: null,
    causationRef: null,
    occurredAt: '2026-08-31T00:00:00.000Z',
    payload: { id },
  }
}

function stored(event: CommittedEventEnvelopeV1): StoredCommittedEvent {
  return {
    envelope: event,
    payloadJson: JSON.stringify(event.payload),
    payloadDigest: `sha256:${event.eventId}`,
    deliveryMode: 'dispatchable',
    producerEpoch: 1,
    createdAt: 1,
  }
}

function ref(event: StoredCommittedEvent): CommittedEventRef {
  return {
    eventId: event.envelope.eventId,
    payloadDigest: event.payloadDigest,
    producer: event.envelope.producer,
    family: event.envelope.family,
    aggregate: event.envelope.aggregate,
    eventGroupId: event.envelope.eventGroupId,
    eventGroupOrdinal: event.envelope.eventGroupOrdinal,
    deliveryMode: 'dispatchable',
    producerEpoch: 1,
  }
}

describe('RFC-349 async committed-event projection', () => {
  test('awaits provider-backed projectors in event order and serializes overlapping publishes', async () => {
    const first = stored(envelope('event:first', 0))
    const second = stored(envelope('event:second', 1))
    const byId = new Map([
      [first.envelope.eventId, first],
      [second.envelope.eventId, second],
    ])
    const order: string[] = []
    let nudges = 0
    const persistence: CommittedEventDeliveryPersistencePort = {
      async getStored(ids: readonly string[]) {
        return ids
          .map((id) => byId.get(id))
          .filter((event): event is StoredCommittedEvent => event !== undefined)
      },
      async claimNext() {
        return null
      },
      async accept() {
        throw new Error('accept is outside this projection fixture')
      },
      async reject() {
        throw new Error('reject is outside this projection fixture')
      },
      async retry() {
        throw new Error('retry is outside this projection fixture')
      },
      async deliveryPage() {
        throw new Error('deliveryPage is outside this projection fixture')
      },
      async health() {
        throw new Error('health is outside this projection fixture')
      },
    }
    const projector: CommittedEventConsumerDefinition = {
      id: 'async-provider-projector',
      eventTypes: ['fixture.async.v1'],
      deliveryClass: 'ephemeral',
      settle: 'projection-attempted',
      async handle(event) {
        order.push(`start:${event.eventId}`)
        await Bun.sleep(event.eventId === 'event:first' ? 10 : 0)
        order.push(`end:${event.eventId}`)
      },
    }
    const pump = createAfterCommitEventPump({
      persistence,
      codecs: {
        eventTypes: ['fixture.async.v1'],
        decode(value) {
          return value as CommittedEventEnvelopeV1
        },
      },
      projectors: [projector],
      nudgeDispatcher() {
        nudges += 1
      },
    })

    await Promise.all([pump.publishNow([ref(first)]), pump.publishNow([ref(second)])])

    expect(order).toEqual([
      'start:event:first',
      'end:event:first',
      'start:event:second',
      'end:event:second',
    ])
    expect(nudges).toBe(2)
  })
})
