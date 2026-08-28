// RFC-338: a 50 ms admission connection must never silently lose a cleanup
// slot when a foreground SQLite writer temporarily owns the WAL writer lock.

import { describe, expect, test } from 'bun:test'

import { createMaintenanceAdmissionController } from '@/platform/background/maintenanceService'
import type {
  MaintenanceRunRow,
  MaintenanceRunStore,
} from '@/platform/persistence/sqlite/maintenanceRunStore'

function receipt(): ReturnType<MaintenanceRunStore['enqueue']> {
  return {
    row: {} as MaintenanceRunRow,
    inserted: true,
    coalesced: false,
  }
}

describe('RFC-338 maintenance admission', () => {
  test('retries SQLITE_BUSY off-thread and keeps one chain per exact slot', () => {
    const callbacks: Array<() => void> = []
    let enqueueCalls = 0
    let payloadCalls = 0
    let wakes = 0
    const controller = createMaintenanceAdmissionController({
      store: {
        enqueue() {
          enqueueCalls += 1
          if (enqueueCalls === 1) {
            const error = new Error('database is locked') as Error & { code: string }
            error.code = 'SQLITE_BUSY'
            throw error
          }
          return receipt()
        },
      },
      payloadFor: () => {
        payloadCalls += 1
        return { retentionDays: 90 }
      },
      wake: () => {
        wakes += 1
      },
      timers: {
        setTimeout(fn) {
          callbacks.push(fn)
          return { unref() {} } as ReturnType<typeof setTimeout>
        },
        clearTimeout() {},
      },
    })
    const input = {
      job: 'tokenAuditGc' as const,
      jobClass: 'cleanup' as const,
      slot: { scheduledAt: 100, slotKey: 'hourly:100', cycleKey: 'hourly:0' },
    }

    controller.admit(input)
    controller.admit(input)
    expect({ enqueueCalls, payloadCalls, wakes, retries: callbacks.length }).toEqual({
      enqueueCalls: 1,
      payloadCalls: 1,
      wakes: 0,
      retries: 1,
    })

    callbacks.shift()?.()
    expect({ enqueueCalls, payloadCalls, wakes }).toEqual({
      enqueueCalls: 2,
      payloadCalls: 1,
      wakes: 1,
    })
    controller.stop()
  })

  test('does not retry a non-contention admission failure', () => {
    const callbacks: Array<() => void> = []
    const failures: unknown[] = []
    const controller = createMaintenanceAdmissionController({
      store: {
        enqueue() {
          throw new Error('invalid ledger row')
        },
      },
      payloadFor: () => ({}),
      wake() {},
      onFailed: ({ error }) => failures.push(error),
      timers: {
        setTimeout(fn) {
          callbacks.push(fn)
          return { unref() {} } as ReturnType<typeof setTimeout>
        },
        clearTimeout() {},
      },
    })

    controller.admit({
      job: 'walCheckpoint',
      jobClass: 'checkpoint',
      slot: { scheduledAt: 100, slotKey: 'checkpoint:100', cycleKey: 'checkpoint:1' },
    })
    expect(callbacks).toHaveLength(0)
    expect(failures).toHaveLength(1)
    controller.stop()
  })
})
