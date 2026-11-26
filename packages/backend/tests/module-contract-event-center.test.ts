// Module contract audit: bounded consumption and diagnostic pages describe the
// same durable deliveries through the complete provider-neutral composition.
import { expect, test } from 'bun:test'
import { composeEventCenter, standaloneEventCenterSelections } from './helpers/eventCenter'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import { taskLifecycleEventCatalogJson } from '@/modules/task-execution/public/events'
import {
  TASK_LIFECYCLE_SOURCE_REF,
  TASK_STATUS_CHANGED_EVENT_REF,
  taskLifecycleObservation,
} from '@/modules/task-execution/application/taskLifecycleEvents'

const subject = { typeId: 'platform.task', subjectRef: 'module-contract-task' }
const subscriber = { kind: 'system' as const, subscriberRef: 'module-contract-reader' }

async function moduleFor(harness: ProviderHarness) {
  return composeEventCenter({
    ...standaloneEventCenterSelections(),
    db: harness.db,
    automation: { kind: 'observation-only' },
    typePackageDescriptorJsons: [taskLifecycleEventCatalogJson],
    now: () => 1_800_000_000_000,
  })
}

function observation(revision: number) {
  return taskLifecycleObservation({
    taskId: subject.subjectRef,
    revision,
    previousStatus: revision % 2 === 1 ? 'pending' : 'running',
    status: revision % 2 === 1 ? 'running' : 'done',
    occurredAt: 1_800_000_000_000 + revision,
  })
}

describeEachProvider('module contract: event-center', (harness) => {
  test('bounded consumption drains every delivery exactly once and its pages agree after recomposition', async () => {
    const module = await moduleFor(harness)
    await module.participant.subscribe({
      eventTypeRef: TASK_STATUS_CHANGED_EVENT_REF,
      subject,
      subscriber,
    })
    for (let revision = 1; revision <= 23; revision += 1) {
      expect((await module.commands.observe(observation(revision))).duplicate).toBe(false)
    }
    const seen = new Set<string>()
    const sizes: number[] = []
    for (let batch = 0; batch < 6; batch += 1) {
      const pending = await module.participant.pendingDeliveries(subscriber, 5)
      sizes.push(pending.length)
      for (const delivery of pending) {
        expect(seen.has(delivery.deliveryId)).toBe(false)
        seen.add(delivery.deliveryId)
        expect(delivery).toMatchObject({ sourceRef: TASK_LIFECYCLE_SOURCE_REF, subject })
        await module.participant.acceptDelivery(delivery.deliveryId)
        // Receipt-loss retry is an idempotent acknowledgement, not a new delivery.
        await module.participant.acceptDelivery(delivery.deliveryId)
      }
    }
    expect(sizes).toEqual([5, 5, 5, 5, 3, 0])
    expect(seen.size).toBe(23)
    const restarted = await moduleFor(harness)
    expect(await restarted.participant.pendingDeliveries(subscriber, 5)).toEqual([])
    const accepted = await restarted.queries.operations.deliveryStatusPage({
      page: 3,
      limit: 10,
      state: 'accepted',
      subscriberRef: subscriber.subscriberRef,
    })
    expect(accepted).toMatchObject({ total: 23, page: 3, pageCount: 3 })
    expect(accepted.items).toHaveLength(3)
    expect(
      accepted.items.every((item) => item.state === 'accepted' && seen.has(item.deliveryId)),
    ).toBe(true)
    const pending = await restarted.queries.operations.deliveryStatusPage({
      page: 1,
      limit: 10,
      state: 'pending',
      subscriberRef: subscriber.subscriberRef,
    })
    expect(pending).toMatchObject({ total: 0, pageCount: 1, items: [] })
    const events = await restarted.queries.operations.eventRecordPage({
      page: 4,
      limit: 10,
      sourceId: TASK_LIFECYCLE_SOURCE_REF.id,
    })
    expect(events).toMatchObject({ total: 23, page: 4, pageCount: 3, items: [] })
  })

  test('invalid observation references fail without persisting a partial fact or delivery', async () => {
    const module = await moduleFor(harness)
    await module.participant.subscribe({
      eventTypeRef: TASK_STATUS_CHANGED_EVENT_REF,
      subject,
      subscriber,
    })
    const cases = [
      {
        input: {
          ...observation(1),
          eventTypeRef: { id: TASK_STATUS_CHANGED_EVENT_REF.id, revision: 999 },
        },
        code: 'event-type-not-found',
      },
      {
        input: {
          ...observation(1),
          sourceRef: { id: TASK_LIFECYCLE_SOURCE_REF.id, revision: 999 },
        },
        code: 'event-source-mismatch',
      },
      {
        input: { ...observation(1), subject: { ...subject, typeId: 'different-subject' } },
        code: 'event-subject-type-invalid',
      },
      { input: { ...observation(1), routingFactsJson: '{' }, code: 'event-routing-facts-invalid' },
    ]
    for (const item of cases)
      await expect(module.commands.observe(item.input)).rejects.toMatchObject({ code: item.code })
    expect(await module.participant.pendingDeliveries(subscriber, 10)).toEqual([])
    expect(
      await module.queries.operations.eventRecordPage({ page: 1, limit: 10, sourceId: null }),
    ).toMatchObject({ total: 0, items: [] })
    expect((await module.commands.observe(observation(1))).duplicate).toBe(false)
    expect(await module.participant.pendingDeliveries(subscriber, 10)).toHaveLength(1)
  })

  test('unknown delivery and passive-observer commands leave existing deliveries consumable', async () => {
    const module = await moduleFor(harness)
    await module.participant.subscribe({
      eventTypeRef: TASK_STATUS_CHANGED_EVENT_REF,
      subject,
      subscriber,
    })
    await module.commands.observe(observation(1))
    const before = await module.participant.pendingDeliveries(subscriber, 10)
    await expect(module.participant.acceptDelivery('missing-delivery')).rejects.toMatchObject({
      code: 'event-delivery-not-found',
    })
    await expect(
      module.observerControl.nudgeSource(TASK_LIFECYCLE_SOURCE_REF),
    ).rejects.toMatchObject({ code: 'event-source-not-observable' })
    expect(await module.participant.pendingDeliveries(subscriber, 10)).toEqual(before)
    expect(await module.worker.runOneDueObserver()).toBe('idle')
    await module.participant.acceptDelivery(before[0]!.deliveryId)
    expect(await module.participant.pendingDeliveries(subscriber, 10)).toEqual([])
  })
})
