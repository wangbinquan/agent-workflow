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

// RFC-317 T14 —— 计数判据提到模块顶层：扫描与「matcher 自证」共用同一份实现。
function countOccurrencesIn(source: string, needle: string): number {
  return source.split(needle).length - 1
}

function countMatches(files: string[], needle: string): { count: number; files: string[] } {
  let count = 0
  const hit: string[] = []
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    const occurrences = countOccurrencesIn(src, needle)
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

// RFC-132 PR-F: the consumed_by_* stamp columns were DROPPED (migration 0073) — derived
// aging (isTargetNodeConsumed) is the ONE aging predicate. Invert the old declaration
// guard into a no-revival lock: reintroducing a stamp column/reader is the regression
// class this whole RFC closed.
describe('RFC-132 PR-F — consumed_by stamps stay deleted (no-revival lock)', () => {
  test('backend/src has ZERO consumedBy / consumed_by references', () => {
    const files = walk(BACKEND_SRC)
    const a = countMatches(files, 'consumedByConsumerRunId')
    const b = countMatches(files, 'consumedByQuestionerRunId')
    const c = countMatches(files, 'consumed_by_')
    expect({ a: a.files, b: b.files, c: c.files }).toEqual({ a: [], b: [], c: [] })
  })
})

// RFC-317 T13 —— 语料非空（守卫的守卫：architecture/rfc317-guard-corpus-floor.test.ts）。
//
// 上面每条断言的绿都可能来自两处：真的没有违规，或者**扫描根失效、语料被筛成空**。
// 两者在断言层面同形，后者是永久静默的假绿。这一条把「扫描器还活着」变成可断言事实；
// 下限同时两向钉进 architecture/guard-manifest.json，静默调低会红。
describe('RFC-317 T13 —— 语料非空', () => {
  test('扫描确实覆盖到源码语料（扫空即假绿）', () => {
    expect(walk(BACKEND_SRC).length + walk(SHARED_SRC).length).toBeGreaterThanOrEqual(350)
  })
})

// RFC-317 T14 —— 负 fixture：把伪造的违规喂给**上面扫描用的同一份计数判据**。
//
// 灭绝型守卫（断言 count === 0）有个特别阴的失效形态：needle 被拼错 / 被改名后，
// 计数永远是 0，断言永远绿——而且它绿得和「真的灭绝了」一模一样。这里至少钉住
// 「计数判据本身还会数」，配合上面的语料下限，把两种静默失效都挡掉。
describe('RFC-317 T14 —— matcher 自证：计数判据必须还会数', () => {
  test('伪造的源码里出现几次就数几次', () => {
    const fabricated =
      'import { computeHistoryCutoff } from "./aging"\n' +
      'const a = computeHistoryCutoff(x)\n' +
      'const b = computeHistoryCutoff(y)\n'
    expect(countOccurrencesIn(fabricated, 'computeHistoryCutoff')).toBe(3)
  })

  test('不出现就是 0（不能把「没数到」和「数错了」混为一谈）', () => {
    expect(countOccurrencesIn('const a = deriveCutoff(x)\n', 'computeHistoryCutoff')).toBe(0)
  })

  test('子串关系不被吞掉：historyCutoffClarifyIteration 同时算 historyCutoff 的一次出现', () => {
    const fabricated = 'const n = row.historyCutoffClarifyIteration\n'
    expect(countOccurrencesIn(fabricated, 'historyCutoffClarifyIteration')).toBe(1)
    expect(countOccurrencesIn(fabricated, 'historyCutoff')).toBe(1)
  })
})
