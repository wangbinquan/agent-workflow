// RFC-070 — source-text invariants that lock the "counter-based aging is
// gone" contract. If any of these turn red, someone re-introduced the
// counter-cutoff path the RFC eliminated — that's the regression class the
// whole RFC exists to close. Do NOT relax assertions; trace the offending
// commit instead.

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const BACKEND_SRC = resolve(REPO_ROOT, 'packages/backend/src')
const SHARED_SRC = resolve(REPO_ROOT, 'packages/shared/src')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walk(full))
    else if (full.endsWith('.ts')) out.push(full)
  }
  return out
}

function countMatches(files: string[], needle: string): { count: number; files: string[] } {
  let count = 0
  const hit: string[] = []
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    const occurrences = src.split(needle).length - 1
    if (occurrences > 0) {
      count += occurrences
      hit.push(`${f}:${occurrences}`)
    }
  }
  return { count, files: hit }
}

describe('RFC-070 C-guard — counter-based aging path is gone in production code', () => {
  test('`computeHistoryCutoff` not referenced in backend/src', () => {
    const files = walk(BACKEND_SRC)
    const { count, files: hits } = countMatches(files, 'computeHistoryCutoff')
    expect({ count, hits }).toEqual({ count: 0, hits: [] })
  })

  test('`historyCutoff` parameter not referenced in backend/src', () => {
    const files = walk(BACKEND_SRC)
    const { count, files: hits } = countMatches(files, 'historyCutoff')
    expect({ count, hits }).toEqual({ count: 0, hits: [] })
  })

  test('`historyCutoffClarifyIteration` parameter not referenced in backend/src', () => {
    const files = walk(BACKEND_SRC)
    const { count, files: hits } = countMatches(files, 'historyCutoffClarifyIteration')
    expect({ count, hits }).toEqual({ count: 0, hits: [] })
  })

  test('`applyAgingCutoff` helper not referenced anywhere in src', () => {
    const files = [...walk(BACKEND_SRC), ...walk(SHARED_SRC)]
    const { count, files: hits } = countMatches(files, 'applyAgingCutoff')
    expect({ count, hits }).toEqual({ count: 0, hits: [] })
  })

  test('`iterationField` RFC-064 patch leftover not referenced in backend/src', () => {
    const files = walk(BACKEND_SRC)
    const { count, files: hits } = countMatches(files, 'iterationField')
    expect({ count, hits }).toEqual({ count: 0, hits: [] })
  })
})

// RFC-132 PR-D' 步骤2 (T4): C-guard「mark helper 单定义 + 单调用」describe 删除——
// markClarifyRoundsConsumedBy 已删（consumed_by 消费戳废弃，派生老化 isTargetNodeConsumed
// 取代）。counter-aging（下方 #1）+ schema 列（#3，PR-F drop-column 前保留）+ read-path（#4，
// 步骤3 删死注入器时更新）仍锁。

describe('RFC-070 C-guard — schema declares consumed_by columns on all three tables', () => {
  test('schema.ts has consumedByConsumerRunId in clarify_sessions, cross_clarify_sessions, clarify_rounds', () => {
    const txt = readFileSync(join(BACKEND_SRC, 'db/schema.ts'), 'utf8')
    const consumerHits = txt.split('consumedByConsumerRunId').length - 1
    // 3 column declarations + 3 index declarations = 6, plus any references
    // within FK / type contexts. Lower bound 6.
    expect(consumerHits).toBeGreaterThanOrEqual(6)
  })

  test('schema.ts has consumedByQuestionerRunId in cross_clarify_sessions + clarify_rounds (NOT clarify_sessions)', () => {
    const txt = readFileSync(join(BACKEND_SRC, 'db/schema.ts'), 'utf8')
    const questionerHits = txt.split('consumedByQuestionerRunId').length - 1
    // 2 column declarations + 2 index declarations = 4, lower bound.
    expect(questionerHits).toBeGreaterThanOrEqual(4)
  })
})

describe('RFC-070 C-guard — read paths apply IS NULL filter', () => {
  test('clarifyRounds.ts SELECTs use isNull(...consumedBy...) predicate', () => {
    const txt = readFileSync(join(BACKEND_SRC, 'services/clarifyRounds.ts'), 'utf8')
    const isNullConsumerHits = txt.split('isNull(clarifyRounds.consumedByConsumerRunId)').length - 1
    const isNullQuestionerHits =
      txt.split('isNull(clarifyRounds.consumedByQuestionerRunId)').length - 1
    expect(isNullConsumerHits).toBeGreaterThanOrEqual(2) // self + cross-designer SELECTs
    expect(isNullQuestionerHits).toBeGreaterThanOrEqual(1) // cross-questioner SELECT
  })

  test('crossClarify.ts buildExternalFeedbackContext + buildQuestionerCrossClarifyContext use IS NULL', () => {
    const txt = readFileSync(join(BACKEND_SRC, 'services/crossClarify.ts'), 'utf8')
    expect(txt).toContain('isNull(crossClarifySessions.consumedByConsumerRunId)')
    expect(txt).toContain('isNull(crossClarifySessions.consumedByQuestionerRunId)')
  })

  test('clarify.ts buildClarifyPromptContext uses IS NULL on clarify_sessions', () => {
    const txt = readFileSync(join(BACKEND_SRC, 'services/clarify.ts'), 'utf8')
    expect(txt).toContain('isNull(clarifySessions.consumedByConsumerRunId)')
  })
})
