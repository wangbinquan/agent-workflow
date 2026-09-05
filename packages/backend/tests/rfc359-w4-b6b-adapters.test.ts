// RFC-359 W4-B6 批 b —— event-center 事件存储（1377 行的孪生对）合一，两个引擎各跑一遍：源 / 事件类型登记、订阅与
// 观察者激活、观察记录与投递、通知投递的认领 / 结算围栏、观察者的到期认领（从未扫过的排最前）与结算。

import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  eventContentDigest,
  eventTypeContentDigest,
  type EventObservation,
  type EventSourceDescriptor,
  type EventTypeDescriptor,
} from '@/modules/event-center/domain/model'
import { createEventStore } from '@/modules/event-center/infrastructure/eventStore'
import { describeEachProvider } from './helpers/eachProvider'

function fixtures(tag: string) {
  const source: EventSourceDescriptor = {
    schemaVersion: 1,
    sourceRef: { id: `fixture.source-${tag}`, revision: 1 },
    ownerTypeId: 'fixture.owner',
    displayName: { 'zh-CN': '测试源', 'en-US': 'Fixture source' },
    description: { 'zh-CN': '用于测试', 'en-US': 'Used by the dual-engine oracle' },
    observationMode: 'active',
    observerProgramRef: null,
    pollIntervalMs: 1_000,
    batchSize: 10,
  }
  const eventType: EventTypeDescriptor = {
    schemaVersion: 1,
    eventTypeRef: { id: `fixture.event-${tag}.changed`, revision: 1 },
    sourceRef: source.sourceRef,
    ownerTypeId: 'fixture.owner',
    subjectTypeId: 'fixture.subject',
    payloadSchemaId: 'fixture.payload',
    displayName: { 'zh-CN': '发生变更', 'en-US': 'Changed' },
    description: { 'zh-CN': '用于测试', 'en-US': 'Used by the dual-engine oracle' },
    deliveryClass: 'fixture.delivery',
    triggerParameters: null,
  }
  const observation: EventObservation = {
    sourceRef: source.sourceRef,
    eventTypeRef: eventType.eventTypeRef,
    subject: { typeId: 'fixture.subject', subjectRef: `subject-${tag}` },
    occurredAt: 100,
    dedupeKey: `dedupe-${tag}`,
    summary: 'fixture changed',
    payloadArtifactRef: null,
    routingFacts: null,
    triggerParameters: null,
  }
  return { source, eventType, observation }
}

describeEachProvider('RFC-359 W4-B6b —— 事件存储', (harness) => {
  test('登记 / 订阅 / 观察记录 / 投递认领与结算围栏 / 分页读模型 / 取消订阅', async () => {
    const db: ProviderNeutralDatabase = harness.db
    const store = createEventStore(db)
    const tag = ulid().toLowerCase()
    const { source, eventType, observation } = fixtures(tag)
    await store.registerSource(source, eventContentDigest(source), 1)
    await store.registerEventType(eventType, eventTypeContentDigest(eventType), 1)
    expect((await store.getSource(source.sourceRef))?.sourceRef).toEqual(source.sourceRef)
    expect(await store.getSource({ id: 'missing', revision: 1 })).toBeNull()
    expect(
      (await store.listEventTypes()).some(
        (row) => row.eventTypeRef.id === eventType.eventTypeRef.id,
      ),
    ).toBe(true)

    const subscriptionId = `sub_${tag}`
    const subscribed = await store.subscribe({
      id: subscriptionId,
      eventType,
      source,
      subject: observation.subject,
      subscriber: { kind: 'automation', subscriberRef: `automation-${tag}` },
      identityKey: `identity-${tag}`,
      replayLatest: false,
      now: 2,
    })
    expect(subscribed).toMatchObject({ created: true, observerTransition: 'started' })
    expect(subscribed.record).toMatchObject({ id: subscriptionId, state: 'active' })
    // 同一 identityKey 再订阅 ⇒ 幂等，不再启动观察者。
    const again = await store.subscribe({
      id: `sub_${ulid()}`,
      eventType,
      source,
      subject: observation.subject,
      subscriber: { kind: 'automation', subscriberRef: `automation-${tag}` },
      identityKey: `identity-${tag}`,
      replayLatest: false,
      now: 3,
    })
    expect(again).toMatchObject({ created: false, observerTransition: 'none' })
    expect(again.record.id).toBe(subscriptionId)
    expect((await store.listSubscriptions(`automation-${tag}`)).map((row) => row.id)).toEqual([
      subscriptionId,
    ])
    expect(
      await store.listSubscriptionPage({
        limit: 10,
        offset: 0,
        subscriberRef: `automation-${tag}`,
      }),
    ).toMatchObject({ total: 1 })
    const sourceKey = `${source.sourceRef.id}@${source.sourceRef.revision}`
    expect((await store.activeSubscriptionCountsBySource()).get(sourceKey)).toBe(1)

    const eventId = `event_${tag}`
    const deliveryId = `delivery_${tag}`
    const receipt = await store.recordObservation({
      eventId,
      observation,
      eventType,
      observedAt: 100,
      nextId: () => deliveryId,
      routingSubscriptions: [],
      triggerContext: null,
    })
    expect(receipt).toMatchObject({
      eventId,
      duplicate: false,
      deliveryCount: 1,
      deliveryIds: [deliveryId],
    })
    // 同一 dedupeKey 再记一次 ⇒ 判重，回原事件与它已有的投递，不再新派发。
    expect(
      await store.recordObservation({
        eventId: `event_${ulid()}`,
        observation,
        eventType,
        observedAt: 101,
        nextId: () => `delivery_${ulid()}`,
        routingSubscriptions: [],
        triggerContext: null,
      }),
    ).toMatchObject({ duplicate: true, eventId, deliveryCount: 1, deliveryIds: [deliveryId] })
    expect(
      (
        await store.listPendingDeliveries(
          { kind: 'automation', subscriberRef: `automation-${tag}` },
          10,
        )
      ).map((row) => row.deliveryId),
    ).toEqual([deliveryId])
    expect(
      await store.listEventRecordPage({ limit: 10, offset: 0, sourceId: source.sourceRef.id }),
    ).toMatchObject({ total: 1 })

    const claim = await store.claimNotificationDelivery({
      deliveryId,
      subscriberKinds: ['automation'],
      now: 101,
      leaseOwner: 'worker-1',
      leaseMs: 1_000,
    })
    expect(claim).toMatchObject({ deliveryId, attemptCount: 1 })
    // 租约未过期时别的 worker 认领不到。
    expect(
      await store.claimNotificationDelivery({
        deliveryId,
        subscriberKinds: ['automation'],
        now: 102,
        leaseOwner: 'worker-2',
        leaseMs: 1_000,
      }),
    ).toBeNull()
    // 结算围栏：attemptCount 不对 ⇒ 拒绝；对 ⇒ 接受。
    expect(
      await store.settleNotificationDelivery({
        deliveryId,
        leaseOwner: 'worker-1',
        attemptCount: 0,
        now: 103,
        state: 'accepted',
        nextAttemptAt: 103,
        error: null,
      }),
    ).toBe(false)
    expect(
      await store.settleNotificationDelivery({
        deliveryId,
        leaseOwner: 'worker-1',
        attemptCount: 1,
        now: 103,
        state: 'accepted',
        nextAttemptAt: 103,
        error: null,
      }),
    ).toBe(true)
    expect(
      await store.listDeliveryStatusPage({
        limit: 10,
        offset: 0,
        subscriberRef: `automation-${tag}`,
      }),
    ).toMatchObject({ total: 1, items: [{ state: 'accepted', attemptCount: 1 }] })

    const cancelled = await store.cancelSubscription(subscriptionId, 200)
    expect(cancelled).toMatchObject({ observerTransition: 'stopped' })
    expect(cancelled?.record.state).toBe('cancelled')
    expect(await store.cancelSubscription('missing', 201)).toBeNull()
    expect((await store.activeSubscriptionCountsBySource()).get(sourceKey) ?? 0).toBe(0)
  })

  test('观察者激活：认领到期扫描（从未扫过的排最前）、结算写游标、nudge 提前唤醒', async () => {
    const db: ProviderNeutralDatabase = harness.db
    const store = createEventStore(db)
    const tag = ulid().toLowerCase()
    const { source, eventType, observation } = fixtures(tag)
    await store.registerSource(source, eventContentDigest(source), 1)
    await store.registerEventType(eventType, eventTypeContentDigest(eventType), 1)
    await store.subscribe({
      id: `sub_${tag}`,
      eventType,
      source,
      subject: observation.subject,
      subscriber: { kind: 'automation', subscriberRef: `automation-${tag}` },
      identityKey: `identity-${tag}`,
      replayLatest: false,
      now: 2,
    })
    const activations = await store.listObserverActivations()
    const activation = activations.find((row) => row.sourceRef.id === source.sourceRef.id)
    expect(activation).toMatchObject({ subscriberCount: 1 })

    const run = await store.claimDueObserver({
      now: 10,
      leaseOwner: 'observer-1',
      leaseMs: 1_000,
      runId: `run_${tag}`,
    })
    expect(run).not.toBeNull()
    if (run === null) throw new Error('unreachable')
    expect(run.source.sourceRef).toEqual(source.sourceRef)
    expect(run.subjects.map((subject) => subject.subjectRef)).toEqual([
      observation.subject.subjectRef,
    ])
    // 已被认领的激活在租约内不会再被别的 worker 拿到。
    const second = await store.claimDueObserver({
      now: 11,
      leaseOwner: 'observer-2',
      leaseMs: 1_000,
      runId: `run_${ulid()}`,
    })
    expect(second?.source.sourceRef.id === source.sourceRef.id).toBe(false)

    expect(
      await store.settleObserver({
        run,
        now: 12,
        cursorJson: '{"page":2}',
        observations: [
          {
            eventId: `event_${tag}`,
            observation,
            eventType,
            routingSubscriptions: [],
            triggerContext: null,
          },
        ],
        nextId: () => `delivery_${tag}`,
        errorCode: null,
        errorDetail: null,
      }),
    ).toBe('completed')
    expect(
      (
        await store.listPendingDeliveries(
          { kind: 'automation', subscriberRef: `automation-${tag}` },
          10,
        )
      ).length,
    ).toBe(1)
    // 过期的 run 再结算 ⇒ obsolete。
    expect(
      await store.settleObserver({
        run,
        now: 13,
        cursorJson: null,
        observations: [],
        nextId: () => `delivery_${ulid()}`,
        errorCode: null,
        errorDetail: null,
      }),
    ).toBe('obsolete')
    expect(await store.nudgeObserver(source.sourceRef, 14)).toBe(true)
    expect(await store.nudgeObserver({ id: 'missing', revision: 1 }, 14)).toBe(false)
  })
})

test('源码锁：provider 命名的孪生实现不得复活', () => {
  const infra = resolve(import.meta.dir, '..', 'src', 'modules', 'event-center', 'infrastructure')
  for (const provider of ['sqlite', 'postgresql']) {
    expect(existsSync(resolve(infra, `${provider}EventStore.ts`))).toBe(false)
  }
})
