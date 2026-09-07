// RFC-359 W7 —— 已提交事件出站存储（CommittedEventDeliveryPersistence）的双引擎对拍。
//
// 为什么存在
// ==========
// 这一对是 `rfc359-w5-provider-pair-conformance.test.ts` 账本里 26 对中**行数差最大**的一对：
// SQLite 侧 `sqlitePersistence.ts`（41 行薄壳）转发给 `sqliteStore.ts`（802 行），PG 侧
// `postgresqlPersistence.ts` 只有 363 行。差额不在端口上——`sqliteStore.ts` 里 285 行是
// **append 半区**（RFC-359 已在 `append.ts` 合成一份，两个引擎共用），26 行是零调用者的死导出，
// 端口那一半两侧其实一样大。本文件把端口的七个方法写成**同一段断言**，两个引擎各跑一遍。
//
// 出站存储的命门（本文件按这四条组织）
// ------------------------------------
//   1. **append 原子性**：事件与业务写同生共死。外层事务回滚，事件必须一起消失——否则就是
//      「业务回滚了、事件却发出去了」。RFC-359 W7 在 `ClarifyDirectiveStore` 上实撞过这个形态：
//      PG 那侧用裸 `db.transaction`，外层回滚带不走它的写。本文件对**端口自身的写**（accept /
//      reject / retry）也压同一条判据。
//   2. **投递一次性 / 重放**：认领 → 结算 → 不再被认领；崩溃（租约过期）后可重放；
//      dead-letter 只能由人工 retry 以 CAS 复活。
//   3. **顺序**：同一聚合内 seq 严格顺序交付（前一条未 accepted 时后一条不可认领）；
//      跨聚合按 createdAt / eventGroupOrdinal / consumerId 的确定水位。
//   4. **并发领取**：两个 worker 同时认领同一批时互斥，同一 (eventId, consumerId) 不会被认领两次。
//
// 变异验证（2026-09-07 实测，见 RFC-359 W7 报告）：把 append 原子性与投递一次性各改坏一次，
// 本文件都变红；还原后复绿。

import { expect, test } from 'bun:test'
import { and, asc, eq } from 'drizzle-orm'

import { canonicalJson } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  committedEventAggregateHeads,
  committedEventDeliveries,
  committedEventFamilyCutovers,
  committedEvents,
} from '@/db/schema'
import { appendCommittedEvent } from '@/platform/events/committed/append'
import { createCommittedEventDeliveryPersistence } from '@/platform/events/committed/deliveryPersistence'
import type {
  CommittedEventDeliveryPersistencePort,
  CommittedEventDeliveryHealth,
} from '@/platform/events/committed/persistence'
import type {
  AppendCommittedEventInput,
  ClaimedCommittedEventDelivery,
  CommittedEventDeliveryClass,
  CommittedEventDeliveryState,
  CommittedEventEnvelopeV1,
} from '@/platform/events/committed/types'
import { committedEventGroupId } from '@/platform/events/committed/types'
import { sha256Hex } from '@/util/hash'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const NOW = 1_789_488_100_000
const EPOCH = 7
const CRITICAL: CommittedEventDeliveryClass = 'critical'

function persistenceFor(harness: ProviderHarness): CommittedEventDeliveryPersistencePort {
  return createCommittedEventDeliveryPersistence(harness.db)
}

/** 把 collaboration/review 家族推到 dispatchable@EPOCH，让种下的事件可派发。 */
async function enableCutover(
  db: ProviderNeutralDatabase,
  mode: 'legacy' | 'shadow' | 'dispatchable' = 'dispatchable',
  epoch = EPOCH,
): Promise<void> {
  await db
    .update(committedEventFamilyCutovers)
    .set({ mode, epoch, changedAt: NOW, changeRef: 'test:rfc359-w7' })
    .where(
      and(
        eq(committedEventFamilyCutovers.producer, 'collaboration'),
        eq(committedEventFamilyCutovers.family, 'review'),
      ),
    )
    .run()
}

interface SeedConsumer {
  readonly id: string
  readonly deliveryClass?: CommittedEventDeliveryClass
  readonly state?: CommittedEventDeliveryState
  readonly attemptCount?: number
  readonly nextAttemptAt?: number
  readonly claimedBy?: string | null
  readonly leaseEpoch?: number
  readonly claimExpiresAt?: number | null
  readonly lastErrorSummary?: string | null
  readonly createdAt?: number
  readonly updatedAt?: number
}

interface SeedEvent {
  readonly eventId: string
  readonly aggregateId?: string
  readonly aggregateSeq?: number
  readonly eventGroupId?: string
  readonly eventGroupOrdinal?: number
  readonly createdAt?: number
  readonly deliveryMode?: 'shadow' | 'dispatchable'
  readonly producerEpoch?: number
  readonly payloadDigest?: string
  readonly consumers?: readonly SeedConsumer[]
}

/**
 * 直接种事件行 + 投递行。绕过 append 是有意的：投递侧的判据要精确控制 state / lease / 时间戳，
 * 而 append 只会造出 pending@0。envelope 与 digest 按真实规则算，`storedEventFromRow` 才认。
 */
async function seedEvent(db: ProviderNeutralDatabase, input: SeedEvent): Promise<void> {
  const aggregateId = input.aggregateId ?? 'review-1'
  const aggregateSeq = input.aggregateSeq ?? 1
  const eventGroupId = input.eventGroupId ?? committedEventGroupId('collaboration', input.eventId)
  const eventGroupOrdinal = input.eventGroupOrdinal ?? 0
  const createdAt = input.createdAt ?? NOW
  const envelope: CommittedEventEnvelopeV1<'fixture.changed.v1', { value: string }> = {
    eventId: input.eventId,
    eventGroupId,
    eventGroupOrdinal,
    type: 'fixture.changed.v1',
    schemaVersion: 1,
    producer: 'collaboration',
    family: 'review',
    aggregate: { kind: 'review-round', id: aggregateId, seq: aggregateSeq },
    operationRef: input.eventId,
    correlationRef: null,
    causationRef: null,
    occurredAt: new Date(createdAt).toISOString(),
    payload: { value: input.eventId },
  }
  const payloadJson = canonicalJson(envelope)
  await db
    .insert(committedEvents)
    .values({
      id: input.eventId,
      eventGroupId,
      eventGroupOrdinal,
      producer: 'collaboration',
      family: 'review',
      eventType: 'fixture.changed.v1',
      schemaVersion: 1,
      aggregateKind: 'review-round',
      aggregateId,
      aggregateSeq,
      operationRef: input.eventId,
      correlationRef: null,
      causationRef: null,
      occurredAt: createdAt,
      payloadJson,
      payloadDigest: input.payloadDigest ?? sha256Hex(payloadJson),
      deliveryMode: input.deliveryMode ?? 'dispatchable',
      producerEpoch: input.producerEpoch ?? EPOCH,
      createdAt,
    })
    .run()
  for (const consumer of input.consumers ?? [{ id: 'event-center.fixture' }]) {
    await db
      .insert(committedEventDeliveries)
      .values({
        eventId: input.eventId,
        consumerId: consumer.id,
        deliveryClass: consumer.deliveryClass ?? CRITICAL,
        state: consumer.state ?? 'pending',
        attemptCount: consumer.attemptCount ?? 0,
        nextAttemptAt: consumer.nextAttemptAt ?? createdAt,
        claimedBy: consumer.claimedBy ?? null,
        leaseEpoch: consumer.leaseEpoch ?? 0,
        claimExpiresAt: consumer.claimExpiresAt ?? null,
        lastErrorCode: null,
        lastErrorSummary: consumer.lastErrorSummary ?? null,
        replayGeneration: 0,
        createdAt: consumer.createdAt ?? createdAt,
        updatedAt: consumer.updatedAt ?? createdAt,
      })
      .run()
  }
}

function deliveryRows(db: ProviderNeutralDatabase) {
  return db
    .select()
    .from(committedEventDeliveries)
    .orderBy(asc(committedEventDeliveries.eventId), asc(committedEventDeliveries.consumerId))
    .all()
}

async function deliveryRow(db: ProviderNeutralDatabase, eventId: string, consumerId: string) {
  const row = await db
    .select()
    .from(committedEventDeliveries)
    .where(
      and(
        eq(committedEventDeliveries.eventId, eventId),
        eq(committedEventDeliveries.consumerId, consumerId),
      ),
    )
    .all()
  return row[0]
}

function appendInput(input: {
  readonly operation: string
  readonly value?: string
  readonly consumers?: readonly { id: string; deliveryClass: CommittedEventDeliveryClass }[]
}): AppendCommittedEventInput<'fixture.changed.v1', { value: string }> {
  return {
    producer: 'collaboration',
    family: 'review',
    type: 'fixture.changed.v1',
    aggregate: { kind: 'review-round', id: 'review-1' },
    eventGroupId: committedEventGroupId('collaboration', input.operation),
    eventGroupOrdinal: 0,
    operationRef: input.operation,
    occurredAt: NOW,
    payload: { value: input.value ?? input.operation },
    consumers: input.consumers ?? [{ id: 'event-center.fixture', deliveryClass: CRITICAL }],
  }
}

// ---------------------------------------------------------------------------
// 1. append 原子性 —— 事件与业务写同生共死
// ---------------------------------------------------------------------------

describeEachProvider('RFC-359 W7 —— 已提交事件出站存储 · append 原子性', (harness) => {
  test('外层事务回滚带走事件行、投递行与聚合序号', async () => {
    const db = harness.db
    await enableCutover(db)

    await expect(
      harness.session.transaction(async (tx) => {
        await appendCommittedEvent(tx, appendInput({ operation: 'rolled-back' }))
        throw new Error('business write failed after the event was appended')
      }),
    ).rejects.toThrow('business write failed')

    // 事件、投递、聚合头三张表都必须回到 append 之前
    expect(await db.select().from(committedEvents).all()).toEqual([])
    expect(await deliveryRows(db)).toEqual([])
    expect(await db.select().from(committedEventAggregateHeads).all()).toEqual([])
  })

  test('提交的事务留下事件 + 投递行，且聚合序号从 1 起递增', async () => {
    const db = harness.db
    await enableCutover(db)

    const first = await harness.session.transaction(
      async (tx) => await appendCommittedEvent(tx, appendInput({ operation: 'op-1' })),
    )
    expect(first.eventRef).toMatchObject({ aggregate: { seq: 1 }, deliveryMode: 'dispatchable' })

    // 回滚的一笔不能吃掉序号：下一条仍是 2 而不是 3
    await expect(
      harness.session.transaction(async (tx) => {
        await appendCommittedEvent(tx, appendInput({ operation: 'op-doomed' }))
        throw new Error('doomed')
      }),
    ).rejects.toThrow('doomed')

    const second = await harness.session.transaction(
      async (tx) => await appendCommittedEvent(tx, appendInput({ operation: 'op-2' })),
    )
    expect(second.eventRef).toMatchObject({ aggregate: { seq: 2 } })
    expect(await db.select().from(committedEvents).all()).toHaveLength(2)
    expect(await deliveryRows(db)).toHaveLength(2)
  })

  test('legacy 家族不落行；同一 (group, ordinal) 的重放等价、冲突则抛错', async () => {
    const db = harness.db
    await enableCutover(db, 'legacy', 1)
    const legacy = await harness.session.transaction(
      async (tx) => await appendCommittedEvent(tx, appendInput({ operation: 'legacy' })),
    )
    expect(legacy.eventRef).toBeNull()
    expect(await db.select().from(committedEvents).all()).toEqual([])

    await enableCutover(db)
    const input = appendInput({ operation: 'replayed' })
    const first = await harness.session.transaction(
      async (tx) => await appendCommittedEvent(tx, input),
    )
    const replay = await harness.session.transaction(
      async (tx) => await appendCommittedEvent(tx, input),
    )
    expect(replay.eventRef).toEqual(first.eventRef)
    expect(await db.select().from(committedEvents).all()).toHaveLength(1)

    await expect(
      harness.session.transaction(
        async (tx) =>
          await appendCommittedEvent(tx, appendInput({ operation: 'replayed', value: 'other' })),
      ),
    ).rejects.toThrow('conflicts with immutable event')
  })

  test('端口自身的结算写也归外层事务管：回滚后投递仍停在 claimed', async () => {
    // trap #1 的形状：PG 侧若用裸 `db.transaction` / 事务外语句，结算会逃出外层事务，
    // 于是「业务回滚了、投递却记成已投递」。两个引擎都必须回滚得掉。
    const db = harness.db
    await enableCutover(db)
    await seedEvent(db, { eventId: 'evt-settle-rollback' })
    const persistence = persistenceFor(harness)
    const claim = await persistence.claimNext({ workerId: 'w1', now: NOW })
    expect(claim).not.toBeNull()

    await expect(
      harness.session.transaction(async () => {
        await persistence.accept({ claim: claim as ClaimedCommittedEventDelivery, now: NOW + 1 })
        throw new Error('outer rolled back')
      }),
    ).rejects.toThrow('outer rolled back')

    const row = await deliveryRow(db, 'evt-settle-rollback', 'event-center.fixture')
    expect(row?.state).toBe('claimed')
    expect(row?.acceptedAt).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2. 投递一次性 / 重放
// ---------------------------------------------------------------------------

describeEachProvider('RFC-359 W7 —— 已提交事件出站存储 · 投递一次性与重放', (harness) => {
  test('认领写下 attempt / lease / 到期时间，且已认领的行在租约内不会被再认领', async () => {
    const db = harness.db
    await enableCutover(db)
    await seedEvent(db, { eventId: 'evt-1' })
    const persistence = persistenceFor(harness)

    const claim = await persistence.claimNext({ workerId: 'w1', now: NOW, leaseMs: 60_000 })
    expect(claim).toMatchObject({
      consumerId: 'event-center.fixture',
      deliveryClass: CRITICAL,
      attemptCount: 1,
      leaseEpoch: 1,
      claimedBy: 'w1',
      claimExpiresAt: NOW + 60_000,
    })
    expect(claim?.event.envelope.eventId).toBe('evt-1')
    expect(claim?.event.deliveryMode).toBe('dispatchable')
    expect(claim?.event.producerEpoch).toBe(EPOCH)

    const row = await deliveryRow(db, 'evt-1', 'event-center.fixture')
    expect(row).toMatchObject({
      state: 'claimed',
      attemptCount: 1,
      leaseEpoch: 1,
      claimedBy: 'w1',
      claimExpiresAt: NOW + 60_000,
      updatedAt: NOW,
    })

    // 租约未到期 ⇒ 第二个 worker 拿不到
    expect(await persistence.claimNext({ workerId: 'w2', now: NOW + 59_999 })).toBeNull()
  })

  test('租约过期后可重放，attempt / leaseEpoch 继续累加', async () => {
    const db = harness.db
    await enableCutover(db)
    await seedEvent(db, { eventId: 'evt-1' })
    const persistence = persistenceFor(harness)

    await persistence.claimNext({ workerId: 'w1', now: NOW, leaseMs: 1_000 })
    const reclaim = await persistence.claimNext({ workerId: 'w2', now: NOW + 1_000 })
    expect(reclaim).toMatchObject({ attemptCount: 2, leaseEpoch: 2, claimedBy: 'w2' })
  })

  test('accept 结算后不再被认领，且清空租约 / 错误列', async () => {
    const db = harness.db
    await enableCutover(db)
    await seedEvent(db, { eventId: 'evt-1' })
    const persistence = persistenceFor(harness)

    const claim = await persistence.claimNext({ workerId: 'w1', now: NOW })
    await persistence.accept({ claim: claim as ClaimedCommittedEventDelivery, now: NOW + 5 })

    expect(await deliveryRow(db, 'evt-1', 'event-center.fixture')).toMatchObject({
      state: 'accepted',
      claimedBy: null,
      claimExpiresAt: null,
      lastErrorCode: null,
      lastErrorSummary: null,
      acceptedAt: NOW + 5,
      deadLetterAt: null,
      updatedAt: NOW + 5,
    })
    // 一次性：任何后续认领窗口都不再看到它
    expect(await persistence.claimNext({ workerId: 'w2', now: NOW + 10_000_000 })).toBeNull()
  })

  test('丢租约的 accept / reject 抛错而不是静默改写别人的行', async () => {
    const db = harness.db
    await enableCutover(db)
    await seedEvent(db, { eventId: 'evt-1' })
    const persistence = persistenceFor(harness)
    const claim = (await persistence.claimNext({
      workerId: 'w1',
      now: NOW,
    })) as ClaimedCommittedEventDelivery

    const stale = { ...claim, leaseEpoch: claim.leaseEpoch + 1 }
    await expect(persistence.accept({ claim: stale, now: NOW + 1 })).rejects.toThrow(
      'committed event delivery lease lost',
    )
    await expect(
      persistence.reject({
        claim: { ...claim, claimedBy: 'someone-else' },
        errorCode: 'x',
        errorSummary: 'y',
        maxAttempts: 5,
        now: NOW + 1,
      }),
    ).rejects.toThrow('committed event delivery lease lost')
    // 行没被动过
    expect(await deliveryRow(db, 'evt-1', 'event-center.fixture')).toMatchObject({
      state: 'claimed',
      claimedBy: 'w1',
      leaseEpoch: 1,
    })
  })

  test('reject 未触顶 ⇒ 指数退避回 pending；触顶 ⇒ dead-letter 且立即可见', async () => {
    const db = harness.db
    await enableCutover(db)
    await seedEvent(db, { eventId: 'evt-1' })
    const persistence = persistenceFor(harness)

    const first = (await persistence.claimNext({
      workerId: 'w1',
      now: NOW,
    })) as ClaimedCommittedEventDelivery
    expect(
      await persistence.reject({
        claim: first,
        errorCode: 'E'.repeat(300),
        errorSummary: 'S'.repeat(3_000),
        maxAttempts: 2,
        now: NOW + 1,
      }),
    ).toBe('retried')
    const retried = await deliveryRow(db, 'evt-1', 'event-center.fixture')
    expect(retried).toMatchObject({
      state: 'pending',
      claimedBy: null,
      claimExpiresAt: null,
      // attemptCount 1 ⇒ 1000 * 2^0
      nextAttemptAt: NOW + 1 + 1_000,
      deadLetterAt: null,
    })
    expect(retried?.lastErrorCode).toHaveLength(200)
    expect(retried?.lastErrorSummary).toHaveLength(2_000)

    // 退避未到 ⇒ 认领不到
    expect(await persistence.claimNext({ workerId: 'w1', now: NOW + 999 })).toBeNull()

    const second = (await persistence.claimNext({
      workerId: 'w1',
      now: NOW + 1_001,
    })) as ClaimedCommittedEventDelivery
    expect(second.attemptCount).toBe(2)
    expect(
      await persistence.reject({
        claim: second,
        errorCode: 'boom',
        errorSummary: 'terminal',
        maxAttempts: 2,
        now: NOW + 2_000,
      }),
    ).toBe('dead-letter')
    expect(await deliveryRow(db, 'evt-1', 'event-center.fixture')).toMatchObject({
      state: 'dead-letter',
      nextAttemptAt: NOW + 2_000,
      deadLetterAt: NOW + 2_000,
    })
    // dead-letter 不再自动重放
    expect(await persistence.claimNext({ workerId: 'w1', now: NOW + 10_000_000 })).toBeNull()
  })

  test('退避封顶 30s', async () => {
    const db = harness.db
    await enableCutover(db)
    await seedEvent(db, {
      eventId: 'evt-1',
      consumers: [{ id: 'event-center.fixture', attemptCount: 40 }],
    })
    const persistence = persistenceFor(harness)
    const claim = (await persistence.claimNext({
      workerId: 'w1',
      now: NOW,
    })) as ClaimedCommittedEventDelivery
    expect(claim.attemptCount).toBe(41)
    await persistence.reject({
      claim,
      errorCode: 'e',
      errorSummary: 's',
      maxAttempts: 100,
      now: NOW + 1,
    })
    expect((await deliveryRow(db, 'evt-1', 'event-center.fixture'))?.nextAttemptAt).toBe(
      NOW + 1 + 30_000,
    )
  })

  test('人工 retry 只从 dead-letter 起、按 (leaseEpoch, updatedAt) CAS，并推进 replayGeneration', async () => {
    const db = harness.db
    await enableCutover(db)
    await seedEvent(db, { eventId: 'evt-1' })
    const persistence = persistenceFor(harness)
    const claim = (await persistence.claimNext({
      workerId: 'w1',
      now: NOW,
    })) as ClaimedCommittedEventDelivery

    // 还在 claimed ⇒ retry 必须失败
    await expect(
      persistence.retry({
        eventId: 'evt-1',
        consumerId: 'event-center.fixture',
        observedLeaseEpoch: 1,
        observedUpdatedAt: NOW,
        now: NOW + 1,
      }),
    ).rejects.toThrow('retry lost CAS')

    await persistence.reject({
      claim,
      errorCode: 'boom',
      errorSummary: 'terminal',
      maxAttempts: 1,
      now: NOW + 10,
    })
    // 观测值不匹配 ⇒ CAS 失败
    await expect(
      persistence.retry({
        eventId: 'evt-1',
        consumerId: 'event-center.fixture',
        observedLeaseEpoch: 1,
        observedUpdatedAt: NOW + 9,
        now: NOW + 20,
      }),
    ).rejects.toThrow('retry lost CAS')

    const receipt = await persistence.retry({
      eventId: 'evt-1',
      consumerId: 'event-center.fixture',
      observedLeaseEpoch: 1,
      observedUpdatedAt: NOW + 10,
      now: NOW + 20,
    })
    expect(receipt).toEqual({
      eventId: 'evt-1',
      consumerId: 'event-center.fixture',
      replayGeneration: 1,
      state: 'pending',
      updatedAt: NOW + 20,
    })
    expect(await deliveryRow(db, 'evt-1', 'event-center.fixture')).toMatchObject({
      state: 'pending',
      nextAttemptAt: NOW + 20,
      lastErrorCode: null,
      lastErrorSummary: null,
      deadLetterAt: null,
      replayGeneration: 1,
    })
    // 复活后可再次认领
    expect(await persistence.claimNext({ workerId: 'w2', now: NOW + 21 })).not.toBeNull()
  })

  test('shadow 事件与非当前 epoch 的事件都不可派发', async () => {
    const db = harness.db
    await enableCutover(db)
    await seedEvent(db, { eventId: 'evt-shadow', deliveryMode: 'shadow' })
    await seedEvent(db, {
      eventId: 'evt-old-epoch',
      aggregateId: 'review-2',
      producerEpoch: EPOCH - 1,
    })
    const persistence = persistenceFor(harness)
    expect(await persistence.claimNext({ workerId: 'w1', now: NOW + 1 })).toBeNull()
  })

  test('家族 cutover 回到 shadow ⇒ 已落的 dispatchable 事件也停止派发', async () => {
    const db = harness.db
    await enableCutover(db)
    await seedEvent(db, { eventId: 'evt-1' })
    await enableCutover(db, 'shadow', EPOCH)
    const persistence = persistenceFor(harness)
    expect(await persistence.claimNext({ workerId: 'w1', now: NOW + 1 })).toBeNull()
  })

  test('参数校验：workerId 非空、leaseMs / scanLimit / maxAttempts 为正整数', async () => {
    const db = harness.db
    await enableCutover(db)
    const persistence = persistenceFor(harness)
    await expect(persistence.claimNext({ workerId: '', now: NOW })).rejects.toThrow(
      'requires workerId',
    )
    await expect(persistence.claimNext({ workerId: 'w', now: NOW, leaseMs: 0 })).rejects.toThrow(
      'leaseMs must be a positive safe integer',
    )
    await expect(persistence.claimNext({ workerId: 'w', now: NOW, scanLimit: -1 })).rejects.toThrow(
      'scanLimit must be a positive safe integer',
    )
  })
})

// ---------------------------------------------------------------------------
// 3. 顺序
// ---------------------------------------------------------------------------

describeEachProvider('RFC-359 W7 —— 已提交事件出站存储 · 顺序', (harness) => {
  test('同一聚合内严格按 seq 交付：前一条未 accepted 时后一条不可认领', async () => {
    const db = harness.db
    await enableCutover(db)
    await seedEvent(db, { eventId: 'evt-seq-1', aggregateSeq: 1, createdAt: NOW })
    await seedEvent(db, { eventId: 'evt-seq-2', aggregateSeq: 2, createdAt: NOW + 1 })
    const persistence = persistenceFor(harness)

    const first = (await persistence.claimNext({
      workerId: 'w1',
      now: NOW + 10,
    })) as ClaimedCommittedEventDelivery
    expect(first.event.envelope.eventId).toBe('evt-seq-1')
    // seq 1 认领中（未 accepted）⇒ seq 2 被挡住
    expect(await persistence.claimNext({ workerId: 'w2', now: NOW + 10 })).toBeNull()

    await persistence.accept({ claim: first, now: NOW + 11 })
    const second = await persistence.claimNext({ workerId: 'w2', now: NOW + 12 })
    expect(second?.event.envelope.eventId).toBe('evt-seq-2')
  })

  test('阻塞只对同一消费者成立：另一个消费者的 seq 2 照常可认领', async () => {
    const db = harness.db
    await enableCutover(db)
    await seedEvent(db, {
      eventId: 'evt-seq-1',
      aggregateSeq: 1,
      createdAt: NOW,
      consumers: [{ id: 'consumer-a' }],
    })
    await seedEvent(db, {
      eventId: 'evt-seq-2',
      aggregateSeq: 2,
      createdAt: NOW + 1,
      consumers: [{ id: 'consumer-b' }],
    })
    const persistence = persistenceFor(harness)
    const first = (await persistence.claimNext({
      workerId: 'w1',
      now: NOW + 10,
    })) as ClaimedCommittedEventDelivery
    expect(first.consumerId).toBe('consumer-a')
    const second = await persistence.claimNext({ workerId: 'w2', now: NOW + 10 })
    expect(second?.consumerId).toBe('consumer-b')
    expect(second?.event.envelope.eventId).toBe('evt-seq-2')
  })

  test('跨聚合水位：createdAt → eventGroupOrdinal → consumerId 的确定顺序', async () => {
    const db = harness.db
    await enableCutover(db)
    // 同一 createdAt 的两条按 eventGroupOrdinal 排；更早的 createdAt 先出
    await seedEvent(db, {
      eventId: 'evt-late',
      aggregateId: 'agg-late',
      createdAt: NOW + 100,
      consumers: [{ id: 'c1' }],
    })
    await seedEvent(db, {
      eventId: 'evt-early-ord1',
      aggregateId: 'agg-e1',
      eventGroupId: 'grp-early',
      eventGroupOrdinal: 1,
      createdAt: NOW,
      consumers: [{ id: 'c1' }],
    })
    await seedEvent(db, {
      eventId: 'evt-early-ord0',
      aggregateId: 'agg-e0',
      eventGroupId: 'grp-early',
      eventGroupOrdinal: 0,
      createdAt: NOW,
      consumers: [{ id: 'c2' }, { id: 'c1' }],
    })
    const persistence = persistenceFor(harness)

    const order: string[] = []
    for (let i = 0; i < 4; i += 1) {
      const claim = await persistence.claimNext({ workerId: `w${i}`, now: NOW + 1_000 })
      if (claim === null) break
      order.push(`${claim.event.envelope.eventId}/${claim.consumerId}`)
      await persistence.accept({ claim, now: NOW + 1_000 + i })
    }
    expect(order).toEqual([
      'evt-early-ord0/c1',
      'evt-early-ord0/c2',
      'evt-early-ord1/c1',
      'evt-late/c1',
    ])
  })

  test('getStored 按 (eventGroupId, eventGroupOrdinal) 归位，空输入回空', async () => {
    const db = harness.db
    await enableCutover(db)
    await seedEvent(db, {
      eventId: 'evt-b',
      aggregateId: 'agg-b',
      eventGroupId: 'grp-b',
      eventGroupOrdinal: 0,
    })
    await seedEvent(db, {
      eventId: 'evt-a1',
      aggregateId: 'agg-a1',
      eventGroupId: 'grp-a',
      eventGroupOrdinal: 1,
    })
    await seedEvent(db, {
      eventId: 'evt-a0',
      aggregateId: 'agg-a0',
      eventGroupId: 'grp-a',
      eventGroupOrdinal: 0,
    })
    const persistence = persistenceFor(harness)

    expect(await persistence.getStored([])).toEqual([])
    const stored = await persistence.getStored(['evt-b', 'evt-a1', 'evt-a0', 'missing'])
    expect(stored.map((event) => event.envelope.eventId)).toEqual(['evt-a0', 'evt-a1', 'evt-b'])
    expect(stored[0]).toMatchObject({ deliveryMode: 'dispatchable', producerEpoch: EPOCH })
    expect(stored[0]?.payloadDigest).toHaveLength(64)
  })

  test('getStored 对篡改过的 payload digest 抛错，而不是把坏信封放出去', async () => {
    const db = harness.db
    await enableCutover(db)
    await seedEvent(db, { eventId: 'evt-bad', payloadDigest: '0'.repeat(64) })
    await expect(persistenceFor(harness).getStored(['evt-bad'])).rejects.toThrow(
      'payload digest does not match',
    )
  })
})

// ---------------------------------------------------------------------------
// 4. 并发领取
// ---------------------------------------------------------------------------

describeEachProvider('RFC-359 W7 —— 已提交事件出站存储 · 并发领取', (harness) => {
  test('两个 worker 同时扫同一批：同一 (eventId, consumerId) 只被认领一次', async () => {
    const db = harness.db
    await enableCutover(db)
    // 4 个互不相干的聚合，避免顺序阻塞把并发面压没
    for (let i = 0; i < 4; i += 1) {
      await seedEvent(db, {
        eventId: `evt-${i}`,
        aggregateId: `agg-${i}`,
        createdAt: NOW + i,
        consumers: [{ id: 'c1' }],
      })
    }
    const persistence = persistenceFor(harness)

    const claims = await Promise.all([
      persistence.claimNext({ workerId: 'w1', now: NOW + 100 }),
      persistence.claimNext({ workerId: 'w2', now: NOW + 100 }),
      persistence.claimNext({ workerId: 'w3', now: NOW + 100 }),
      persistence.claimNext({ workerId: 'w4', now: NOW + 100 }),
    ])
    const keys = claims
      .filter((claim): claim is ClaimedCommittedEventDelivery => claim !== null)
      .map((claim) => `${claim.event.envelope.eventId}/${claim.consumerId}`)
    expect(keys).toHaveLength(4)
    expect(new Set(keys).size).toBe(4)

    // 每一行恰好被认领一次：attemptCount 全是 1，claimedBy 互不相同
    const rows = await deliveryRows(db)
    expect(rows.map((row) => row.attemptCount)).toEqual([1, 1, 1, 1])
    expect(new Set(rows.map((row) => row.claimedBy)).size).toBe(4)
  })

  test('同一行被并发认领时只有一个 worker 拿到它', async () => {
    const db = harness.db
    await enableCutover(db)
    await seedEvent(db, { eventId: 'evt-1', consumers: [{ id: 'c1' }] })
    const persistence = persistenceFor(harness)

    const claims = await Promise.all([
      persistence.claimNext({ workerId: 'w1', now: NOW + 1 }),
      persistence.claimNext({ workerId: 'w2', now: NOW + 1 }),
    ])
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1)
    expect((await deliveryRow(db, 'evt-1', 'c1'))?.attemptCount).toBe(1)
  })

  test('空队列的认领不改任何行、直接回 null', async () => {
    const db = harness.db
    await enableCutover(db)
    const persistence = persistenceFor(harness)
    expect(await persistence.claimNext({ workerId: 'w1', now: NOW })).toBeNull()
    expect(await deliveryRows(db)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 5. 运维投影（页 + 健康）
// ---------------------------------------------------------------------------

describeEachProvider('RFC-359 W7 —— 已提交事件出站存储 · 运维投影', (harness) => {
  async function seedProjectionFixture(db: ProviderNeutralDatabase): Promise<void> {
    await enableCutover(db)
    await seedEvent(db, {
      eventId: 'evt-a',
      aggregateId: 'agg-a',
      createdAt: NOW,
      consumers: [
        { id: 'event-center.publish', state: 'accepted', updatedAt: NOW + 30 },
        { id: 'downstream.one', state: 'pending', updatedAt: NOW + 10 },
      ],
    })
    await seedEvent(db, {
      eventId: 'evt-b',
      aggregateId: 'agg-b',
      createdAt: NOW + 1,
      consumers: [
        {
          id: 'downstream.two',
          state: 'dead-letter',
          updatedAt: NOW + 20,
          lastErrorSummary: 'boom-latest',
          attemptCount: 5,
          leaseEpoch: 3,
        },
      ],
    })
    await seedEvent(db, {
      eventId: 'evt-c',
      aggregateId: 'agg-c',
      createdAt: NOW + 2,
      deliveryMode: 'shadow',
      consumers: [
        {
          id: 'downstream.two',
          state: 'claimed',
          updatedAt: NOW + 5,
          lastErrorSummary: 'boom-older',
          claimedBy: 'w9',
          claimExpiresAt: NOW + 1_000,
        },
      ],
    })
  }

  test('页：默认按 updatedAt 降序，附带 stage / canRetry / nextAttemptAt 投影', async () => {
    const db = harness.db
    await seedProjectionFixture(db)
    const page = await persistenceFor(harness).deliveryPage({ page: 1, limit: 10 })

    expect(page).toMatchObject({ page: 1, limit: 10, total: 4, pageCount: 1 })
    expect(page.items.map((item) => `${item.eventId}/${item.consumerId}`)).toEqual([
      'evt-a/event-center.publish',
      'evt-b/downstream.two',
      'evt-a/downstream.one',
      'evt-c/downstream.two',
    ])
    expect(page.items[0]).toMatchObject({
      stage: 'producer-publication',
      state: 'accepted',
      nextAttemptAt: null,
      canRetry: false,
      updatedAt: new Date(NOW + 30).toISOString(),
    })
    expect(page.items[1]).toMatchObject({
      stage: 'consumer-delivery',
      state: 'dead-letter',
      mode: 'dispatchable',
      nextAttemptAt: null,
      canRetry: true,
      attemptCount: 5,
      leaseEpoch: 3,
      lastErrorSummary: 'boom-latest',
    })
    expect(page.items[2]).toMatchObject({
      state: 'pending',
      nextAttemptAt: new Date(NOW).toISOString(),
      canRetry: false,
    })
    // shadow 的 dead-letter 也不能 retry —— canRetry 要求 dispatchable
    expect(page.items[3]).toMatchObject({ mode: 'shadow', state: 'claimed', canRetry: false })
    expect(page.items[0]).toMatchObject({
      producer: 'collaboration',
      family: 'review',
      eventType: 'fixture.changed.v1',
      aggregateKind: 'review-round',
      aggregateId: 'agg-a',
      aggregateSeq: 1,
    })
  })

  test('页：stage / state / producer / family / aggregateId / consumerId 六个筛子', async () => {
    const db = harness.db
    await seedProjectionFixture(db)
    const persistence = persistenceFor(harness)
    const ids = async (input: Parameters<typeof persistence.deliveryPage>[0]) =>
      (await persistence.deliveryPage(input)).items.map(
        (item) => `${item.eventId}/${item.consumerId}`,
      )

    expect(await ids({ page: 1, limit: 10, stage: 'producer-publication' })).toEqual([
      'evt-a/event-center.publish',
    ])
    expect(await ids({ page: 1, limit: 10, stage: 'consumer-delivery' })).toEqual([
      'evt-b/downstream.two',
      'evt-a/downstream.one',
      'evt-c/downstream.two',
    ])
    expect(await ids({ page: 1, limit: 10, state: 'dead-letter' })).toEqual([
      'evt-b/downstream.two',
    ])
    expect(await ids({ page: 1, limit: 10, producer: 'task-execution' })).toEqual([])
    expect(await ids({ page: 1, limit: 10, family: 'review' })).toHaveLength(4)
    expect(await ids({ page: 1, limit: 10, family: 'clarify' })).toEqual([])
    expect(await ids({ page: 1, limit: 10, aggregateId: 'agg-b' })).toEqual([
      'evt-b/downstream.two',
    ])
    expect(await ids({ page: 1, limit: 10, consumerId: 'downstream.two' })).toEqual([
      'evt-b/downstream.two',
      'evt-c/downstream.two',
    ])
    // 空串与 null 都当作「不筛」
    expect(await ids({ page: 1, limit: 10, aggregateId: '', consumerId: '' })).toHaveLength(4)
    expect(await ids({ page: 1, limit: 10, stage: null, state: null })).toHaveLength(4)
  })

  test('页：分页切片与 total / pageCount 的算法一致', async () => {
    const db = harness.db
    await seedProjectionFixture(db)
    const persistence = persistenceFor(harness)
    const first = await persistence.deliveryPage({ page: 1, limit: 3 })
    const second = await persistence.deliveryPage({ page: 2, limit: 3 })
    expect(first).toMatchObject({ total: 4, pageCount: 2 })
    expect(first.items).toHaveLength(3)
    expect(second.items.map((item) => item.consumerId)).toEqual(['downstream.two'])
    expect(second).toMatchObject({ page: 2, total: 4, pageCount: 2 })
    // 越界页给空切片但保留计数
    expect(await persistence.deliveryPage({ page: 9, limit: 3 })).toMatchObject({
      items: [],
      total: 4,
      pageCount: 2,
    })
    await expect(persistence.deliveryPage({ page: 0, limit: 3 })).rejects.toThrow(
      'page must be a positive safe integer',
    )
    await expect(persistence.deliveryPage({ page: 1, limit: 0 })).rejects.toThrow(
      'limit must be a positive safe integer',
    )
  })

  test('健康：三个计数 + 最旧 pending 的 createdAt + 最近一次错误摘要', async () => {
    const db = harness.db
    await seedProjectionFixture(db)
    const health: CommittedEventDeliveryHealth = await persistenceFor(harness).health()
    expect(health).toEqual({
      pending: 1,
      claimed: 1,
      deadLetter: 1,
      oldestPendingAt: NOW,
      lastErrorSummary: 'boom-latest',
    })
  })

  test('页：stage 筛子与 stage 投影必须给同一个答案（LIKE 的大小写语义两引擎相反）', async () => {
    // `stage` 投影在 JS 里按 `startsWith('event-center.')` 算（大小写敏感），筛子却是 SQL `LIKE`
    // ——SQLite 的 LIKE 对 ASCII 不敏感、PostgreSQL 敏感。大小写不同的消费者 id 会让「筛出来的
    // 行」和「它自报的 stage」在某一侧对不上。判据只有一条：两者必须自洽。
    const db = harness.db
    await enableCutover(db)
    await seedEvent(db, {
      eventId: 'evt-case',
      consumers: [{ id: 'Event-Center.upper' }, { id: 'event-center.lower' }],
    })
    const persistence = persistenceFor(harness)
    const producerStage = await persistence.deliveryPage({
      page: 1,
      limit: 10,
      stage: 'producer-publication',
    })
    const consumerStage = await persistence.deliveryPage({
      page: 1,
      limit: 10,
      stage: 'consumer-delivery',
    })
    for (const item of producerStage.items) expect(item.stage).toBe('producer-publication')
    for (const item of consumerStage.items) expect(item.stage).toBe('consumer-delivery')
    expect(producerStage.items.length + consumerStage.items.length).toBe(2)
  })

  test('页：updatedAt 打平时按 eventId 降序，且两个引擎给同一串（文本排序规则）', async () => {
    const db = harness.db
    await enableCutover(db)
    for (const [index, eventId] of ['evt-b', 'evt_a', 'evtA'].entries()) {
      await seedEvent(db, {
        eventId,
        aggregateId: `agg-${index}`,
        consumers: [{ id: 'c1', updatedAt: NOW + 5 }],
      })
    }
    const page = await persistenceFor(harness).deliveryPage({ page: 1, limit: 10 })
    expect(page.items.map((item) => item.eventId)).toEqual(['evt_a', 'evtA', 'evt-b'])
  })

  test('健康：空库给零计数与空游标（数值列必须是 number，不能是驱动回来的字符串）', async () => {
    const health = await persistenceFor(harness).health()
    expect(health).toEqual({
      pending: 0,
      claimed: 0,
      deadLetter: 0,
      oldestPendingAt: null,
      lastErrorSummary: null,
    })
  })
})
