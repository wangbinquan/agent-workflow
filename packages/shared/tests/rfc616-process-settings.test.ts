// RFC-616 §9.4 — the two settings of process metrics' text-theme analysis.
//
// `processInsightRuntime` names the runtime the analysis runs on (unset: the
// default runtime); `processInsightSchedule` is `manual` or `weekly` (unset:
// manual). Both are optional in the stored configuration and can be cleared
// with null in a patch, like the other internal-agent runtime settings.

import { describe, expect, test } from 'bun:test'

import { ConfigPatchSchema, ConfigSchema, DEFAULT_CONFIG } from '../src/schemas/config.js'
import { PROCESS_INSIGHT_SCHEDULES } from '../src/schemas/processMetrics.js'

describe('RFC-616 process insight settings', () => {
  test('a fresh configuration has neither: the analysis is manual and uses the default runtime', () => {
    expect(DEFAULT_CONFIG.processInsightRuntime).toBeUndefined()
    expect(DEFAULT_CONFIG.processInsightSchedule).toBeUndefined()
    const parsed = ConfigSchema.parse(DEFAULT_CONFIG)
    expect(parsed.processInsightRuntime).toBeUndefined()
    expect(parsed.processInsightSchedule).toBeUndefined()
  })

  test('the stored configuration accepts a runtime name and either schedule', () => {
    for (const schedule of PROCESS_INSIGHT_SCHEDULES) {
      const parsed = ConfigSchema.parse({
        ...DEFAULT_CONFIG,
        processInsightRuntime: 'analysis',
        processInsightSchedule: schedule,
      })
      expect([parsed.processInsightRuntime, parsed.processInsightSchedule]).toEqual([
        'analysis',
        schedule,
      ])
    }
    expect(PROCESS_INSIGHT_SCHEDULES).toEqual(['manual', 'weekly'])
  })

  test('a patch sets, clears with null, and rejects what is not a schedule or a name', () => {
    expect(
      ConfigPatchSchema.parse({
        processInsightRuntime: 'analysis',
        processInsightSchedule: 'weekly',
      }),
    ).toMatchObject({ processInsightRuntime: 'analysis', processInsightSchedule: 'weekly' })
    const cleared = ConfigPatchSchema.parse({
      processInsightRuntime: null,
      processInsightSchedule: null,
    }) as Record<string, unknown>
    expect([cleared.processInsightRuntime, cleared.processInsightSchedule]).toEqual([null, null])
    expect(() => ConfigPatchSchema.parse({ processInsightRuntime: '' })).toThrow()
    expect(() => ConfigPatchSchema.parse({ processInsightSchedule: 'daily' })).toThrow()
    expect(() =>
      ConfigSchema.parse({ ...DEFAULT_CONFIG, processInsightSchedule: 'daily' }),
    ).toThrow()
  })
})
