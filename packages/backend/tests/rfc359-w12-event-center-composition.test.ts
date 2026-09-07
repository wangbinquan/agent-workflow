// Both production factories own the database used by every step below. Passive
// task facts need no observer, delivery consumer, or WorkStart implementation.
import { expect, test } from 'bun:test'
import { asc, eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { eventRecords, eventTypeCatalog } from '@/db/schema'
import {
  composeEventCenter,
  composePostgresqlEventCenter,
} from '@/modules/event-center/composition'
import {
  TASK_LIFECYCLE_SOURCE_REF,
  TASK_STATUS_CHANGED_EVENT_REF,
  taskLifecycleEventCatalogJson,
  taskLifecycleObservation,
} from '@/modules/task-execution/public/events'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const subject = { typeId: 'platform.task', subjectRef: 'composition-task' }
const firstSubscriber = { kind: 'system' as const, subscriberRef: 'first-consumer' }
const secondSubscriber = { kind: 'system' as const, subscriberRef: 'second-consumer' }

async function compose(harness: ProviderHarness) {
  const options = { typePackageDescriptorJsons: [taskLifecycleEventCatalogJson] }
  return harness.capabilities.isolation === 'exclusive'
    ? await composeEventCenter({ ...options, db: harness.db as DbClient })
    : await composePostgresqlEventCenter({
        ...options,
        db: harness.db as PostgresqlDatabaseClient,
      })
}

function observation(revision = 1) {
  return taskLifecycleObservation({
    taskId: subject.subjectRef,
    revision,
    previousStatus: revision === 1 ? 'pending' : 'running',
    status: revision === 1 ? 'running' : 'done',
    occurredAt: 1_788_800_000_000 + revision,
  })
}

describeEachProvider('RFC-359 W12 Event Center complete composition', (harness) => {
  test('real catalog registration remains stable across complete recomposition', async () => {
    const first = await compose(harness)
    const catalog = JSON.parse(await first.queries.catalog.catalogJson()) as {
      sources: Array<{ sourceRef: { id: string; revision: number } }>
      eventTypes: Array<{ eventTypeRef: { id: string; revision: number } }>
    }
    expect(catalog.sources.map((source) => source.sourceRef)).toContainEqual(
      TASK_LIFECYCLE_SOURCE_REF,
    )
    expect(catalog.eventTypes.map((event) => event.eventTypeRef)).toContainEqual(
      TASK_STATUS_CHANGED_EVENT_REF,
    )
    const registered = await harness.db
      .select()
      .from(eventTypeCatalog)
      .orderBy(asc(eventTypeCatalog.eventTypeId), asc(eventTypeCatalog.revision))
    expect(registered.length).toBeGreaterThan(0)

    const second = await compose(harness)
    expect(JSON.parse(await second.queries.catalog.catalogJson())).toEqual(catalog)
    expect(
      await harness.db
        .select()
        .from(eventTypeCatalog)
        .orderBy(asc(eventTypeCatalog.eventTypeId), asc(eventTypeCatalog.revision)),
    ).toEqual(registered)
    expect(await second.worker.runOneDueObserver()).toBe('idle')
    expect(await second.worker.runOneNotification()).toBe('idle')
  })

  test('duplicate observations persist one fact and independent deliveries survive recomposition', async () => {
    const first = await compose(harness)
    const subscription = {
      eventTypeRef: TASK_STATUS_CHANGED_EVENT_REF,
      subject,
      subscriber: firstSubscriber,
    }
    const firstSubscription = await first.participant.subscribe(subscription)
    expect(firstSubscription.created).toBe(true)
    expect(await first.participant.subscribe(subscription)).toEqual({
      ...firstSubscription,
      created: false,
      observerTransition: 'none',
    })
    await first.participant.subscribe({ ...subscription, subscriber: secondSubscriber })

    const accepted = await first.commands.observe(observation())
    const duplicate = await first.participant.observe(observation())
    expect(accepted.duplicate).toBe(false)
    expect(duplicate.duplicate).toBe(true)
    const firstPending = await first.participant.pendingDeliveries(firstSubscriber, 10)
    const secondPending = await first.participant.pendingDeliveries(secondSubscriber, 10)
    expect(firstPending).toHaveLength(1)
    expect(secondPending).toHaveLength(1)
    const firstDelivery = firstPending[0]
    const secondDelivery = secondPending[0]
    if (firstDelivery === undefined || secondDelivery === undefined)
      throw new Error('missing durable delivery')
    expect(firstDelivery.eventId).toBe(secondDelivery.eventId)
    expect(firstDelivery.deliveryId).not.toBe(secondDelivery.deliveryId)
    expect(firstDelivery).toMatchObject({
      eventTypeRef: TASK_STATUS_CHANGED_EVENT_REF,
      sourceRef: TASK_LIFECYCLE_SOURCE_REF,
      subject,
      deliveryClass: 'platform.task-status',
    })
    const records = await harness.db.select().from(eventRecords)
    expect(records).toHaveLength(1)
    const record = records[0]
    if (record === undefined) throw new Error('missing durable event')
    expect(record.id).toBe(firstDelivery.eventId)
    expect(JSON.parse(record.summaryJson)).toMatchObject({
      triggerContext: {
        contract: { namespace: 'task' },
        trigger: {
          task: {
            task_id: subject.subjectRef,
            status: 'running',
            previous_status: 'pending',
            revision: '1',
          },
        },
      },
    })

    await first.participant.acceptDelivery(firstDelivery.deliveryId)
    const restarted = await compose(harness)
    expect(await restarted.participant.pendingDeliveries(firstSubscriber, 10)).toEqual([])
    expect(await restarted.participant.pendingDeliveries(secondSubscriber, 10)).toEqual(
      secondPending,
    )
    expect((await restarted.commands.observe(observation())).duplicate).toBe(true)
    expect(await restarted.participant.pendingDeliveries(firstSubscriber, 10)).toEqual([])
    const page = await restarted.queries.operations.eventRecordPage({
      page: 1,
      limit: 20,
      sourceId: TASK_LIFECYCLE_SOURCE_REF.id,
    })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.eventId).toBe(firstDelivery.eventId)
    await restarted.participant.acceptDelivery(secondDelivery.deliveryId)
    expect(await restarted.participant.pendingDeliveries(secondSubscriber, 10)).toEqual([])
  })

  test('late replay, fresh-only subscriptions, and unsubscribe use persisted facts after restart', async () => {
    const first = await compose(harness)
    await first.commands.observe(observation())
    const restarted = await compose(harness)
    const subscription = { eventTypeRef: TASK_STATUS_CHANGED_EVENT_REF, subject }
    const replay = await restarted.participant.subscribe({
      ...subscription,
      subscriber: firstSubscriber,
    })
    await restarted.participant.subscribe({
      ...subscription,
      subscriber: secondSubscriber,
      replayLatest: false,
    })
    expect(await restarted.participant.pendingDeliveries(firstSubscriber, 10)).toHaveLength(1)
    expect(await restarted.participant.pendingDeliveries(secondSubscriber, 10)).toEqual([])
    const replayed = (await restarted.participant.pendingDeliveries(firstSubscriber, 10))[0]
    if (replayed === undefined) throw new Error('missing replay delivery')
    await restarted.participant.acceptDelivery(replayed.deliveryId)
    await restarted.participant.unsubscribe(replay.subscriptionId)
    await restarted.commands.observe(observation(2))
    const final = await compose(harness)
    expect(await final.participant.pendingDeliveries(firstSubscriber, 10)).toEqual([])
    const fresh = await final.participant.pendingDeliveries(secondSubscriber, 10)
    expect(fresh).toHaveLength(1)
    expect(fresh[0]?.eventId).not.toBe(replayed.eventId)
    const latest = await harness.db
      .select()
      .from(eventRecords)
      .where(eq(eventRecords.id, fresh[0]!.eventId))
    expect(JSON.parse(latest[0]!.summaryJson)).toMatchObject({
      triggerContext: { trigger: { task: { status: 'done', revision: '2' } } },
    })
  })
})
