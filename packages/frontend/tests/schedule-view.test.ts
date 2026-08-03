// RFC-159 — pure schedule-view helpers (preview + summary).
import { describe, expect, test } from 'vitest'
import type { ScheduleSpec } from '@agent-workflow/shared'

import { nextRuns, scheduleRunNowEligibility, scheduleSummary } from '../src/lib/schedule-view'

const HOUR = 3_600_000

describe('nextRuns', () => {
  test('interval: N evenly-spaced slots from the anchor', () => {
    const spec: ScheduleSpec = { kind: 'interval', every: 6, unit: 'hours' }
    expect(nextRuns(spec, 0, 3)).toEqual([6 * HOUR, 12 * HOUR, 18 * HOUR])
  })

  test('daily: three consecutive 09:00 UTC instants, strictly increasing and future', () => {
    const spec: ScheduleSpec = { kind: 'daily', at: '09:00', timezone: 'UTC' }
    const from = Date.UTC(2026, 0, 15, 13, 0, 0) // after 09:00 → first is tomorrow
    const runs = nextRuns(spec, from, 3)
    expect(runs).toHaveLength(3)
    expect(runs[0]).toBeGreaterThan(from)
    expect(runs[1]! - runs[0]!).toBe(24 * HOUR)
    expect(runs[2]! - runs[1]!).toBe(24 * HOUR)
  })
})

describe('scheduleSummary', () => {
  test('interval', () => {
    const spec: ScheduleSpec = { kind: 'interval', every: 6, unit: 'hours' }
    expect(scheduleSummary(spec, 'en')).toBe('every 6 hours')
    expect(scheduleSummary(spec, 'zh')).toBe('每隔 6 小时')
  })

  test('daily includes the timezone', () => {
    const spec: ScheduleSpec = { kind: 'daily', at: '09:00', timezone: 'Asia/Shanghai' }
    expect(scheduleSummary(spec, 'en')).toBe('daily at 09:00 (Asia/Shanghai)')
    expect(scheduleSummary(spec, 'zh')).toBe('每天 09:00（Asia/Shanghai）')
  })

  test('weekly lists the selected days', () => {
    const spec: ScheduleSpec = { kind: 'weekly', daysOfWeek: [1, 4], at: '08:30', timezone: 'UTC' }
    expect(scheduleSummary(spec, 'en')).toBe('weekly on Mon, Thu at 08:30 (UTC)')
    expect(scheduleSummary(spec, 'zh')).toBe('每周 周一、周四 08:30（UTC）')
  })

  test('monthly', () => {
    const spec: ScheduleSpec = { kind: 'monthly', dayOfMonth: 15, at: '23:59', timezone: 'UTC' }
    expect(scheduleSummary(spec, 'en')).toBe('monthly on day 15 at 23:59 (UTC)')
    expect(scheduleSummary(spec, 'zh')).toBe('每月 15 号 23:59（UTC）')
  })
})

describe('RFC-250 scheduleRunNowEligibility', () => {
  const runnable = {
    migrationNeeded: false,
    launchPayload: { workflowId: 'wf-1' },
    scheduleSpec: { kind: 'daily', at: '09:00', timezone: 'UTC' } as ScheduleSpec,
  }

  test('returns one stable reason for each structurally degraded state', () => {
    expect(scheduleRunNowEligibility({ ...runnable, migrationNeeded: true })).toEqual({
      allowed: false,
      reason: 'migration-needed',
    })
    expect(scheduleRunNowEligibility({ ...runnable, launchPayload: null })).toEqual({
      allowed: false,
      reason: 'payload-missing',
    })
    expect(scheduleRunNowEligibility({ ...runnable, scheduleSpec: null })).toEqual({
      allowed: false,
      reason: 'spec-missing',
    })
  })

  test('enabled state and historical launch failure do not affect manual-run eligibility', () => {
    expect(
      scheduleRunNowEligibility({
        ...runnable,
        enabled: false,
        lastStatus: 'failed',
        lastError: 'previous launch failed',
      }),
    ).toEqual({ allowed: true })
  })
})
