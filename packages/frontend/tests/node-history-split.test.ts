// Locks the regression fix for the "运行历史 / Run history" panel inside
// the NodeDetailDrawer Stats tab. Two earlier bug rounds shaped this:
//
//   1. Lumping loop / review / clarify iterations under "retries" made
//      every row label as `第 0 次` while clicking each showed wildly
//      different prompts / outputs — fix was the split helper.
//   2. Filtering the current anchor out of the iteration list made the
//      clicked row vanish and the rest re-flow, so the user lost their
//      place — fix was to keep the current run and highlight it.
//   3. The dedicated "retry list" was redundant once retries appeared
//      inline in iteration history with a `· 重试#N` suffix, so the two
//      sections collapsed into one unified `运行历史`.
//
// See node-history.ts for the helper that backs this; the original bug
// repro was agent_p69bj1 where clarifyIteration went 0→1→2→3 but
// retryIndex stayed 0.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { NodeRun } from '@agent-workflow/shared'
import { formatIterationLabel, nodeRunHistory } from '../src/lib/node-history'

function makeRun(partial: Partial<NodeRun> & { id: string }): NodeRun {
  return {
    id: partial.id,
    taskId: 't1',
    nodeId: partial.nodeId ?? 'n1',
    parentNodeRunId: partial.parentNodeRunId ?? null,
    iteration: partial.iteration ?? 0,
    shardKey: partial.shardKey ?? null,
    retryIndex: partial.retryIndex ?? 0,
    reviewIteration: partial.reviewIteration ?? 0,
    clarifyIteration: partial.clarifyIteration ?? 0,
    crossClarifyIteration: partial.crossClarifyIteration ?? 0,
    status: partial.status ?? 'done',
    startedAt: partial.startedAt ?? null,
    finishedAt: partial.finishedAt ?? null,
    pid: partial.pid ?? null,
    exitCode: partial.exitCode ?? null,
    errorMessage: partial.errorMessage ?? null,
    promptText: partial.promptText ?? null,
    tokInput: partial.tokInput ?? null,
    tokOutput: partial.tokOutput ?? null,
    tokTotal: partial.tokTotal ?? null,
    tokCacheCreate: partial.tokCacheCreate ?? null,
    tokCacheRead: partial.tokCacheRead ?? null,
    opencodeSessionId: partial.opencodeSessionId ?? null,
  }
}

// i18n stub: prints the key + the {{n}} interpolation so assertions stay
// readable without booting the i18next runtime.
const t = (key: string, vars?: Record<string, string | number>): string =>
  vars && 'n' in vars ? `${key}=${vars.n}` : key

describe('nodeRunHistory', () => {
  test('siblings on a different nodeId are ignored entirely', () => {
    const current = makeRun({ id: 'cur', nodeId: 'A' })
    const other = makeRun({ id: 'other', nodeId: 'B' })
    expect(nodeRunHistory(current, [current, other]).map((r) => r.id)).toEqual(['cur'])
  })

  test('fan-out shard children (parentNodeRunId != null) are excluded', () => {
    const current = makeRun({ id: 'cur' })
    const shard = makeRun({ id: 'shard', parentNodeRunId: 'cur' })
    expect(nodeRunHistory(current, [current, shard]).map((r) => r.id)).toEqual(['cur'])
  })

  test('always includes current run so the active row can be highlighted', () => {
    const current = makeRun({ id: 'cur' })
    expect(nodeRunHistory(current, [current]).map((r) => r.id)).toEqual(['cur'])
  })

  test('pure-retry history (no iteration variety) renders as a single list', () => {
    // The previous split returned `iterations=[]` here and relied on a
    // separate retry box — that box no longer exists, so the helper must
    // return every retry interleaved with current.
    const current = makeRun({ id: 'cur', retryIndex: 2 })
    const r0 = makeRun({ id: 'r0', retryIndex: 0 })
    const r1 = makeRun({ id: 'r1', retryIndex: 1 })
    expect(nodeRunHistory(current, [current, r1, r0]).map((r) => r.id)).toEqual(['r0', 'r1', 'cur'])
  })

  test('clarify-loop case: agent_p69bj1 4-row timeline preserved end-to-end', () => {
    const c0 = makeRun({ id: 'c0', clarifyIteration: 0, startedAt: 100 })
    const c1 = makeRun({ id: 'c1', clarifyIteration: 1, startedAt: 200 })
    const c2 = makeRun({ id: 'c2', clarifyIteration: 2, startedAt: 300 })
    const cur = makeRun({ id: 'cur', clarifyIteration: 3, startedAt: 400, status: 'running' })
    expect(nodeRunHistory(cur, [c0, c1, c2, cur]).map((r) => r.id)).toEqual([
      'c0',
      'c1',
      'c2',
      'cur',
    ])
  })

  test('sort order is (iteration, review, clarify, crossClarify, retryIndex, startedAt)', () => {
    const a = makeRun({ id: 'a', iteration: 0, reviewIteration: 0, clarifyIteration: 2 })
    const b = makeRun({ id: 'b', iteration: 0, reviewIteration: 1, clarifyIteration: 0 })
    const c = makeRun({ id: 'c', iteration: 1, reviewIteration: 0, clarifyIteration: 0 })
    const cur = makeRun({ id: 'cur', iteration: 2 })
    expect(nodeRunHistory(cur, [c, b, a, cur]).map((r) => r.id)).toEqual(['a', 'b', 'c', 'cur'])
  })

  // RFC-056 cross-clarify questioner re-runs bump `crossClarifyIteration`
  // only (loop/review/clarify/retry stay at 0). If the sort key forgets
  // cci, an existing done row at cci=0 sits next to the fresh cci=1 row
  // with arbitrary order from `startedAt`, and the user can't tell which
  // chip in the timeline is "this round" vs "last round".
  test('cross-clarify rerun: cci tie-breaks after clarifyIteration, before retryIndex', () => {
    const oldDone = makeRun({
      id: 'old',
      clarifyIteration: 0,
      crossClarifyIteration: 0,
      retryIndex: 0,
      startedAt: 100,
    })
    const newPending = makeRun({
      id: 'new',
      clarifyIteration: 0,
      crossClarifyIteration: 1,
      retryIndex: 0,
      status: 'pending',
      startedAt: 200,
    })
    expect(nodeRunHistory(newPending, [newPending, oldDone]).map((r) => r.id)).toEqual([
      'old',
      'new',
    ])
  })

  test('mixed: cross-iteration siblings + same-tuple retries interleave correctly', () => {
    const cur = makeRun({ id: 'cur', clarifyIteration: 2, retryIndex: 1 })
    const sameTupleRetry = makeRun({ id: 'rt', clarifyIteration: 2, retryIndex: 0 })
    const earlierIter = makeRun({ id: 'pi', clarifyIteration: 1, retryIndex: 0 })
    const earlierIterRetry = makeRun({ id: 'pi-rt', clarifyIteration: 1, retryIndex: 1 })
    expect(
      nodeRunHistory(cur, [cur, sameTupleRetry, earlierIter, earlierIterRetry]).map((r) => r.id),
    ).toEqual(['pi', 'pi-rt', 'rt', 'cur'])
  })
})

describe('formatIterationLabel', () => {
  test('all counters zero → "initial"', () => {
    expect(formatIterationLabel(makeRun({ id: 'x' }), { t })).toBe('nodeDrawer.iterInitial')
  })

  test('only clarify non-zero → single chunk, no retry suffix', () => {
    expect(formatIterationLabel(makeRun({ id: 'x', clarifyIteration: 2 }), { t })).toBe(
      'nodeDrawer.iterClarify=2',
    )
  })

  test('loop + review + clarify joined with " · " in canonical order', () => {
    const run = makeRun({ id: 'x', iteration: 3, reviewIteration: 1, clarifyIteration: 2 })
    expect(formatIterationLabel(run, { t })).toBe(
      'nodeDrawer.iterLoop=3 · nodeDrawer.iterReview=1 · nodeDrawer.iterClarify=2',
    )
  })

  test('retryIndex > 0 appends a retry chunk — covers the unified list', () => {
    // Pure retry of clarify=1: this is what the dropped "retry list" used
    // to show, now rendered inline as the iteration label.
    const run = makeRun({ id: 'x', clarifyIteration: 1, retryIndex: 2 })
    expect(formatIterationLabel(run, { t })).toBe(
      'nodeDrawer.iterClarify=1 · nodeDrawer.iterRetry=2',
    )
  })

  test('all counters zero but retryIndex > 0 → "initial · retry#N"', () => {
    // Edge case: a retry of the initial attempt shouldn't drop the
    // "initial" anchor or we'd render a bare "retry#1" with no context.
    const run = makeRun({ id: 'x', retryIndex: 1 })
    expect(formatIterationLabel(run, { t })).toBe('nodeDrawer.iterInitial · nodeDrawer.iterRetry=1')
  })

  // RFC-056 questioner-rerun bug repro: mintQuestionerRerun bumps cci
  // only. Without the cci branch in this helper, the new node_run lands
  // on the all-zero fallthrough and renders identically to the original
  // "初次" row, making the rerun invisible in the Stats history list.
  test('only crossClarifyIteration non-zero → "cross-clarify#N", NOT "initial"', () => {
    expect(formatIterationLabel(makeRun({ id: 'x', crossClarifyIteration: 1 }), { t })).toBe(
      'nodeDrawer.iterCrossClarify=1',
    )
  })

  test('clarify + cross-clarify both non-zero → both chunks in canonical order', () => {
    const run = makeRun({ id: 'x', clarifyIteration: 2, crossClarifyIteration: 1 })
    expect(formatIterationLabel(run, { t })).toBe(
      'nodeDrawer.iterClarify=2 · nodeDrawer.iterCrossClarify=1',
    )
  })

  test('crossClarifyIteration > 0 with retryIndex > 0 → "cross-clarify#N · retry#M"', () => {
    const run = makeRun({ id: 'x', crossClarifyIteration: 1, retryIndex: 2 })
    expect(formatIterationLabel(run, { t })).toBe(
      'nodeDrawer.iterCrossClarify=1 · nodeDrawer.iterRetry=2',
    )
  })
})

describe('NodeDetailDrawer run-history list', () => {
  // Source-level lock for the unified Stats history section:
  //   - single list, no separate retries box
  //   - active row highlighted + aria-current + disabled (no self-click)
  // If anyone reintroduces statRetries or removes the active affordances
  // this test goes red.
  const src = readFileSync(
    resolve(import.meta.dirname, '..', 'src/components/NodeDetailDrawer.tsx'),
    'utf8',
  )

  test('uses the single unified history list, not the old two-section layout', () => {
    expect(src).toContain('stats-history-list')
    expect(src).toContain("t('nodeDrawer.statHistory')")
    expect(src).not.toContain('stats-retries-list')
    expect(src).not.toContain('stats-iterations-list')
    expect(src).not.toContain("t('nodeDrawer.statRetries')")
    expect(src).not.toContain("t('nodeDrawer.statIterations')")
  })

  test('history list applies the --active class when row.id === run.id', () => {
    expect(src).toContain('retries-history__item--active')
    expect(src).toMatch(/const isActive\s*=\s*r\.id\s*===\s*run\.id/)
  })

  test('active row sets aria-current and disables click', () => {
    expect(src).toMatch(/aria-current=\{isActive \? 'true' : undefined\}/)
    expect(src).toMatch(/disabled=\{isActive\}/)
  })
})
