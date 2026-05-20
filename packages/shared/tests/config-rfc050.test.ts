// RFC-050 — ConfigSchema additions for distiller output language.
//
// Locks the new memoryDistillLang field (optional, two-value enum) against
// ConfigSchema / ConfigPatchSchema / DEFAULT_CONFIG. Runtime fallback to
// 'en-US' lives in the distiller layer, not here — schema only guards the
// validity surface.

import { describe, expect, test } from 'bun:test'

import { ConfigPatchSchema, ConfigSchema, DEFAULT_CONFIG } from '../src/schemas/config.js'

describe('RFC-050 ConfigSchema additions — memoryDistillLang', () => {
  test('accepts zh-CN', () => {
    const parsed = ConfigSchema.parse({ ...DEFAULT_CONFIG, memoryDistillLang: 'zh-CN' })
    expect(parsed.memoryDistillLang).toBe('zh-CN')
  })

  test('accepts en-US', () => {
    const parsed = ConfigSchema.parse({ ...DEFAULT_CONFIG, memoryDistillLang: 'en-US' })
    expect(parsed.memoryDistillLang).toBe('en-US')
  })

  test('omitted field stays undefined (backward-compatible; runtime fallback en-US)', () => {
    const parsed = ConfigSchema.parse({ ...DEFAULT_CONFIG })
    expect(parsed.memoryDistillLang).toBeUndefined()
  })

  test('DEFAULT_CONFIG does NOT set a default value (distiller layer falls back)', () => {
    // Locking the proposal-level decision: keeping the field unset in
    // DEFAULT_CONFIG means existing config.json files don't need migration,
    // and the absence is semantically identical to 'en-US' (RFC-041 baseline).
    expect(DEFAULT_CONFIG.memoryDistillLang).toBeUndefined()
  })

  test('invalid value rejected', () => {
    expect(() => ConfigSchema.parse({ ...DEFAULT_CONFIG, memoryDistillLang: 'ja-JP' })).toThrow()
    expect(() => ConfigSchema.parse({ ...DEFAULT_CONFIG, memoryDistillLang: '' })).toThrow()
    expect(() => ConfigSchema.parse({ ...DEFAULT_CONFIG, memoryDistillLang: 123 })).toThrow()
  })

  test('ConfigPatchSchema accepts the new field as a partial', () => {
    const parsed = ConfigPatchSchema.parse({ memoryDistillLang: 'zh-CN' })
    expect(parsed.memoryDistillLang).toBe('zh-CN')
  })
})
