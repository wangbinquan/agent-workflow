// RFC-151 PR-1 — structured import warnings (frontend lift, wire unchanged).
//
// parseAgentMarkdown reports problems as string[] where a fatal YAML failure
// is a `yaml-parse-failed: …` prefix. AgentImportDialog used to sniff that
// prefix at three sites; structureImportWarnings normalizes once into
// {code, message, blocking} and the dialog reads structure only. These tests
// lock the normalization table AND (source-level) that the dialog no longer
// string-sniffs.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { structureImportWarnings } from '../src/lib/agent-import-warnings'

describe('structureImportWarnings', () => {
  test('yaml-parse-failed prefix → blocking record, message kept verbatim', () => {
    const raw = 'yaml-parse-failed: bad indent at line 3'
    expect(structureImportWarnings([raw])).toEqual([
      { code: 'yaml-parse-failed', message: raw, blocking: true },
    ])
  })

  test('other strings → non-blocking generic warnings', () => {
    expect(structureImportWarnings(['unknown key `foo` routed to frontmatterExtra'])).toEqual([
      {
        code: 'warning',
        message: 'unknown key `foo` routed to frontmatterExtra',
        blocking: false,
      },
    ])
  })

  test('mixed input keeps order and per-item classification', () => {
    const out = structureImportWarnings(['plain', 'yaml-parse-failed: x', 'another'])
    expect(out.map((w) => w.blocking)).toEqual([false, true, false])
    expect(out.map((w) => w.code)).toEqual(['warning', 'yaml-parse-failed', 'warning'])
  })

  test('empty input → empty output', () => {
    expect(structureImportWarnings([])).toEqual([])
  })

  test('prefix must be at position 0 (a mention mid-string is a plain warning)', () => {
    expect(structureImportWarnings(['note: yaml-parse-failed: nope'])[0]!.blocking).toBe(false)
  })
})

describe('AgentImportDialog reads structure, not string prefixes', () => {
  test('no startsWith prefix-sniffing remains in the dialog', () => {
    const src = readFileSync(
      join(__dirname, '..', 'src', 'components', 'AgentImportDialog.tsx'),
      'utf8',
    )
    expect(src).toContain('structureImportWarnings')
    expect(src.includes("startsWith('yaml-parse-failed"), 'prefix sniffing came back').toBe(false)
  })
})
