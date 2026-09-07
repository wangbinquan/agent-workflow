// RFC-338 的耐久准入 / 租约状态机回归锁（SQLite 形态）。
//
// RFC-359 W8 起端口是异步的、实现两个 provider 共用（`platform/persistence/maintenanceRunStore.ts`），
// 所以这里的调用都加了 await。**双引擎的行为判据在
// `rfc359-w8-maintenance-run-store-conformance.test.ts`**，本文件保留 RFC-338 当初立下的那几条
// 具名回归（同槽去重 / 认领优先级 / 一次只排一个后继槽 / 崩溃恢复吸收补课 / deferred 重排期）。

import { describe, expect, test } from 'bun:test'

import { createInMemoryDb } from '@/db/client'
import { createMaintenanceRunStore } from '@/platform/persistence/maintenanceRunStore'
import { MIGRATIONS } from './migration-freeze'

describe('RFC-338 durable maintenance run store', () => {
  test('deduplicates an exact slot and coalesces a later slot while one run is outstanding', async () => {
    const store = createMaintenanceRunStore(createInMemoryDb(MIGRATIONS))
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

    expect(first.inserted).toBe(true)
    expect(duplicate.row.id).toBe('run-1')
    expect(nextSlot).toMatchObject({ inserted: false, coalesced: true })
    expect(nextSlot.row.id).toBe('run-1')
  })

  test('claims recovery ahead of cleanup and fences late lease receipts', async () => {
    const store = createMaintenanceRunStore(createInMemoryDb(MIGRATIONS))
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
    expect(
      await store.heartbeat({ runId: 'recovery', leaseToken: 'wrong', now: 20, leaseMs: 50 }),
    ).toBe(false)
    expect(
      await store.settle({
        runId: 'recovery',
        leaseToken: 'lease-a',
        now: 30,
        outcome: 'succeeded',
        counters: { scanned: 4 },
      }),
    ).toBe(true)
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
    })
  })

  test('keeps one durable next slot while the same job is running and coalesces later slots', async () => {
    const store = createMaintenanceRunStore(createInMemoryDb(MIGRATIONS))
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

  test('a recovered running lease becomes claimable with a new token', async () => {
    // RFC-359 W8：此前这条用的是 `recoverExpired`（只恢复 leaseExpiresAt 已过的行）。
    // 那个方法**生产从来没有调用过**，随合一删除；租约过期仍由 Worker 启动时的
    // `recoverRunning` 兜住，判据因此改打在同一条恢复路径上。
    const store = createMaintenanceRunStore(createInMemoryDb(MIGRATIONS))
    await store.enqueue({
      id: 'run-expired',
      jobKey: 'walCheckpoint',
      jobClass: 'checkpoint',
      slotKey: 'checkpoint:1',
      payload: {},
      scheduledAt: 0,
      now: 0,
    })
    expect((await store.claimNext({ leaseToken: 'old', now: 10, leaseMs: 20 }))?.row.id).toBe(
      'run-expired',
    )
    expect(await store.recoverRunning(31)).toBe(1)
    const reclaimed = await store.claimNext({ leaseToken: 'new', now: 31, leaseMs: 20 })
    expect(reclaimed?.row).toMatchObject({ id: 'run-expired', attempt: 2, state: 'running' })
    expect(reclaimed?.leaseToken).toBe('new')
  })

  test('crash recovery atomically absorbs a queued future slot before resuming the cursor', async () => {
    const store = createMaintenanceRunStore(createInMemoryDb(MIGRATIONS))
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
    expect(await store.read('restart-next')).toBeNull()
    expect(await store.read('restart-current')).toMatchObject({
      state: 'deferred',
      errorCode: 'worker-restarted',
    })
  })

  test('a busy running slice absorbs its queued catch-up before becoming deferred', async () => {
    const store = createMaintenanceRunStore(createInMemoryDb(MIGRATIONS))
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
        nextAttemptAt: 50,
      }),
    ).toBe(true)
    expect(await store.read('busy-next')).toBeNull()
    expect(await store.read('busy-current')).toMatchObject({
      state: 'deferred',
      scheduledAt: 50,
    })
    expect(await store.claimNext({ leaseToken: 'early', now: 49, leaseMs: 100 })).toBeNull()
    expect((await store.claimNext({ leaseToken: 'retry', now: 50, leaseMs: 100 }))?.row.id).toBe(
      'busy-current',
    )
  })
})
