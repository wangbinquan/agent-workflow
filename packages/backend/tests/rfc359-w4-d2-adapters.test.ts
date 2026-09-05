// RFC-359 W4-D2 —— integration webhook 投递链合一（投递持久化 + 已验证投递接收），两个引擎各跑一遍：
// 同 uuid 重投原子 bump、中断恢复（受控投递记 matched、其余记 failed）、两段 GC 的跨批推进、
// MR 关闭在一个事务里落投递 + 流状态 + 控制 effect 并撤销早于该修订的启动守卫、同事实重投只 bump、
// reopen / merge 的线性化、终态重放复用根修订与根 effect、非 MR 无 uuid 投递不去重。

import { expect, test } from 'bun:test'
import type { CodeHostEvent } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  webhookDeliveries,
  webhookEndpoints,
  webhookMrControlEffects,
  webhookMrLaunchGuards,
  webhookMrStreamStates,
} from '@/db/schema'
import { stableMrIdentityOf } from '@/modules/integration/domain/mrTerminalControl'
import { createVerifiedWebhookDeliveryPersistence } from '@/modules/integration/infrastructure/verifiedWebhookDeliveryPersistence'
import { createWebhookDeliveryPersistence } from '@/modules/integration/infrastructure/webhookDeliveryPersistence'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

async function seedEndpoint(db: ProviderNeutralDatabase, id: string): Promise<void> {
  await db.insert(webhookEndpoints).values({
    id,
    name: id,
    provider: 'gitlab',
    urlToken: `aw_whk_${id}`,
    secretEnc: 'sealed',
    enabled: true,
  })
}

function mrEvent(over: Partial<CodeHostEvent> = {}): CodeHostEvent {
  return {
    provider: 'gitlab',
    eventUuid: 'event-d2-1',
    eventType: 'mr_closed',
    repoPath: 'group/repo',
    repoHttpUrl: 'https://example.test/group/repo.git',
    repoSshUrl: 'git@example.test:group/repo.git',
    projectId: '77',
    mrIid: '9',
    author: {},
    raw: {},
    ...over,
  }
}

function acceptInput(
  event: CodeHostEvent,
  body: string,
  replay?: { rootDeliveryId: string; terminalRootRevision: number | null },
) {
  return {
    endpointId: 'ep-d2',
    event,
    rawBodyBytes: new TextEncoder().encode(body),
    rawBodyText: body,
    eventHeader: 'Merge Request Hook',
    objectKind: 'merge_request',
    ...(replay === undefined ? {} : { replay }),
  }
}

describeEachProvider('RFC-359 W4-D2 —— webhook 投递持久化 + 已验证投递接收', (harness) => {
  test('投递持久化：重投 bump / 中断恢复 / 两段 GC / 端点最近投递时间', async () => {
    const db = harness.db
    await seedEndpoint(db, 'ep-d2')
    const deliveries = createWebhookDeliveryPersistence(db)
    const verified = createVerifiedWebhookDeliveryPersistence(db)

    const first = await deliveries.insert({
      endpointId: 'ep-d2',
      eventUuid: 'uuid-1',
      eventType: 'push',
      status: 'received',
      bodyJson: '{"n":1}',
    })
    expect(first.kind).toBe('inserted')
    const again = await deliveries.insert({
      endpointId: 'ep-d2',
      eventUuid: 'uuid-1',
      eventType: 'push',
      status: 'received',
      bodyJson: '{"n":1}',
    })
    expect(again).toEqual({
      kind: 'duplicate',
      deliveryId: first.deliveryId,
      attemptCount: 2,
    })
    // 无 uuid 不去重。
    expect(
      (await deliveries.insert({ endpointId: 'ep-d2', eventUuid: null, status: 'received' })).kind,
    ).toBe('inserted')

    await deliveries.mark({
      deliveryId: first.deliveryId,
      status: 'ignored',
      reason: 'no-trigger-matched',
    })
    expect(
      (
        await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, first.deliveryId))
      )[0],
    ).toMatchObject({ status: 'ignored', statusReason: 'no-trigger-matched', attemptCount: 2 })

    // 中断恢复：带控制 effect 的投递记 matched，其余进行中的记 failed / interrupted。
    const controlled = await verified.accept(acceptInput(mrEvent(), '{"state":"closed"}'))
    expect(controlled.kind).toBe('inserted')
    const processing = await deliveries.insert({
      endpointId: 'ep-d2',
      eventUuid: 'uuid-2',
      status: 'processing',
    })
    expect(await deliveries.recoverInterrupted()).toBe(2)
    const byId = new Map((await db.select().from(webhookDeliveries)).map((row) => [row.id, row]))
    expect(byId.get(controlled.deliveryId)).toMatchObject({
      status: 'matched',
      statusReason: 'terminal-control-accepted',
    })
    expect(byId.get(processing.deliveryId)).toMatchObject({
      status: 'failed',
      statusReason: 'interrupted',
    })
    expect(byId.get(first.deliveryId)?.status).toBe('ignored')

    // 两段 GC：先清旧 body，再删旧行；受控投递（effect 未成功）不删。
    await db
      .update(webhookDeliveries)
      .set({ receivedAt: NOW - 30 * DAY })
      .where(eq(webhookDeliveries.endpointId, 'ep-d2'))
    await db.insert(webhookDeliveries).values({
      id: 'fresh',
      endpointId: 'ep-d2',
      eventUuid: 'uuid-fresh',
      status: 'ignored',
      bodyJson: '{"fresh":true}',
      receivedAt: NOW - 1 * DAY,
    })
    const retention = { bodyRetentionMs: 10 * DAY, rowRetentionMs: 20 * DAY }
    const bodies1 = await deliveries.gcSlice({ now: NOW, cursor: null, batchSize: 2, retention })
    expect(bodies1).toMatchObject({
      done: false,
      cursor: { phase: 'bodies' },
      counters: { bodiesCleared: 2, rowsDeleted: 0 },
    })
    const bodies2 = await deliveries.gcSlice({
      now: NOW,
      cursor: bodies1.cursor,
      batchSize: 2,
      retention,
    })
    // 过期且有 body 的只有两行（uuid-1 与受控投递），第二批清 0 行 → 段推进到 rows。
    expect(bodies2.counters).toEqual({ bodiesCleared: 0, rowsDeleted: 0 })
    expect(bodies2.cursor.phase).toBe('rows')
    const rows1 = await deliveries.gcSlice({
      now: NOW,
      cursor: bodies2.cursor,
      batchSize: 10,
      retention,
    })
    // 四行过期：uuid-1 / 无 uuid / uuid-2 可删；受控投递的 effect 仍 pending → 留下。
    expect(rows1).toMatchObject({ done: true, counters: { bodiesCleared: 0, rowsDeleted: 3 } })
    const left = await db.select().from(webhookDeliveries)
    expect(left.map((row) => row.id).sort()).toEqual([controlled.deliveryId, 'fresh'].sort())
    expect(left.find((row) => row.id === 'fresh')?.bodyJson).toBe('{"fresh":true}')
    expect(left.find((row) => row.id === controlled.deliveryId)?.bodyJson).toBeNull()

    await deliveries.touchEndpointLastDelivery('ep-d2', NOW + 5)
    expect(
      (await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, 'ep-d2')))[0]
        ?.lastDeliveryAt,
    ).toBe(NOW + 5)
  })

  test('已验证投递接收：关闭事实原子落三张表并撤销早修订守卫、重投 bump、reopen / merge 线性化、终态重放、非 MR 不去重', async () => {
    const db = harness.db
    await seedEndpoint(db, 'ep-d2')
    const verified = createVerifiedWebhookDeliveryPersistence(db)
    const identity = stableMrIdentityOf(mrEvent())
    if (identity === null) throw new Error('fixture identity')
    await db.insert(webhookMrLaunchGuards).values({
      id: 'guard-old',
      endpointId: 'ep-d2',
      streamKey: identity.streamKey,
      binding: 'binding',
      launchRevision: 0,
      deliveryId: 'delivery-earlier',
      fireId: 'fire-1',
      triggerNameSnapshot: 'trigger',
      status: 'reserved',
      createdAt: NOW,
      updatedAt: NOW,
    })

    const closed = await verified.accept(acceptInput(mrEvent(), '{"state":"closed"}'))
    expect(closed).toMatchObject({ kind: 'inserted', controlAccepted: true, streamRevision: 1 })
    if (closed.kind !== 'inserted') throw new Error('expected insert')
    expect((await db.select().from(webhookMrStreamStates))[0]).toMatchObject({
      state: 'closed',
      revision: 1,
      lastTerminalRevision: 1,
      lastDeliveryId: closed.deliveryId,
    })
    expect((await db.select().from(webhookMrControlEffects))[0]).toMatchObject({
      id: closed.effectId,
      deliveryId: closed.deliveryId,
      kind: 'fence-closed',
      status: 'pending',
      revision: 1,
    })
    expect((await db.select().from(webhookMrLaunchGuards))[0]?.status).toBe('revoking-terminal')

    // 同事实重投：只 bump attempt，唤醒同一个 effect。
    const duplicate = await verified.accept(acceptInput(mrEvent(), '{"state":"closed"}'))
    expect(duplicate).toEqual({
      kind: 'duplicate',
      deliveryId: closed.deliveryId,
      attemptCount: 2,
      effectId: closed.effectId,
    })
    expect((await db.select().from(webhookDeliveries)).length).toBe(1)

    // body 变了就是另一条事实：reopen 推进修订并清掉 closed；merge 是吸收态。
    const reopened = await verified.accept(
      acceptInput(
        mrEvent({ eventUuid: 'event-d2-2', eventType: 'mr_opened' }),
        '{"state":"opened"}',
      ),
    )
    expect(reopened).toMatchObject({ kind: 'inserted', streamRevision: 2 })
    expect((await db.select().from(webhookMrStreamStates))[0]).toMatchObject({
      state: 'open',
      revision: 2,
    })
    const merged = await verified.accept(
      acceptInput(
        mrEvent({ eventUuid: 'event-d2-3', eventType: 'mr_merged' }),
        '{"state":"merged"}',
      ),
    )
    expect(merged).toMatchObject({ kind: 'inserted', controlAccepted: true, streamRevision: 3 })
    await verified.accept(
      acceptInput(
        mrEvent({ eventUuid: 'event-d2-4', eventType: 'mr_opened' }),
        '{"state":"opened","late":true}',
      ),
    )
    expect((await db.select().from(webhookMrStreamStates))[0]).toMatchObject({
      state: 'merged',
      revision: 4,
    })

    // 到此三个 effect：fence-closed / clear-closed（reopen）/ fence-merged；merge 后的 late reopen 被吸收，不产生 effect。
    const effectsBeforeReplay = (await db.select().from(webhookMrControlEffects)).length
    expect(effectsBeforeReplay).toBe(3)
    // 终态重放：复用根修订与根 effect，不新增线性化点。
    const replay = await verified.accept(
      acceptInput(mrEvent(), '{"state":"closed"}', {
        rootDeliveryId: closed.deliveryId,
        terminalRootRevision: 1,
      }),
    )
    expect(replay).toMatchObject({
      kind: 'inserted',
      effectId: closed.effectId,
      controlAccepted: true,
      streamRevision: 1,
    })
    expect((await db.select().from(webhookMrControlEffects)).length).toBe(effectsBeforeReplay)
    expect((await db.select().from(webhookMrStreamStates))[0]?.revision).toBe(4)
    expect(
      (
        await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, replay.deliveryId))
      )[0],
    ).toMatchObject({
      replayedFromDeliveryId: closed.deliveryId,
      eventUuid: null,
      mrStateAfter: 'closed',
    })

    // 非 MR、无 uuid：沿用不去重的旧行为。
    const push = mrEvent({ eventUuid: null, eventType: 'push', mrIid: undefined })
    expect((await verified.accept(acceptInput(push, '{"push":true}'))).kind).toBe('inserted')
    expect((await verified.accept(acceptInput(push, '{"push":true}'))).kind).toBe('inserted')
  })
})
