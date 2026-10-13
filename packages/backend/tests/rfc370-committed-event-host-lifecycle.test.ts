import { expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import {
  committedEventDeliveries,
  committedEventFamilyCutovers,
  committedEvents,
} from '@/db/schema'
import { appendCommittedEvent } from '@/platform/events/committed/append'
import { createCommittedEventDeliveryPersistence } from '@/platform/events/committed/deliveryPersistence'
import { createAuthorityCommittedEventDispatcher } from '@/platform/events/committed/dispatcherWorker'
import { createAuthorityCommittedEventDispatcherWorkerDefinition } from '@/platform/events/committed/workerDefinitions'
import {
  committedEventGroupId,
  type CommittedEventConsumerDefinition,
  type CommittedEventEnvelopeV1,
} from '@/platform/events/committed/types'
import { bindCommittedEventHostOwner } from '../src/cli/daemonHostExecutionOwners'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const NOW = 1_789_488_100_000
function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function grant(provider: ProviderHarness['applicationBinding']['provider']) {
  let active = true
  const context = {
    generation: 'committed-host-generation',
    reference: Object.freeze({}),
    current() {
      expect(this).toBe(context)
      return active
    },
  }
  return {
    context,
    scope: { provider, generationId: context.generation, operationId: 'committed-host' },
    lose() {
      active = false
    },
  }
}

async function seed(harness: ProviderHarness) {
  await harness.db
    .update(committedEventFamilyCutovers)
    .set({
      mode: 'dispatchable',
      epoch: 7,
      changedAt: NOW,
      changeRef: 'test:rfc370-host',
    })
    .where(
      and(
        eq(committedEventFamilyCutovers.producer, 'collaboration'),
        eq(committedEventFamilyCutovers.family, 'review'),
      ),
    )
    .run()
  const receipt = await harness.session.transaction((tx) =>
    appendCommittedEvent(tx, {
      producer: 'collaboration',
      family: 'review',
      type: 'host.fixture.v1',
      aggregate: { kind: 'review-round', id: 'host-review' },
      eventId: 'host-event',
      eventGroupId: committedEventGroupId('collaboration', 'host-operation'),
      eventGroupOrdinal: 0,
      operationRef: 'host-operation',
      occurredAt: NOW,
      payload: { id: 'original-content' },
      consumers: [{ id: 'host-consumer', deliveryClass: 'critical' }],
    }),
  )
  if (receipt.eventRef === null) throw new Error('fixture event was not appended')
  return createCommittedEventDeliveryPersistence(harness.db)
}

function dispatcher(
  persistence: ReturnType<typeof createCommittedEventDeliveryPersistence>,
  handle: CommittedEventConsumerDefinition['handle'],
  projectors: readonly CommittedEventConsumerDefinition[] = [],
) {
  return createAuthorityCommittedEventDispatcher({
    persistence,
    workerId: 'host-event-worker',
    now: () => NOW,
    maxAttempts: () => 1,
    codecs: {
      eventTypes: ['host.fixture.v1'],
      // The fixture owns this one closed event type. The real append/read path
      // supplies its canonical envelope and digest; decoding is not under test.
      decode(envelope) {
        return envelope as CommittedEventEnvelopeV1
      },
    },
    consumers: [
      {
        id: 'host-consumer',
        eventTypes: ['host.fixture.v1'],
        deliveryClass: 'critical',
        settle: 'delivery-accepted',
        handle,
      },
      ...projectors,
    ],
  })
}

describeEachProvider('RFC-370 committed event host lifecycle', (harness) => {
  test('loss after a real claim returns it without spending retry budget; issued consumer settles before drain', async () => {
    const persistence = await seed(harness),
      first = grant(harness.applicationBinding.provider)
    const originalEvents = await harness.db.select().from(committedEvents).all()
    const claimed = deferred(),
      claimRelease = deferred(),
      entered = deferred(),
      consumerRelease = deferred()
    const deliveries: string[] = []
    const claimNext = persistence.claimNext.bind(persistence)
    persistence.claimNext = async (input) => {
      const claim = await claimNext(input)
      claimed.resolve()
      await claimRelease.promise
      return claim
    }
    const runtime = dispatcher(persistence, async (event) => {
      deliveries.push(event.eventId)
      entered.resolve()
      await consumerRelease.promise
    })
    const definition = createAuthorityCommittedEventDispatcherWorkerDefinition({
      persistence,
      dispatcher: runtime,
    }).definition
    const owner = bindCommittedEventHostOwner(definition),
      handle = await owner.start(first)
    await claimed.promise
    first.lose()
    await owner.quiesceAuthorityLoss({ context: first.context, handle })
    let drained = false
    const draining = Promise.resolve(
      owner.drainAuthorityLoss({ context: first.context, handle }),
    ).then(() => {
      drained = true
    })
    await expect(owner.start(grant(harness.applicationBinding.provider))).rejects.toThrow(
      'prior-lifetime-not-drained',
    )
    expect(drained).toBe(false)
    claimRelease.resolve()
    await draining
    expect(deliveries).toEqual([])
    const pending = await harness.db.select().from(committedEventDeliveries).all()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      eventId: 'host-event',
      state: 'pending',
      attemptCount: 0,
      leaseEpoch: 1,
      claimedBy: null,
      claimExpiresAt: null,
      lastErrorCode: null,
    })
    expect(await harness.db.select().from(committedEvents).all()).toEqual(originalEvents)
    const second = grant(harness.applicationBinding.provider),
      next = await owner.start(second)
    await entered.promise
    second.lose()
    await owner.quiesceAuthorityLoss({ context: second.context, handle: next })
    let secondDrained = false
    const nextDrain = Promise.resolve(
      owner.drainAuthorityLoss({ context: second.context, handle: next }),
    ).then(() => {
      secondDrained = true
    })
    await Promise.resolve()
    expect(secondDrained).toBe(false)
    expect(deliveries).toEqual(['host-event'])
    consumerRelease.resolve()
    await nextDrain
    expect((await harness.db.select().from(committedEventDeliveries).all())[0]).toMatchObject({
      state: 'accepted',
      attemptCount: 1,
      leaseEpoch: 2,
      claimedBy: null,
      lastErrorCode: null,
    })
  })

  test('an issued projection finishes after loss while the durable consumer remains pending', async () => {
    const persistence = await seed(harness),
      lifetime = grant(harness.applicationBinding.provider)
    const entered = deferred(),
      release = deferred(),
      projected: string[] = [],
      delivered: string[] = []
    const runtime = dispatcher(
      persistence,
      async (event) => {
        delivered.push(event.eventId)
      },
      [
        {
          id: 'host-projector',
          deliveryClass: 'ephemeral',
          settle: 'projection-attempted',
          eventTypes: ['host.fixture.v1'],
          async handle(event) {
            projected.push(event.eventId)
            entered.resolve()
            await release.promise
          },
        },
      ],
    )
    const original = runtime.runOne(lifetime.context)
    await entered.promise
    lifetime.lose()
    release.resolve()
    expect(await original).toBe('idle')
    expect(projected).toEqual(['host-event'])
    expect(delivered).toEqual([])
    expect((await harness.db.select().from(committedEventDeliveries).all())[0]).toMatchObject({
      state: 'pending',
      attemptCount: 0,
    })
    expect(await runtime.runOne(grant(harness.applicationBinding.provider).context)).toBe(
      'completed',
    )
    expect(projected).toEqual(['host-event'])
    expect(delivered).toEqual(['host-event'])
  })

  test('a consumer error after loss keeps the original rejection and retry budget', async () => {
    const persistence = await seed(harness),
      lifetime = grant(harness.applicationBinding.provider)
    const entered = deferred(),
      failure = deferred(),
      originalFailure = new Error('real consumer failure')
    const runtime = dispatcher(persistence, async () => {
      entered.resolve()
      await failure.promise
    })
    const result = runtime.runOne(lifetime.context)
    await entered.promise
    lifetime.lose()
    failure.reject(originalFailure)
    expect(await result).toBe('dead-letter')
    expect((await harness.db.select().from(committedEventDeliveries).all())[0]).toMatchObject({
      state: 'dead-letter',
      attemptCount: 1,
      lastErrorSummary: originalFailure.message,
    })
  })

  test('unissued ACK participates in the original transaction and cannot release a newer claim', async () => {
    const persistence = await seed(harness)
    const claim = await persistence.claimNext({ workerId: 'first-owner', now: NOW })
    if (claim === null) throw new Error('fixture claim missing')
    const before = await harness.db.select().from(committedEventDeliveries).all()
    await expect(
      harness.session.transaction(async () => {
        await persistence.deferUnissued({ claim, now: NOW + 1 })
        throw new Error('rollback-unissued-ack')
      }),
    ).rejects.toThrow('rollback-unissued-ack')
    expect(await harness.db.select().from(committedEventDeliveries).all()).toEqual(before)
    await persistence.deferUnissued({ claim, now: NOW + 1 })
    const deferredRows = await harness.db.select().from(committedEventDeliveries).all()
    await persistence.deferUnissued({ claim, now: NOW + 2 })
    expect(await harness.db.select().from(committedEventDeliveries).all()).toEqual(deferredRows)
    const next = await persistence.claimNext({ workerId: 'next-owner', now: NOW + 2 })
    if (next === null) throw new Error('fixture second claim missing')
    await expect(persistence.deferUnissued({ claim, now: NOW + 3 })).rejects.toThrow('lease lost')
    expect((await harness.db.select().from(committedEventDeliveries).all())[0]).toMatchObject({
      state: 'claimed',
      claimedBy: 'next-owner',
      leaseEpoch: next.leaseEpoch,
      attemptCount: 1,
    })
    await persistence.accept({ claim: next, now: NOW + 3 })
  })
})
