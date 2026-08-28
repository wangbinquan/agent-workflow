import { describe, expect, test } from 'bun:test'

import {
  ConfigPatchSchema,
  ConfigSchema,
  DEFAULT_CONFIG,
  MaintenanceScheduleSchema,
} from '../src/index'

describe('RFC-338 maintenance schedule contract', () => {
  test('old config snapshots and DEFAULT_CONFIG remain hourly', () => {
    const { maintenanceSchedule: _removed, ...oldConfig } = DEFAULT_CONFIG
    expect(ConfigSchema.parse(oldConfig).maintenanceSchedule).toEqual({ kind: 'hourly' })
    expect(DEFAULT_CONFIG.maintenanceSchedule).toEqual({ kind: 'hourly' })
  })

  test('accepts an explicit daily IANA wall-clock schedule', () => {
    const schedule = { kind: 'daily', at: '02:30', timezone: 'Asia/Shanghai' } as const
    expect(MaintenanceScheduleSchema.parse(schedule)).toEqual(schedule)
    expect(ConfigPatchSchema.parse({ maintenanceSchedule: schedule })).toEqual({
      maintenanceSchedule: schedule,
    })
  })

  test('rejects invalid wall-clock values and invalid timezones', () => {
    expect(
      MaintenanceScheduleSchema.safeParse({ kind: 'daily', at: '24:00', timezone: 'UTC' }).success,
    ).toBe(false)
    expect(
      MaintenanceScheduleSchema.safeParse({
        kind: 'daily',
        at: '23:59',
        timezone: 'Not/A_Timezone',
      }).success,
    ).toBe(false)
  })
})
