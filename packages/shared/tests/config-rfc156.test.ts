// RFC-156 — ConfigPatchSchema must accept `null` for all THREE internal-agent
// runtimes AND their deprecated `*Model` fallbacks, so the "System agents" tab's
// runtime selectors can CLEAR an override (mergePatch deletes the key → inherit
// the global defaultRuntime) and, per D6, clear the paired legacy model in the
// same PUT. The base ConfigSchema stays `min(1)` (null is patch-only = delete);
// an empty string still fails.
//
// mergeAgentRuntime is the load-bearing regression: pre-RFC-156 only
// commitPushRuntime / memoryDistillRuntime were extended to nullable, so the
// (then UI-less) merge agent's "inherit" would 400. The three `*Model` keys are
// D6: resolveInternalAgentRuntime resolves runtimeName → deprecatedModel →
// defaultRuntime, so clearing only the runtime would fall THROUGH to a stale
// legacy model instead of the global default.

import { describe, expect, test } from 'bun:test'

import { ConfigPatchSchema, ConfigSchema, DEFAULT_CONFIG } from '../src/schemas/config.js'

const NULLABLE_PATCH_KEYS = [
  'commitPushRuntime',
  'memoryDistillRuntime',
  'mergeAgentRuntime',
  'commitPushModel',
  'memoryDistillModel',
  'mergeAgentModel',
] as const

describe('RFC-156 ConfigPatchSchema — internal-agent runtime/model nullable in PATCH', () => {
  for (const key of NULLABLE_PATCH_KEYS) {
    test(`${key}: accepts null (clears the override)`, () => {
      const parsed = ConfigPatchSchema.parse({ [key]: null }) as Record<string, unknown>
      expect(parsed[key]).toBeNull()
    })
    test(`${key}: accepts a non-empty string`, () => {
      const parsed = ConfigPatchSchema.parse({ [key]: 'opencode' }) as Record<string, unknown>
      expect(parsed[key]).toBe('opencode')
    })
    test(`${key}: still rejects the empty string (min(1) preserved)`, () => {
      expect(() => ConfigPatchSchema.parse({ [key]: '' })).toThrow()
    })
  }

  test('base ConfigSchema does NOT accept null (null is patch-only)', () => {
    // The full config on disk never holds null for these — null only means
    // "delete this key" on the PATCH wire. Guards against the nullable widening
    // leaking into the persisted schema.
    expect(() => ConfigSchema.parse({ ...DEFAULT_CONFIG, mergeAgentRuntime: null })).toThrow()
  })

  test('mergeAgentRuntime: the specific pre-RFC-156 gap — inherit is now sendable', () => {
    const parsed = ConfigPatchSchema.parse({ mergeAgentRuntime: null })
    expect(parsed.mergeAgentRuntime).toBeNull()
  })
})
