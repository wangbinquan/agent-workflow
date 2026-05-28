// RFC-072 — pure helpers behind the Outputs tab's download affordance.

import { describe, expect, test } from 'vitest'
import { isFileOutputKind, isSingleLinePath } from '../src/lib/output-port'

describe('isFileOutputKind', () => {
  test('file-path kinds → true', () => {
    expect(isFileOutputKind('markdown_file')).toBe(true)
    expect(isFileOutputKind('path<md>')).toBe(true)
    expect(isFileOutputKind('path<*>')).toBe(true)
    expect(isFileOutputKind('path<pdf>')).toBe(true)
  })

  test('text / list / control kinds → false', () => {
    expect(isFileOutputKind('string')).toBe(false)
    expect(isFileOutputKind('markdown')).toBe(false)
    expect(isFileOutputKind('signal')).toBe(false)
    expect(isFileOutputKind('list<string>')).toBe(false)
    // A list of file paths is multiple files — not a single-file download in v1.
    expect(isFileOutputKind('list<path<md>>')).toBe(false)
  })

  test('null / undefined / empty / garbage → false', () => {
    expect(isFileOutputKind(null)).toBe(false)
    expect(isFileOutputKind(undefined)).toBe(false)
    expect(isFileOutputKind('')).toBe(false)
    expect(isFileOutputKind('not a kind <<')).toBe(false)
  })
})

describe('isSingleLinePath', () => {
  test('single non-empty line → true', () => {
    expect(isSingleLinePath('out/report.md')).toBe(true)
    expect(isSingleLinePath('  report.md  ')).toBe(true)
  })

  test('null / empty / multi-line → false', () => {
    expect(isSingleLinePath(null)).toBe(false)
    expect(isSingleLinePath('')).toBe(false)
    expect(isSingleLinePath('   ')).toBe(false)
    expect(isSingleLinePath('a.md\nb.md')).toBe(false)
  })
})
