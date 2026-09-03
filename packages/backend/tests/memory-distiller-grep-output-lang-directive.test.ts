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
} from '../src/modules/memory/application/distill/memoryDistiller'

const SRC_PATH = resolve(
  import.meta.dir,
  '..',
  'src',
  'modules',
  'memory',
  'domain',
  'distillPrompt.ts',
)

// RFC-352：常量下沉 domain、组装仍在 application，因此两条守卫各读各的 owner 文件。
// 下一步把 buildDistillerUserPrompt 也移进 domain 时，把这里改成同一个路径即可。
const PROMPT_BUILDER_PATH = resolve(
  import.meta.dir,
  '..',
  'src',
  'modules',
  'memory',
  'application',
  'distill',
  'memoryDistiller.ts',
)

async function readSrc(): Promise<string> {
  return await Bun.file(SRC_PATH).text()
}

async function readPromptBuilderSrc(): Promise<string> {
  return await Bun.file(PROMPT_BUILDER_PATH).text()
}

/**
 * Update this baseline (and only this baseline) when intentionally
 * editing DISTILLER_SYSTEM_PROMPT. Treat the diff line in this file as
 * the audit trail for prompt edits.
 */
const BASELINE_SHA256 = 'd3e640d98cdbd1b2d09c7b813547879242f9bea944a7761a855dcf68eb054474'

describe('RFC-050 grep guards — output-language directive', () => {
  test('G1: both directive strings appear verbatim in domain/distillPrompt.ts', async () => {
    const src = await readSrc()
    expect(src).toContain(DISTILLER_OUTPUT_LANG_DIRECTIVE['en-US'])
    expect(src).toContain(DISTILLER_OUTPUT_LANG_DIRECTIVE['zh-CN'])
  })

  test('G2: buildDistillerUserPrompt appends DISTILLER_OUTPUT_LANG_DIRECTIVE', async () => {
    const src = await readPromptBuilderSrc()
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
