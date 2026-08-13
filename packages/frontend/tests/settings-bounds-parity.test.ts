// Locks the Settings numeric contract in both directions: every editable
// numeric field must use the shared adapter, and every shared bound must be
// enforced by the Config PATCH schema. Full Config remains legacy-compatible;
// only new writes are constrained.
import {
  ConfigPatchSchema,
  RUNTIME_NUMERIC_BOUNDS,
  SETTINGS_NUMERIC_BOUNDS,
  type SettingsNumericPath,
} from '@agent-workflow/shared'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SETTINGS_SOURCE = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'settings.tsx'),
  'utf8',
)
const RUNTIME_SOURCE = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'components', 'RuntimeList.tsx'),
  'utf8',
)

function patchFor(path: SettingsNumericPath, value: number): unknown {
  switch (path) {
    case 'submoduleAutoRefresh.intervalMs':
      return { submoduleAutoRefresh: { enabled: true, intervalMs: value } }
    case 'submoduleAutoRefresh.onlyRecentDays':
      return { submoduleAutoRefresh: { enabled: true, onlyRecentDays: value } }
    case 'worktreeAutoGc.olderThanDays':
      return { worktreeAutoGc: { enabled: false, olderThanDays: value } }
    case 'eventsArchiveThresholds.perNodeRunRows':
      return { eventsArchiveThresholds: { perNodeRunRows: value, globalRows: 1_000_000 } }
    case 'eventsArchiveThresholds.globalRows':
      return { eventsArchiveThresholds: { perNodeRunRows: 50_000, globalRows: value } }
    default:
      return { [path]: value }
  }
}

describe('Settings numeric bounds parity', () => {
  test('all 25 Config-backed numeric controls use the shared adapter exactly once', () => {
    expect(SETTINGS_SOURCE).not.toMatch(/<NumberInput\b/)
    expect(Object.keys(SETTINGS_NUMERIC_BOUNDS)).toHaveLength(25)
    for (const path of Object.keys(SETTINGS_NUMERIC_BOUNDS) as SettingsNumericPath[]) {
      const matches = SETTINGS_SOURCE.match(
        new RegExp(`setting="${path.replaceAll('.', '\\.')}"`, 'g'),
      )
      expect(matches, `${path} must own exactly one SettingsNumberInput`).toHaveLength(1)
    }
  })

  test('all three runtime numeric controls use the same adapter', () => {
    expect(RUNTIME_SOURCE).not.toMatch(/<NumberInput\b/)
    for (const path of Object.keys(RUNTIME_NUMERIC_BOUNDS)) {
      expect(RUNTIME_SOURCE.match(new RegExp(`setting="${path}"`, 'g'))).toHaveLength(1)
    }
  })

  test.each(
    Object.entries(SETTINGS_NUMERIC_BOUNDS) as Array<
      [SettingsNumericPath, (typeof SETTINGS_NUMERIC_BOUNDS)[SettingsNumericPath]]
    >,
  )('%s accepts its edges and rejects values outside them', (path, bound) => {
    expect(ConfigPatchSchema.safeParse(patchFor(path, bound.min)).success).toBe(true)
    expect(ConfigPatchSchema.safeParse(patchFor(path, bound.max)).success).toBe(true)
    expect(ConfigPatchSchema.safeParse(patchFor(path, bound.max + 1)).success).toBe(false)
    if ('positiveMin' in bound) {
      expect(ConfigPatchSchema.safeParse(patchFor(path, bound.positiveMin)).success).toBe(true)
      expect(ConfigPatchSchema.safeParse(patchFor(path, bound.positiveMin - 1)).success).toBe(false)
    } else {
      expect(ConfigPatchSchema.safeParse(patchFor(path, bound.min - 1)).success).toBe(false)
    }
  })
})
