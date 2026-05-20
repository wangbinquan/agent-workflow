// RFC-050 — source-layer grep guards for the output-language directive.
//
// These are STATIC source-text assertions (no runtime spawn / no DB). The
// idea is to make four invariants self-evident in CI:
//
//   G1: the two directive strings (en-US + zh-CN) exist verbatim in
//       memoryDistiller.ts. Any reword goes through a PR and is visible
//       in this test's diff.
//   G2: `buildDistillerUserPrompt` actually appends DISTILLER_OUTPUT_LANG_DIRECTIVE.
//       Guards against a future refactor silently dropping the trailer.
//   G3: DISTILLER_SYSTEM_PROMPT contains no CJK characters. The system
//       prompt stays English; language switching is user-prompt-only.
//   G4: SHA-256 of the runtime DISTILLER_SYSTEM_PROMPT matches a frozen
//       baseline. If a future commit touches the system prompt body
//       intentionally, update BASELINE_SHA256 in the same PR — this is
//       a tripwire, not a permanent lock.

import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import {
  DISTILLER_OUTPUT_LANG_DIRECTIVE,
  DISTILLER_SYSTEM_PROMPT,
} from '../src/services/memoryDistiller'

const SRC_PATH = resolve(import.meta.dir, '..', 'src', 'services', 'memoryDistiller.ts')

async function readSrc(): Promise<string> {
  return await Bun.file(SRC_PATH).text()
}

/**
 * Update this baseline (and only this baseline) when intentionally
 * editing DISTILLER_SYSTEM_PROMPT. Treat the diff line in this file as
 * the audit trail for prompt edits.
 */
const BASELINE_SHA256 = 'c150524fb524b31420a06c6c5bdb67c1540181de28786cfb714ca87cf4ab3664'

describe('RFC-050 grep guards — output-language directive', () => {
  test('G1: both directive strings appear verbatim in memoryDistiller.ts', async () => {
    const src = await readSrc()
    expect(src).toContain(DISTILLER_OUTPUT_LANG_DIRECTIVE['en-US'])
    expect(src).toContain(DISTILLER_OUTPUT_LANG_DIRECTIVE['zh-CN'])
  })

  test('G2: buildDistillerUserPrompt appends DISTILLER_OUTPUT_LANG_DIRECTIVE', async () => {
    const src = await readSrc()
    // The function must reference the directive map by name AND push it
    // into the prompt lines. We look for both signals so a rename of the
    // local `outputLang` variable doesn't accidentally pass.
    const fnStart = src.indexOf('export function buildDistillerUserPrompt(')
    expect(fnStart).toBeGreaterThan(-1)
    const fnEnd = src.indexOf('\n}', fnStart)
    const body = src.slice(fnStart, fnEnd)
    expect(body).toContain('DISTILLER_OUTPUT_LANG_DIRECTIVE')
    // Ensure the append happens via lines.push, not just as a comment.
    expect(/lines\.push\([^)]*DISTILLER_OUTPUT_LANG_DIRECTIVE/.test(body)).toBe(true)
  })

  test('G3: DISTILLER_SYSTEM_PROMPT body contains no CJK characters', () => {
    expect(/\p{Script=Han}/u.test(DISTILLER_SYSTEM_PROMPT)).toBe(false)
  })

  test('G4: DISTILLER_SYSTEM_PROMPT SHA-256 matches frozen baseline (tripwire)', () => {
    const actual = createHash('sha256').update(DISTILLER_SYSTEM_PROMPT).digest('hex')
    expect(actual).toBe(BASELINE_SHA256)
  })
})
