// RFC-359 W8 —— 维护 run 认领 / 租约存储（`MaintenanceRunStore`）的双引擎取证基线。
//
// 合一之前这一对的形态是：SQLite 侧一份**同步**实现（`sqlite/maintenanceRunStore.ts`，4 处
// `dbTxSync`）外面套一层逐方法 `async X(){ return store.X(...) }` 的恒等适配器；PostgreSQL 侧
// 一份原生重写（`postgresqlMaintenanceRunStore.ts`，4 处 `db.transaction`）。
// 同一张状态机表、同一套租约围栏，抄了两遍。
//
// 覆盖同样倒挂：`rfc338-maintenance-run-store.test.ts` 的正确性矩阵**只跑 SQLite**；PG 那份
// 的行为覆盖只有 `rfc349-system-maintenance-provider.test.ts` 的**脚本化 SQL 抄本**（心跳一条
// 语句序列）与 `rfc349-dual-provider-behavior-oracle.test.ts` 的一段脚本化 transcript——都不是
// 在真库上跑出来的行为。也就是说 PG 侧的 claim 优先级 / 一次只排一个 / deferred 吸收补课 /
// 崩溃恢复 / projection 排序，**在真 PostgreSQL 上从来没有被执行过**。
//
// 所以按 W4-D19b/D23a/D28a 的方法论：**先按端口取证、再合一**——同一批场景通过同一个端口在两个
// 引擎上各跑一遍，用实测差异代替纸面对账。这份文件是合一的判据基线：它现在锁住的每一条，
// 合一之后必须继续成立。

import { expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { maintenanceRuns } from '@/db/schema'
import type { MaintenanceRunStore } from '@/platform/background/maintenanceRunStorePort'
import { createMaintenanceRunStore } from '@/platform/persistence/maintenanceRunStore'
import { describeEachProvider } from './helpers/eachProvider'

// 合一之后两个引擎装配的是**同一个工厂**。合一之前这里按 `$provider` 分派到两个旧实现，
// 40 条判据在两个真引擎上各跑一遍全绿——这份文件因此既是合一的前置取证，也是合一后的回归锁。
function storeFor(db: ProviderNeutralDatabase): MaintenanceRunStore {
  return createMaintenanceRunStore(db)
}

/** 直接读表——端口自己的读面不参与判据时用它，避免「用被测对象证明被测对象」。 */
async function rowOf(
  db: ProviderNeutralDatabase,
  runId: string,
): Promise<typeof maintenanceRuns.$inferSelect | undefined> {
  return (await db.select().from(maintenanceRuns).where(eq(maintenanceRuns.id, runId)).limit(1))[0]
}

async function countQueued(db: ProviderNeutralDatabase, jobKey: string): Promise<number> {
  return (
    await db
      .select({ id: maintenanceRuns.id })
      .from(maintenanceRuns)
      .where(and(eq(maintenanceRuns.jobKey, jobKey), eq(maintenanceRuns.state, 'pending')))
  ).length
}

describeEachProvider('RFC-359 W8 —— MaintenanceRunStore 入队与合并', (harness) => {
  test('同槽去重、后续槽合并到唯一在排队的那一行', async () => {
    const store = storeFor(harness.db)
    const first = await store.enqueue({
      id: 'run-1',
      jobKey: 'tokenAuditGc',
      jobClass: 'cleanup',
      slotKey: '2026-08-28T01',
      payload: { retentionDays: 90 },
      scheduledAt: 100,
      now: 100,
    })
    const duplicate = await store.enqueue({
      id: 'run-2',
      jobKey: 'tokenAuditGc',
      jobClass: 'cleanup',
      slotKey: '2026-08-28T01',
      payload: { retentionDays: 90 },
      scheduledAt: 100,
      now: 101,
    })
    const nextSlot = await store.enqueue({
      id: 'run-3',
      jobKey: 'tokenAuditGc',
      jobClass: 'cleanup',
      slotKey: '2026-08-28T02',
      payload: { retentionDays: 90 },
      scheduledAt: 200,
      now: 200,
    })

    expect(first).toMatchObject({ inserted: true, coalesced: false })
    expect(first.row.id).toBe('run-1')
    expect(duplicate).toMatchObject({ inserted: false, coalesced: true })
    expect(duplicate.row.id).toBe('run-1')
    expect(nextSlot).toMatchObject({ inserted: false, coalesced: true })
    expect(nextSlot.row.id).toBe('run-1')
    expect(await countQueued(harness.db, 'tokenAuditGc')).toBe(1)
    // payload / 时间戳按入队参数原样落库（两个引擎同一份行投影）。
    expect(first.row).toMatchObject({
      jobKey: 'tokenAuditGc',
      jobClass: 'cleanup',
      slotKey: '2026-08-28T01',
      state: 'pending',
      payloadJson: '{"retentionDays":90}',
      countersJson: '{}',
      cursorVersion: 1,
      cursorJson: null,
      attempt: 0,
      sliceNo: 0,
      scheduledAt: 100,
      createdAt: 100,
      updatedAt: 100,
      startedAt: null,
      finishedAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
    })
  })

  test('不同 job 各自排队，互不合并；cycleKey 原样保留', async () => {
    const store = storeFor(harness.db)
    const a = await store.enqueue({
      id: 'cycle-a',
      jobKey: 'tokenAuditGc',
      jobClass: 'cleanup',
      slotKey: 'h:1',
      cycleKey: 'cycle-1',
      payload: {},
      scheduledAt: 0,
      now: 0,
    })
    const b = await store.enqueue({
      id: 'cycle-b',
      jobKey: 'eventsArchive',
      jobClass: 'cleanup',
      slotKey: 'h:1',
      payload: {},
      scheduledAt: 0,
      now: 0,
    })
    expect(a).toMatchObject({ inserted: true, coalesced: false })
    expect(b).toMatchObject({ inserted: true, coalesced: false })
    expect(a.row.cycleKey).toBe('cycle-1')
    expect(b.row.cycleKey).toBeNull()
  })
})

describeEachProvider('RFC-359 W8 —— 认领优先级与租约围栏', (harness) => {
  test('recovery 先于 cleanup 被认领，晚到的租约收据被围栏挡掉', async () => {
    const store = storeFor(harness.db)
    await store.enqueue({
      id: 'cleanup',
      jobKey: 'eventsArchive',
      jobClass: 'cleanup',
      slotKey: 'h:1',
      payload: {},
      scheduledAt: 0,
      now: 0,
    })
    await store.enqueue({
      id: 'recovery',
      jobKey: 'lifecycleInvariants',
      jobClass: 'recovery',
      slotKey: 'h:1',
      payload: { scope: { all: true } },
      scheduledAt: 0,
      now: 0,
    })

    const claimed = await store.claimNext({ leaseToken: 'lease-a', now: 10, leaseMs: 50 })
    expect(claimed?.row.id).toBe('recovery')
    expect(claimed?.leaseToken).toBe('lease-a')
    expect(claimed?.row).toMatchObject({
      state: 'running',
      attempt: 1,
      leaseToken: 'lease-a',
      leaseExpiresAt: 60,
      heartbeatAt: 10,
      startedAt: 10,
      updatedAt: 10,
    })

    expect(
      await store.heartbeat({ runId: 'recovery', leaseToken: 'wrong', now: 20, leaseMs: 50 }),
    ).toBe(false)
    expect(
      await store.heartbeat({
        runId: 'recovery',
        leaseToken: 'lease-a',
        now: 20,
        leaseMs: 50,
        counters: { beat: 1 },
      }),
    ).toBe(true)
    expect(await rowOf(harness.db, 'recovery')).toMatchObject({
      leaseExpiresAt: 70,
      heartbeatAt: 20,
      countersJson: '{"beat":1}',
    })

    expect(
      await store.settle({
        runId: 'recovery',
        leaseToken: 'lease-a',
        now: 30,
        outcome: 'succeeded',
        counters: { scanned: 4 },
      }),
    ).toBe(true)
    // 同一把 token 的第二次结算：行已经不是 running，围栏拒收。
    expect(
      await store.settle({
        runId: 'recovery',
        leaseToken: 'lease-a',
        now: 31,
        outcome: 'failed',
      }),
    ).toBe(false)
    expect(await store.read('recovery')).toMatchObject({
      state: 'succeeded',
      countersJson: '{"scanned":4}',
      sliceNo: 1,
      finishedAt: 30,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
    })
  })

  test('checkpoint 排在 cleanup 之前、recovery 之后；同类按 scheduledAt 再按 createdAt', async () => {
    const store = storeFor(harness.db)
    for (const [id, jobKey, jobClass, scheduledAt] of [
      ['late-cleanup', 'tokenAuditGc', 'cleanup', 0],
      ['checkpoint', 'walCheckpoint', 'checkpoint', 0],
      ['recovery', 'lifecycleInvariants', 'recovery', 0],
    ] as const) {
      await store.enqueue({
        id,
        jobKey,
        jobClass,
        slotKey: `slot:${id}`,
        payload: {},
        scheduledAt,
        now: 0,
      })
    }
    const order: string[] = []
    for (let i = 0; i < 3; i += 1) {
      const claimed = await store.claimNext({ leaseToken: `lease-${i}`, now: 10, leaseMs: 1_000 })
      if (claimed === null) break
      order.push(claimed.row.id)
      await store.settle({
        runId: claimed.row.id,
        leaseToken: claimed.leaseToken,
        now: 11 + i,
        outcome: 'succeeded',
      })
    }
    expect(order).toEqual(['recovery', 'checkpoint', 'late-cleanup'])
  })

  test('未到期的槽不可认领；空队列返回 null', async () => {
    const store = storeFor(harness.db)
    expect(await store.claimNext({ leaseToken: 'empty', now: 1, leaseMs: 10 })).toBeNull()
    await store.enqueue({
      id: 'future',
      jobKey: 'tokenAuditGc',
      jobClass: 'cleanup',
      slotKey: 'future:1',
      payload: {},
      scheduledAt: 100,
      now: 0,
    })
    expect(await store.claimNext({ leaseToken: 'early', now: 99, leaseMs: 10 })).toBeNull()
    expect((await store.claimNext({ leaseToken: 'due', now: 100, leaseMs: 10 }))?.row.id).toBe(
      'future',
    )
  })
})

describeEachProvider('RFC-359 W8 —— 一次只排一个后继槽', (harness) => {
  test('同一 job 正在运行时保留一个耐久后继槽，更晚的槽合并进去', async () => {
    const store = storeFor(harness.db)
    await store.enqueue({
      id: 'current',
      jobKey: 'eventsArchive',
      jobClass: 'cleanup',
      slotKey: 'hourly:1',
      payload: {},
      scheduledAt: 0,
      now: 0,
    })
    expect(
      (await store.claimNext({ leaseToken: 'lease-current', now: 1, leaseMs: 100 }))?.row.id,
    ).toBe('current')

    const next = await store.enqueue({
      id: 'next',
      jobKey: 'eventsArchive',
      jobClass: 'cleanup',
      slotKey: 'hourly:2',
      payload: {},
      scheduledAt: 2,
      now: 2,
    })
    const later = await store.enqueue({
      id: 'later',
      jobKey: 'eventsArchive',
      jobClass: 'cleanup',
      slotKey: 'hourly:3',
      payload: {},
      scheduledAt: 3,
      now: 3,
    })
    expect(next).toMatchObject({ inserted: true, coalesced: false })
    expect(later).toMatchObject({ inserted: false, coalesced: true })
    expect(later.row.id).toBe('next')

    expect(
      await store.settle({
        runId: 'current',
        leaseToken: 'lease-current',
        now: 4,
        outcome: 'succeeded',
      }),
    ).toBe(true)
    expect(
      (await store.claimNext({ leaseToken: 'lease-next', now: 4, leaseMs: 100 }))?.row.id,
    ).toBe('next')
  })
})

describeEachProvider('RFC-359 W8 —— 崩溃恢复与 deferred 吸收补课', (harness) => {
  test('recoverRunning 原子吸收已排队的后继槽再恢复游标', async () => {
    const store = storeFor(harness.db)
    await store.enqueue({
      id: 'restart-current',
      jobKey: 'tokenAuditGc',
      jobClass: 'cleanup',
      slotKey: 'hourly:1',
      payload: { retentionDays: 90 },
      scheduledAt: 0,
      now: 0,
    })
    await store.claimNext({ leaseToken: 'restart-lease', now: 1, leaseMs: 10 })
    await store.enqueue({
      id: 'restart-next',
      jobKey: 'tokenAuditGc',
      jobClass: 'cleanup',
      slotKey: 'hourly:2',
      payload: { retentionDays: 90 },
      scheduledAt: 2,
      now: 2,
    })

    expect(await store.recoverRunning(3)).toBe(1)
    expect(await rowOf(harness.db, 'restart-next')).toBeUndefined()
    expect(await store.read('restart-current')).toMatchObject({
      state: 'deferred',
      errorCode: 'worker-restarted',
      errorMessage: 'maintenance worker restarted before completion receipt',
      scheduledAt: 3,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
    })
    // 恢复后重新可认领，attempt 继续累加、startedAt 保留首次开工时刻。
    const reclaimed = await store.claimNext({ leaseToken: 'fresh', now: 4, leaseMs: 20 })
    expect(reclaimed?.row).toMatchObject({ id: 'restart-current', attempt: 2, startedAt: 1 })
  })

  test('没有 running 行时 recoverRunning 返回 0', async () => {
    const store = storeFor(harness.db)
    expect(await store.recoverRunning(1)).toBe(0)
    await store.enqueue({
      id: 'idle',
      jobKey: 'tokenAuditGc',
      jobClass: 'cleanup',
      slotKey: 'idle:1',
      payload: {},
      scheduledAt: 0,
      now: 0,
    })
    expect(await store.recoverRunning(1)).toBe(0)
  })

  test('running 切片转 deferred 前吸收自己的补课槽，并按 nextAttemptAt 重新排期', async () => {
    const store = storeFor(harness.db)
    await store.enqueue({
      id: 'busy-current',
      jobKey: 'eventsArchive',
      jobClass: 'cleanup',
      slotKey: 'hourly:1',
      payload: {},
      scheduledAt: 0,
      now: 0,
    })
    await store.claimNext({ leaseToken: 'busy-lease', now: 1, leaseMs: 100 })
    await store.enqueue({
      id: 'busy-next',
      jobKey: 'eventsArchive',
      jobClass: 'cleanup',
      slotKey: 'hourly:2',
      payload: {},
      scheduledAt: 2,
      now: 2,
    })

    expect(
      await store.settle({
        runId: 'busy-current',
        leaseToken: 'busy-lease',
        now: 3,
        outcome: 'deferred',
        cursor: { offset: 12 },
        counters: { swept: 7 },
        nextAttemptAt: 50,
      }),
    ).toBe(true)
    expect(await rowOf(harness.db, 'busy-next')).toBeUndefined()
    expect(await store.read('busy-current')).toMatchObject({
      state: 'deferred',
      scheduledAt: 50,
      sliceNo: 1,
      cursorJson: '{"offset":12}',
      countersJson: '{"swept":7}',
      finishedAt: null,
    })
    expect(await store.claimNext({ leaseToken: 'early', now: 49, leaseMs: 100 })).toBeNull()
    expect((await store.claimNext({ leaseToken: 'retry', now: 50, leaseMs: 100 }))?.row.id).toBe(
      'busy-current',
    )
  })

  test('deferred 结算的租约围栏：错 token 不改行', async () => {
    const store = storeFor(harness.db)
    await store.enqueue({
      id: 'fenced',
      jobKey: 'eventsArchive',
      jobClass: 'cleanup',
      slotKey: 'hourly:1',
      payload: {},
      scheduledAt: 0,
      now: 0,
    })
    await store.claimNext({ leaseToken: 'right', now: 1, leaseMs: 100 })
    expect(
      await store.settle({
        runId: 'fenced',
        leaseToken: 'wrong',
        now: 2,
        outcome: 'deferred',
        nextAttemptAt: 9,
      }),
    ).toBe(false)
    expect(await rowOf(harness.db, 'fenced')).toMatchObject({
      state: 'running',
      leaseToken: 'right',
      sliceNo: 0,
    })
  })
})

describeEachProvider('RFC-359 W8 —— 边界与拒绝分支', (harness) => {
  test('未知 runId 的心跳 / 结算一律不成立', async () => {
    const store = storeFor(harness.db)
    expect(await store.heartbeat({ runId: 'nobody', leaseToken: 'x', now: 1, leaseMs: 10 })).toBe(
      false,
    )
    for (const outcome of ['succeeded', 'failed', 'deferred'] as const) {
      expect(await store.settle({ runId: 'nobody', leaseToken: 'x', now: 1, outcome })).toBe(false)
    }
  })

  test('非 running 行不接受心跳与结算', async () => {
    const store = storeFor(harness.db)
    await store.enqueue({
      id: 'idle',
      jobKey: 'tokenAuditGc',
      jobClass: 'cleanup',
      slotKey: 'idle:1',
      payload: {},
      scheduledAt: 0,
      now: 0,
    })
    expect(await store.heartbeat({ runId: 'idle', leaseToken: 'any', now: 1, leaseMs: 10 })).toBe(
      false,
    )
    expect(
      await store.settle({ runId: 'idle', leaseToken: 'any', now: 1, outcome: 'succeeded' }),
    ).toBe(false)
    expect(await rowOf(harness.db, 'idle')).toMatchObject({ state: 'pending', sliceNo: 0 })
  })

  test('同一 job+slot 在终态之后再入队，拿回的是那条终态行（不是新一轮）', async () => {
    const store = storeFor(harness.db)
    await store.enqueue({
      id: 'terminal',
      jobKey: 'tokenAuditGc',
      jobClass: 'cleanup',
      slotKey: 'same:1',
      payload: {},
      scheduledAt: 0,
      now: 0,
    })
    await store.claimNext({ leaseToken: 'lt', now: 1, leaseMs: 100 })
    await store.settle({ runId: 'terminal', leaseToken: 'lt', now: 2, outcome: 'succeeded' })
    const again = await store.enqueue({
      id: 'terminal-again',
      jobKey: 'tokenAuditGc',
      jobClass: 'cleanup',
      slotKey: 'same:1',
      payload: {},
      scheduledAt: 3,
      now: 3,
    })
    expect(again).toMatchObject({ inserted: false, coalesced: false })
    expect(again.row).toMatchObject({ id: 'terminal', state: 'succeeded' })
  })

  test('cursor 显式给 null 时清空游标；不给时也清空（合同是「本次结算的游标」）', async () => {
    const store = storeFor(harness.db)
    await store.enqueue({
      id: 'cursor-run',
      jobKey: 'eventsArchive',
      jobClass: 'cleanup',
      slotKey: 'c:1',
      payload: {},
      scheduledAt: 0,
      now: 0,
    })
    await store.claimNext({ leaseToken: 'lc', now: 1, leaseMs: 100 })
    await store.settle({
      runId: 'cursor-run',
      leaseToken: 'lc',
      now: 2,
      outcome: 'deferred',
      cursor: { at: 1 },
      nextAttemptAt: 2,
    })
    expect(await rowOf(harness.db, 'cursor-run')).toMatchObject({ cursorJson: '{"at":1}' })
    const claimed = await store.claimNext({ leaseToken: 'lc2', now: 2, leaseMs: 100 })
    expect(claimed?.row.id).toBe('cursor-run')
    await store.settle({
      runId: 'cursor-run',
      leaseToken: 'lc2',
      now: 3,
      outcome: 'deferred',
      cursor: null,
      nextAttemptAt: 3,
    })
    expect(await rowOf(harness.db, 'cursor-run')).toMatchObject({ cursorJson: null, sliceNo: 2 })
    const claimedAgain = await store.claimNext({ leaseToken: 'lc3', now: 3, leaseMs: 100 })
    expect(claimedAgain?.row.id).toBe('cursor-run')
    await store.settle({ runId: 'cursor-run', leaseToken: 'lc3', now: 4, outcome: 'succeeded' })
    expect(await rowOf(harness.db, 'cursor-run')).toMatchObject({
      cursorJson: null,
      countersJson: '{}',
      sliceNo: 3,
      attempt: 3,
    })
  })

  test('recoverRunning 一次恢复多个 running job，返回恢复条数', async () => {
    const store = storeFor(harness.db)
    for (const [id, jobKey] of [
      ['a', 'tokenAuditGc'],
      ['b', 'eventsArchive'],
      ['c', 'lifecycleInvariants'],
    ] as const) {
      await store.enqueue({
        id,
        jobKey,
        jobClass: jobKey === 'lifecycleInvariants' ? 'recovery' : 'cleanup',
        slotKey: `m:${id}`,
        payload: {},
        scheduledAt: 0,
        now: 0,
      })
      await store.claimNext({ leaseToken: `lease-${id}`, now: 1, leaseMs: 1_000 })
    }
    expect(await store.recoverRunning(9)).toBe(3)
    for (const id of ['a', 'b', 'c']) {
      expect(await rowOf(harness.db, id)).toMatchObject({
        state: 'deferred',
        errorCode: 'worker-restarted',
      })
    }
  })

  test('「同一 job 只允许一条在排队」由数据库唯一索引兜底（两个引擎都必须有它）', async () => {
    const store = storeFor(harness.db)
    await store.enqueue({
      id: 'queued-1',
      jobKey: 'tokenAuditGc',
      jobClass: 'cleanup',
      slotKey: 'u:1',
      payload: {},
      scheduledAt: 0,
      now: 0,
    })
    // 绕开 store 直接插第二条排队行：只有部分唯一索引才拦得住它。
    const direct = harness.db.insert(maintenanceRuns).values({
      id: 'queued-2',
      jobKey: 'tokenAuditGc',
      jobClass: 'cleanup',
      slotKey: 'u:2',
      state: 'pending',
      payloadJson: '{}',
      scheduledAt: 0,
      createdAt: 0,
      updatedAt: 0,
    })
    let thrown: unknown
    try {
      await direct
    } catch (error) {
      thrown = error
    }
    expect(thrown, '第二条 pending 行竟然插进去了：one-queued 部分唯一索引缺失').toBeDefined()
    expect(harness.capabilities.classifyError(thrown)).toBe('unique-violation')
  })
})

describeEachProvider('RFC-359 W8 —— 状态投影与读面', (harness) => {
  test('空库的投影与读', async () => {
    const store = storeFor(harness.db)
    expect(await store.read('missing')).toBeNull()
    expect(await store.readProjection()).toEqual({ active: null, last: null, backlog: [] })
  })

  test('投影分出 active / last / backlog，且 NULL 时间戳不抢占排序', async () => {
    const store = storeFor(harness.db)
    // 已完成一轮的 job：留下 finishedAt 的终态行。
    await store.enqueue({
      id: 'done-old',
      jobKey: 'tokenAuditGc',
      jobClass: 'cleanup',
      slotKey: 'done:1',
      payload: {},
      scheduledAt: 0,
      now: 0,
    })
    await store.claimNext({ leaseToken: 'l1', now: 1, leaseMs: 100 })
    await store.settle({ runId: 'done-old', leaseToken: 'l1', now: 2, outcome: 'succeeded' })
    await store.enqueue({
      id: 'done-new',
      jobKey: 'tokenAuditGc',
      jobClass: 'cleanup',
      slotKey: 'done:2',
      payload: {},
      scheduledAt: 3,
      now: 3,
    })
    await store.claimNext({ leaseToken: 'l2', now: 4, leaseMs: 100 })
    await store.settle({ runId: 'done-new', leaseToken: 'l2', now: 5, outcome: 'succeeded' })

    // 正在跑的 job。
    await store.enqueue({
      id: 'running',
      jobKey: 'eventsArchive',
      jobClass: 'cleanup',
      slotKey: 'run:1',
      payload: {},
      scheduledAt: 6,
      now: 6,
    })
    await store.claimNext({ leaseToken: 'l3', now: 7, leaseMs: 1_000 })

    // 还在排队的 job（startedAt / finishedAt 都是 NULL）。
    await store.enqueue({
      id: 'queued',
      jobKey: 'lifecycleInvariants',
      jobClass: 'recovery',
      slotKey: 'q:1',
      payload: {},
      scheduledAt: 8,
      now: 8,
    })

    const projection = await store.readProjection()
    expect(projection.active?.id).toBe('running')
    expect(projection.last?.id).toBe('done-new')
    expect(projection.backlog.map((row) => row.id)).toEqual(['queued'])
  })

  test('NULL 时间戳排最后：active / last 不会被没开工 / 没收工的行抢走', async () => {
    // 端口自己造不出这种行（claimNext 必写 startedAt、settle 必写 finishedAt），但逻辑复制 /
    // 恢复出来的库里有。两个引擎的 `ORDER BY ... DESC` 默认**正好相反**（SQLite NULL 最后、
    // PostgreSQL NULL 最前），所以这条判据锁的是「合一后的实现必须按 SQLite 语义显式写 NULL 落位」——
    // 写成裸 `desc(...)` 会让 PostgreSQL 把 NULL 那行选成 active / last。
    const store = storeFor(harness.db)
    await harness.db.insert(maintenanceRuns).values([
      {
        id: 'running-null-start',
        jobKey: 'tokenAuditGc',
        jobClass: 'cleanup',
        slotKey: 'n:1',
        state: 'running',
        payloadJson: '{}',
        leaseToken: 'tok-1',
        leaseExpiresAt: 9_999,
        scheduledAt: 0,
        createdAt: 0,
        updatedAt: 0,
        startedAt: null,
      },
      {
        id: 'running-with-start',
        jobKey: 'eventsArchive',
        jobClass: 'cleanup',
        slotKey: 'n:2',
        state: 'running',
        payloadJson: '{}',
        leaseToken: 'tok-2',
        leaseExpiresAt: 9_999,
        scheduledAt: 0,
        createdAt: 1,
        updatedAt: 1,
        startedAt: 5,
      },
      {
        id: 'done-null-finish',
        jobKey: 'lifecycleInvariants',
        jobClass: 'recovery',
        slotKey: 'n:3',
        state: 'succeeded',
        payloadJson: '{}',
        scheduledAt: 0,
        createdAt: 2,
        updatedAt: 2,
        finishedAt: null,
      },
      {
        id: 'done-with-finish',
        jobKey: 'walCheckpoint',
        jobClass: 'checkpoint',
        slotKey: 'n:4',
        state: 'succeeded',
        payloadJson: '{}',
        scheduledAt: 0,
        createdAt: 3,
        updatedAt: 3,
        finishedAt: 7,
      },
    ])

    const projection = await store.readProjection()
    expect(projection.active?.id).toBe('running-with-start')
    expect(projection.last?.id).toBe('done-with-finish')
  })

  test('backlog 收 pending / deferred / failed，按 createdAt 升序', async () => {
    const store = storeFor(harness.db)
    await store.enqueue({
      id: 'failed-run',
      jobKey: 'tokenAuditGc',
      jobClass: 'cleanup',
      slotKey: 'f:1',
      payload: {},
      scheduledAt: 0,
      now: 0,
    })
    await store.claimNext({ leaseToken: 'lf', now: 1, leaseMs: 100 })
    await store.settle({
      runId: 'failed-run',
      leaseToken: 'lf',
      now: 2,
      outcome: 'failed',
      errorCode: 'boom',
      errorMessage: 'exploded',
    })
    await store.enqueue({
      id: 'deferred-run',
      jobKey: 'eventsArchive',
      jobClass: 'cleanup',
      slotKey: 'd:1',
      payload: {},
      scheduledAt: 3,
      now: 3,
    })
    await store.claimNext({ leaseToken: 'ld', now: 4, leaseMs: 100 })
    await store.settle({
      runId: 'deferred-run',
      leaseToken: 'ld',
      now: 5,
      outcome: 'deferred',
      nextAttemptAt: 500,
    })
    await store.enqueue({
      id: 'pending-run',
      jobKey: 'lifecycleInvariants',
      jobClass: 'recovery',
      slotKey: 'p:1',
      payload: {},
      scheduledAt: 6,
      now: 6,
    })

    const projection = await store.readProjection()
    expect(projection.backlog.map((row) => row.id)).toEqual([
      'failed-run',
      'deferred-run',
      'pending-run',
    ])
    expect(projection.last?.id).toBe('failed-run')
    expect(projection.active).toBeNull()
    expect(await store.read('failed-run')).toMatchObject({
      state: 'failed',
      errorCode: 'boom',
      errorMessage: 'exploded',
    })
  })
})
