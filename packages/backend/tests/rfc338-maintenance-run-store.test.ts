import { describe, expect, test } from 'bun:test'

import { createInMemoryDb } from '@/db/client'
import { createMaintenanceRunStore } from '@/platform/persistence/sqlite/maintenanceRunStore'
import { MIGRATIONS } from './migration-freeze'

describe('RFC-338 durable maintenance run store', () => {
  test('deduplicates an exact slot and coalesces a later slot while one run is outstanding', () => {
    const store = createMaintenanceRunStore(createInMemoryDb(MIGRATIONS))
    const first = store.enqueue({
      id: 'run-1',
      jobKey: 'tokenAuditGc',
      jobClass: 'cleanup',
      slotKey: '2026-08-28T01',
      payload: { retentionDays: 90 },
      scheduledAt: 100,
      now: 100,
    })
    const duplicate = store.enqueue({
      id: 'run-2',
      jobKey: 'tokenAuditGc',
      jobClass: 'cleanup',
      slotKey: '2026-08-28T01',
      payload: { retentionDays: 90 },
      scheduledAt: 100,
      now: 101,
    })
    const nextSlot = store.enqueue({
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

  test('claims recovery ahead of cleanup and fences late lease receipts', () => {
    const store = createMaintenanceRunStore(createInMemoryDb(MIGRATIONS))
    store.enqueue({
      id: 'cleanup',
      jobKey: 'eventsArchive',
      jobClass: 'cleanup',
      slotKey: 'h:1',
      payload: {},
      scheduledAt: 0,
      now: 0,
    })
    store.enqueue({
      id: 'recovery',
      jobKey: 'lifecycleInvariants',
      jobClass: 'recovery',
      slotKey: 'h:1',
      payload: { scope: { all: true } },
      scheduledAt: 0,
      now: 0,
    })

    const claimed = store.claimNext({ leaseToken: 'lease-a', now: 10, leaseMs: 50 })
    expect(claimed?.row.id).toBe('recovery')
    expect(store.heartbeat({ runId: 'recovery', leaseToken: 'wrong', now: 20, leaseMs: 50 })).toBe(
      false,
    )
    expect(
      store.settle({
        runId: 'recovery',
        leaseToken: 'lease-a',
        now: 30,
        outcome: 'succeeded',
        counters: { scanned: 4 },
      }),
    ).toBe(true)
    expect(
      store.settle({
        runId: 'recovery',
        leaseToken: 'lease-a',
        now: 31,
        outcome: 'failed',
      }),
    ).toBe(false)
    expect(store.read('recovery')).toMatchObject({
      state: 'succeeded',
      countersJson: '{"scanned":4}',
    })
  })

  test('keeps one durable next slot while the same job is running and coalesces later slots', () => {
    const store = createMaintenanceRunStore(createInMemoryDb(MIGRATIONS))
    store.enqueue({
      id: 'current',
      jobKey: 'eventsArchive',
      jobClass: 'cleanup',
      slotKey: 'hourly:1',
      payload: {},
      scheduledAt: 0,
      now: 0,
    })
    expect(store.claimNext({ leaseToken: 'lease-current', now: 1, leaseMs: 100 })?.row.id).toBe(
      'current',
    )

    const next = store.enqueue({
      id: 'next',
      jobKey: 'eventsArchive',
      jobClass: 'cleanup',
      slotKey: 'hourly:2',
      payload: {},
      scheduledAt: 2,
      now: 2,
    })
    const later = store.enqueue({
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
      store.settle({
        runId: 'current',
        leaseToken: 'lease-current',
        now: 4,
        outcome: 'succeeded',
      }),
    ).toBe(true)
    expect(store.claimNext({ leaseToken: 'lease-next', now: 4, leaseMs: 100 })?.row.id).toBe('next')
  })

  test('expired running leases become claimable with a new token', () => {
    const store = createMaintenanceRunStore(createInMemoryDb(MIGRATIONS))
    store.enqueue({
      id: 'run-expired',
      jobKey: 'walCheckpoint',
      jobClass: 'checkpoint',
      slotKey: 'checkpoint:1',
      payload: {},
      scheduledAt: 0,
      now: 0,
    })
    expect(store.claimNext({ leaseToken: 'old', now: 10, leaseMs: 20 })?.row.id).toBe('run-expired')
    expect(store.recoverExpired(31)).toBe(1)
    const reclaimed = store.claimNext({ leaseToken: 'new', now: 31, leaseMs: 20 })
    expect(reclaimed?.row).toMatchObject({ id: 'run-expired', attempt: 2, state: 'running' })
    expect(reclaimed?.leaseToken).toBe('new')
  })

  test('crash recovery atomically absorbs a queued future slot before resuming the cursor', () => {
    for (const recovery of ['expired', 'restart'] as const) {
      const store = createMaintenanceRunStore(createInMemoryDb(MIGRATIONS))
      const runId = `${recovery}-current`
      const queuedId = `${recovery}-next`
      store.enqueue({
        id: runId,
        jobKey: 'tokenAuditGc',
        jobClass: 'cleanup',
        slotKey: 'hourly:1',
        payload: { retentionDays: 90 },
        scheduledAt: 0,
        now: 0,
      })
      store.claimNext({ leaseToken: `${recovery}-lease`, now: 1, leaseMs: 10 })
      store.enqueue({
        id: queuedId,
        jobKey: 'tokenAuditGc',
        jobClass: 'cleanup',
        slotKey: 'hourly:2',
        payload: { retentionDays: 90 },
        scheduledAt: 2,
        now: 2,
      })

      expect(recovery === 'expired' ? store.recoverExpired(12) : store.recoverRunning(3)).toBe(1)
      expect(store.read(queuedId)).toBeNull()
      expect(store.read(runId)).toMatchObject({
        state: 'deferred',
        errorCode: recovery === 'expired' ? 'worker-lease-expired' : 'worker-restarted',
      })
    }
  })

  test('a busy running slice absorbs its queued catch-up before becoming deferred', () => {
    const store = createMaintenanceRunStore(createInMemoryDb(MIGRATIONS))
    store.enqueue({
      id: 'busy-current',
      jobKey: 'eventsArchive',
      jobClass: 'cleanup',
      slotKey: 'hourly:1',
      payload: {},
      scheduledAt: 0,
      now: 0,
    })
    store.claimNext({ leaseToken: 'busy-lease', now: 1, leaseMs: 100 })
    store.enqueue({
      id: 'busy-next',
      jobKey: 'eventsArchive',
      jobClass: 'cleanup',
      slotKey: 'hourly:2',
      payload: {},
      scheduledAt: 2,
      now: 2,
    })

    expect(
      store.settle({
        runId: 'busy-current',
        leaseToken: 'busy-lease',
        now: 3,
        outcome: 'deferred',
        nextAttemptAt: 50,
      }),
    ).toBe(true)
    expect(store.read('busy-next')).toBeNull()
    expect(store.read('busy-current')).toMatchObject({ state: 'deferred', scheduledAt: 50 })
    expect(store.claimNext({ leaseToken: 'early', now: 49, leaseMs: 100 })).toBeNull()
    expect(store.claimNext({ leaseToken: 'retry', now: 50, leaseMs: 100 })?.row.id).toBe(
      'busy-current',
    )
  })
})
