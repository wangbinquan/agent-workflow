import { describe, expect, test } from 'bun:test'

import { MAINTENANCE_PHASE } from '@/services/daemonCadence'
import { HEAVY_MAINTENANCE_JOB_KEYS } from '@/platform/background/maintenanceCatalog'
import {
  dailyCleanupSlot,
  hourlyCleanupSlot,
  latestDueDailyCleanupSlot,
  nextDailyCleanupSlot,
  nextHourlyCleanupSlot,
  startMaintenanceScheduleCoordinator,
} from '@/platform/background/maintenanceSchedule'

describe('RFC-338 cleanup slot calculation', () => {
  test('hourly slots preserve every RFC-322 phase on a stable epoch grid', () => {
    const hour = Date.UTC(2026, 7, 28, 1, 0, 0)
    for (const [job, phase] of Object.entries(MAINTENANCE_PHASE)) {
      if (job === 'batchImportGc' || job === 'lifecycleInvariants') continue
      const next = nextHourlyCleanupSlot(job as Parameters<typeof nextHourlyCleanupSlot>[0], hour)
      expect(next.scheduledAt).toBe(hour + phase)
      expect(
        hourlyCleanupSlot(job as Parameters<typeof hourlyCleanupSlot>[0], next.scheduledAt),
      ).toEqual(next)
    }
  })

  test('daily slots use local dates at 00:00 and 23:59', () => {
    const now = Date.UTC(2026, 7, 28, 10, 0, 0) // 18:00 Asia/Shanghai
    expect(
      dailyCleanupSlot({ kind: 'daily', at: '00:00', timezone: 'Asia/Shanghai' }, now),
    ).toEqual({
      scheduledAt: Date.UTC(2026, 7, 27, 16, 0, 0),
      slotKey: 'daily:2026-08-28',
      cycleKey: 'daily:2026-08-28',
    })
    expect(
      nextDailyCleanupSlot({ kind: 'daily', at: '23:59', timezone: 'Asia/Shanghai' }, now),
    ).toEqual({
      scheduledAt: Date.UTC(2026, 7, 28, 15, 59, 0),
      slotKey: 'daily:2026-08-28',
      cycleKey: 'daily:2026-08-28',
    })
  })

  test("boot catch-up before today's wall-clock slot uses only the latest prior local date", () => {
    const now = Date.UTC(2026, 7, 28, 0, 30)
    expect(latestDueDailyCleanupSlot({ kind: 'daily', at: '03:00', timezone: 'UTC' }, now)).toEqual(
      {
        scheduledAt: Date.UTC(2026, 7, 27, 3, 0),
        slotKey: 'daily:2026-08-27',
        cycleKey: 'daily:2026-08-27',
      },
    )
  })

  test('daily slot inherits DST gap and overlap semantics from the shared clock', () => {
    const timezone = 'America/New_York'
    const gapNow = Date.UTC(2026, 2, 8, 5, 0, 0)
    expect(nextDailyCleanupSlot({ kind: 'daily', at: '02:30', timezone }, gapNow).scheduledAt).toBe(
      Date.UTC(2026, 2, 8, 7, 0, 0),
    )
    const overlapNow = Date.UTC(2026, 10, 1, 4, 0, 0)
    expect(
      nextDailyCleanupSlot({ kind: 'daily', at: '01:30', timezone }, overlapNow).scheduledAt,
    ).toBe(Date.UTC(2026, 10, 1, 5, 30, 0))
  })

  test('daily slots keep the same DST policy in the southern hemisphere and cross leap day', () => {
    const timezone = 'Australia/Sydney'
    const gapNow = Date.UTC(2026, 9, 3, 14, 0, 0)
    expect(nextDailyCleanupSlot({ kind: 'daily', at: '02:30', timezone }, gapNow).scheduledAt).toBe(
      Date.UTC(2026, 9, 3, 16, 0, 0),
    )
    const overlapNow = Date.UTC(2026, 3, 4, 14, 0, 0)
    expect(
      nextDailyCleanupSlot({ kind: 'daily', at: '02:30', timezone }, overlapNow).scheduledAt,
    ).toBe(Date.UTC(2026, 3, 4, 15, 30, 0))

    expect(
      nextDailyCleanupSlot(
        { kind: 'daily', at: '02:00', timezone: 'UTC' },
        Date.UTC(2028, 1, 28, 23, 0, 0),
      ),
    ).toEqual({
      scheduledAt: Date.UTC(2028, 1, 29, 2, 0, 0),
      slotKey: 'daily:2028-02-29',
      cycleKey: 'daily:2028-02-29',
    })
  })

  test('daily catch-up re-admits every exact job slot so a partial cycle can heal', () => {
    const callbacks: Array<{ fn: () => void; delay: number }> = []
    const admitted: string[] = []
    const now = Date.UTC(2026, 7, 28, 10, 0, 0)
    const coordinator = startMaintenanceScheduleCoordinator({
      schedule: () => ({ kind: 'daily', at: '01:00', timezone: 'UTC' }),
      admit: ({ job }) => admitted.push(job),
      now: () => now,
      catchUpDelayMs: 0,
      timers: {
        setTimeout(fn, delay) {
          callbacks.push({ fn, delay })
          return callbacks.length
        },
        clearTimeout() {},
      },
    })

    callbacks.find(({ delay }) => delay === 0)?.fn()
    expect(admitted).toEqual([...HEAVY_MAINTENANCE_JOB_KEYS])
    coordinator.stop()
  })

  test('hot reconfiguration starts at the next slot and does not enqueue a historical cycle', () => {
    const callbacks: Array<{ fn: () => void; delay: number }> = []
    const admitted: string[] = []
    let schedule: { kind: 'daily'; at: string; timezone: string } = {
      kind: 'daily',
      at: '01:00',
      timezone: 'UTC',
    }
    const now = Date.UTC(2026, 7, 28, 10, 0, 0)
    const coordinator = startMaintenanceScheduleCoordinator({
      schedule: () => schedule,
      admit: ({ job }) => admitted.push(job),
      now: () => now,
      catchUpDelayMs: 0,
      timers: {
        setTimeout(fn, delay) {
          callbacks.push({ fn, delay })
          return callbacks.length
        },
        clearTimeout() {},
      },
    })

    schedule = { kind: 'daily', at: '02:00', timezone: 'UTC' }
    coordinator.reconfigure()
    for (const callback of callbacks.filter(({ delay }) => delay === 0)) callback.fn()
    expect(admitted).toEqual([])
    expect(coordinator.nextRunAt()).toBe(Date.UTC(2026, 7, 29, 2, 0))
    coordinator.stop()
  })

  test('hourly next-run projection advances after the earliest phased job fires', () => {
    const callbacks: Array<{ fn: () => void; delay: number }> = []
    let now = Date.UTC(2026, 7, 28, 1, 0, 0)
    const coordinator = startMaintenanceScheduleCoordinator({
      schedule: () => ({ kind: 'hourly' }),
      admit() {},
      now: () => now,
      timers: {
        setTimeout(fn, delay) {
          callbacks.push({ fn, delay })
          return callbacks.length
        },
        clearTimeout() {},
      },
    })

    expect(coordinator.nextRunAt()).toBe(now + MAINTENANCE_PHASE.worktreeGc)
    const first = callbacks.find(({ delay }) => delay === MAINTENANCE_PHASE.worktreeGc)
    expect(first).toBeDefined()
    now += MAINTENANCE_PHASE.worktreeGc
    first?.fn()
    expect(coordinator.nextRunAt()).toBe(
      Date.UTC(2026, 7, 28, 1, 0, 0) + MAINTENANCE_PHASE.webhookDeliveryGc,
    )
    coordinator.stop()
  })

  test('fired timer handles are forgotten instead of accumulating for daemon lifetime', () => {
    const callbacks: Array<{ id: number; fn: () => void; delay: number }> = []
    const cleared: number[] = []
    const now = Date.UTC(2026, 7, 28, 10, 0, 0)
    const coordinator = startMaintenanceScheduleCoordinator({
      schedule: () => ({ kind: 'daily', at: '11:00', timezone: 'UTC' }),
      admit() {},
      now: () => now,
      catchUpDelayMs: 0,
      timers: {
        setTimeout(fn, delay) {
          const id = callbacks.length + 1
          callbacks.push({ id, fn, delay })
          return id
        },
        clearTimeout(handle) {
          cleared.push(handle as number)
        },
      },
    })
    const fired = callbacks.find(({ delay }) => delay === 0)!
    fired.fn()
    coordinator.stop()
    expect(cleared).not.toContain(fired.id)
    expect(cleared.length).toBeGreaterThan(0)
  })
})
