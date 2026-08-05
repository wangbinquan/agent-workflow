// RFC-258 T1/T2 — code-intel contract schemas + the two tiny pure mappings
// they carry: repoKey wire aliasing (gate F-04: the root repo's canonical key
// is '' which query params cannot carry) and LangId→shiki id (gate F-13: the
// exact baseline 8, nothing invented).

import { describe, expect, test } from 'bun:test'
import {
  codePositionSchema,
  fileSymbolsResultSchema,
  langIdSchema,
  parseRepoKeyWire,
  repoKeyWire,
  shikiLangFor,
  symbolResolutionSchema,
} from '../src'

describe('codePositionSchema', () => {
  test('accepts a minimal worktree position (1-based)', () => {
    const p = codePositionSchema.parse({
      repoKey: '',
      filePath: 'src/a.ts',
      side: 'worktree',
      startLine: 1,
    })
    expect(p.startCol).toBeUndefined()
  })

  test('rejects 0-based lines and empty paths', () => {
    expect(() =>
      codePositionSchema.parse({ repoKey: '', filePath: 'a', side: 'base', startLine: 0 }),
    ).toThrow()
    expect(() =>
      codePositionSchema.parse({ repoKey: '', filePath: '', side: 'base', startLine: 1 }),
    ).toThrow()
  })
})

describe('symbolResolutionSchema', () => {
  test('carries requested vs actual engine + degradation (F-07) and reference confidence (F-08)', () => {
    const r = symbolResolutionSchema.parse({
      requestedEngine: 'deep',
      engine: 'baseline',
      degradedReason: 'indexer-unavailable',
      symbol: 'verifyManifest',
      definitions: [{ repoKey: '', filePath: 'v.ts', side: 'worktree', startLine: 10 }],
      references: [
        { repoKey: '', filePath: 'c.ts', side: 'worktree', startLine: 3, confidence: 'inferred' },
      ],
    })
    expect(r.engine).toBe('baseline')
    expect(r.references[0]?.confidence).toBe('inferred')
  })
})

describe('fileSymbolsResultSchema', () => {
  test('the four completeness states parse; unknown state rejects (F-09)', () => {
    for (const status of ['ok', 'degraded', 'unsupported', 'parse-error'] as const) {
      expect(fileSymbolsResultSchema.parse({ lang: null, status, symbols: [] }).status).toBe(status)
    }
    expect(() =>
      fileSymbolsResultSchema.parse({ lang: null, status: 'partial', symbols: [] }),
    ).toThrow()
  })
})

describe('repoKey wire aliasing (F-04 — reuses the RFC-248 pair, not a new one)', () => {
  test('round-trips the root repo through "."', () => {
    expect(repoKeyWire('')).toBe('.')
    expect(parseRepoKeyWire('.')).toBe('')
  })

  test('named repos pass through untouched', () => {
    expect(repoKeyWire('backend')).toBe('backend')
    expect(parseRepoKeyWire('backend')).toBe('backend')
  })
})

describe('shikiLangFor (F-13)', () => {
  test('maps every baseline language and only those', () => {
    for (const lang of langIdSchema.options) {
      expect(shikiLangFor(lang)).toBeTruthy()
    }
    expect(shikiLangFor(null)).toBeNull()
  })

  test('spot-checks the dialect ids shiki actually loads', () => {
    expect(shikiLangFor('typescript')).toBe('ts')
    expect(shikiLangFor('javascript')).toBe('js')
    expect(shikiLangFor('scala')).toBe('scala')
  })
})
