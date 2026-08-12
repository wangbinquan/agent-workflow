// Locks RFC-290: settings.tsx literals and the shared zod schemas are still
// duplicate truths by explicit scope decision. If either side changes alone,
// this test must fail. Both ConfigSchema and the actual PATCH save gate are
// probed because nullable intent fields are redeclared in ConfigPatchSchema.
import { ConfigPatchSchema, ConfigSchema, DEFAULT_CONFIG } from '@agent-workflow/shared'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SETTINGS = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'settings.tsx'),
  'utf8',
)
const NUMBER_INPUT_TAGS = SETTINGS.match(/<NumberInput\b[\s\S]*?\/>/g) ?? []

const BOUNDED_SETTINGS = [
  { key: 'gitSubmoduleJobs', min: 1, max: 32 },
  { key: 'webhookDeliveryBodyRetentionDays', min: 1, max: 3650 },
  { key: 'webhookDeliveryRowRetentionDays', min: 1, max: 3650 },
  { key: 'bindPort', min: 0, max: 65_535 },
  { key: 'commitPushMaxRepairRetries', min: 0, max: 10 },
  { key: 'commitPushDiffMaxBytes', min: 0, max: 262_144 },
  { key: 'intentBuilderTurnTimeoutMs', min: 30_000, max: 3_600_000 },
  { key: 'intentBuilderMaxGenerateRounds', min: 1, max: 500 },
] as const

type BoundedKey = (typeof BOUNDED_SETTINGS)[number]['key']

function fullConfigAccepts(key: BoundedKey, value: number): boolean {
  return ConfigSchema.safeParse({ ...DEFAULT_CONFIG, [key]: value }).success
}

function patchAccepts(key: BoundedKey, value: number): boolean {
  return ConfigPatchSchema.safeParse({ [key]: value }).success
}

function inputTagFor(key: BoundedKey): string {
  const matches = NUMBER_INPUT_TAGS.filter((tag) => tag.includes(`state.${key}`))
  expect(matches, `${key} must own exactly one NumberInput`).toHaveLength(1)
  return matches[0]!
}

function numericProp(tag: string, prop: 'min' | 'max'): number {
  const match = tag.match(new RegExp(`\\b${prop}=\\{([\\d_]+)\\}`))
  expect(match, `NumberInput must declare a literal ${prop}`).not.toBeNull()
  return Number(match![1]!.replaceAll('_', ''))
}

describe('RFC-290 bounded settings parity', () => {
  test.each(BOUNDED_SETTINGS)('$key matches full config and PATCH schema behavior', (bound) => {
    for (const [name, accepts] of [
      ['ConfigSchema', fullConfigAccepts],
      ['ConfigPatchSchema', patchAccepts],
    ] as const) {
      expect(accepts(bound.key, bound.min), `${name} must accept ${bound.key} min`).toBe(true)
      expect(accepts(bound.key, bound.max), `${name} must accept ${bound.key} max`).toBe(true)
      expect(accepts(bound.key, bound.min - 1), `${name} must reject below ${bound.key} min`).toBe(
        false,
      )
      expect(accepts(bound.key, bound.max + 1), `${name} must reject above ${bound.key} max`).toBe(
        false,
      )
    }
  })

  test.each(BOUNDED_SETTINGS)('$key renders the same literal min/max in settings.tsx', (bound) => {
    const tag = inputTagFor(bound.key)
    expect(numericProp(tag, 'min')).toBe(bound.min)
    expect(numericProp(tag, 'max')).toBe(bound.max)
  })
})
