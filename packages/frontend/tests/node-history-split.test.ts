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
import { clarifyRoundForRun, formatIterationLabel, nodeRunHistory } from '../src/lib/node-history'

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
    status: partial.status ?? 'done',
    startedAt: partial.startedAt ?? null,
    finishedAt: partial.finishedAt ?? null,
    pid: partial.pid ?? null,
    exitCode: partial.exitCode ?? null,
    errorMessage: partial.errorMessage ?? null,
    supersededByReview: partial.supersededByReview ?? null,
    rolledBack: partial.rolledBack ?? null,
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
    // RFC-074 PR-C: sorted by id (creation order); causal ids r0<r1<cur.
    const current = makeRun({ id: '03cur', retryIndex: 2 })
    const r0 = makeRun({ id: '01r0', retryIndex: 0 })
    const r1 = makeRun({ id: '02r1', retryIndex: 1 })
    expect(nodeRunHistory(current, [current, r1, r0]).map((r) => r.id)).toEqual([
      '01r0',
      '02r1',
      '03cur',
    ])
  })

  test('clarify-loop case: agent_p69bj1 4-row timeline preserved end-to-end', () => {
    // RFC-074 PR-C: clarify generations are id-ordered (each rerun minted later
    // carries a larger ULID). Causal ids c0<c1<c2<cur reproduce the timeline.
    const c0 = makeRun({ id: '01c0', retryIndex: 0, startedAt: 100 })
    const c1 = makeRun({ id: '01c1', retryIndex: 0, startedAt: 200 })
    const c2 = makeRun({ id: '01c2', retryIndex: 0, startedAt: 300 })
    const cur = makeRun({ id: '01cur', retryIndex: 0, startedAt: 400, status: 'running' })
    expect(nodeRunHistory(cur, [c0, c1, c2, cur]).map((r) => r.id)).toEqual([
      '01c0',
      '01c1',
      '01c2',
      '01cur',
    ])
  })

  test('sort order is (iteration, reviewIteration, id)', () => {
    const a = makeRun({ id: '01a', iteration: 0, reviewIteration: 0 })
    const b = makeRun({ id: '01b', iteration: 0, reviewIteration: 1 })
    const c = makeRun({ id: '01c', iteration: 1, reviewIteration: 0 })
    const cur = makeRun({ id: '01cur', iteration: 2 })
    expect(nodeRunHistory(cur, [c, b, a, cur]).map((r) => r.id)).toEqual([
      '01a',
      '01b',
      '01c',
      '01cur',
    ])
  })

  // RFC-074 PR-C: a clarify-driven rerun is minted later than the done row it
  // supersedes, so its id is larger and it sorts AFTER. Causal ids reproduce
  // the "old round then this round" timeline without the retired cci key.
  test('clarify rerun: later-minted row (larger id) sorts after the prior done row', () => {
    const oldDone = makeRun({ id: '01old', retryIndex: 0, startedAt: 100 })
    const newPending = makeRun({ id: '02new', retryIndex: 0, status: 'pending', startedAt: 200 })
    expect(nodeRunHistory(newPending, [newPending, oldDone]).map((r) => r.id)).toEqual([
      '01old',
      '02new',
    ])
  })

  test('mixed: cross-iteration siblings + same-tuple retries interleave by id', () => {
    // Causal ids reflect creation order: gen1, gen1-retry, gen2, gen2-retry(cur).
    const earlierIter = makeRun({ id: '01pi', retryIndex: 0 })
    const earlierIterRetry = makeRun({ id: '02pi-rt', retryIndex: 1 })
    const sameTupleRetry = makeRun({ id: '03rt', retryIndex: 0 })
    const cur = makeRun({ id: '04cur', retryIndex: 1 })
    expect(
      nodeRunHistory(cur, [cur, sameTupleRetry, earlierIter, earlierIterRetry]).map((r) => r.id),
    ).toEqual(['01pi', '02pi-rt', '03rt', '04cur'])
  })
})

describe('clarifyRoundForRun (RFC-074 PR-C — id-order generation derivation)', () => {
  test('first generation (only retry=0 row) → round 0', () => {
    const r0 = makeRun({ id: '01a', retryIndex: 0 })
    expect(clarifyRoundForRun(r0, [r0])).toBe(0)
  })

  test('each later done generation row is the next round', () => {
    const g0 = makeRun({ id: '01g0', status: 'done' })
    const g1 = makeRun({ id: '02g1', status: 'done' })
    const g2 = makeRun({ id: '03g2', status: 'done' })
    const runs = [g0, g1, g2]
    expect(clarifyRoundForRun(g0, runs)).toBe(0)
    expect(clarifyRoundForRun(g1, runs)).toBe(1)
    expect(clarifyRoundForRun(g2, runs)).toBe(2)
  })

  test('a process retry (its predecessor failed) stays in its generation', () => {
    // RFC-074 PR-C (corrected): a process / envelope-followup retry fires only
    // AFTER a `failed` attempt (scheduler decideEnvelopeFollowup requires
    // prev.status === 'failed'), so it follows a non-`done` row and belongs to
    // the SAME generation. The round counts prior COMPLETED (done) generations,
    // retry-agnostic — NOT retry=0 rows.
    const g0 = makeRun({ id: '01g0', retryIndex: 0, status: 'done' }) // gen 0, done
    const g1fail = makeRun({ id: '02g1', retryIndex: 0, status: 'failed' }) // gen 1, attempt 1 crashed
    const g1retry = makeRun({ id: '03g1r', retryIndex: 1, status: 'done' }) // gen 1, retry succeeded
    const runs = [g0, g1fail, g1retry]
    expect(clarifyRoundForRun(g1fail, runs)).toBe(1) // one prior done generation (g0)
    expect(clarifyRoundForRun(g1retry, runs)).toBe(1) // same gen 1 — g1fail (failed) not counted
  })

  test('cross-clarify designer rerun (retryIndex = max+1) is a NEW round — RFC-074 regression fix', () => {
    // Regression repro: triggerDesignerRerun mints the cross-clarify rerun at
    // retryIndex = max+1 (NOT 0) to keep the scheduler isClarifyRerun gate
    // false. The retired `retryIndex === 0` anchor therefore collapsed every
    // designer generation to round 0 (under-count). The prior-done id-order
    // derivation counts it correctly (pre-migration cci=1). This assertion is
    // RED under the old retry=0 filter and GREEN under the corrected helper.
    const d0 = makeRun({ id: '01d0', retryIndex: 0, status: 'done' }) // first design, done
    const dRerun = makeRun({ id: '02d1', retryIndex: 5, status: 'done' }) // cross-clarify rerun @ retry max+1
    expect(clarifyRoundForRun(dRerun, [d0, dRerun])).toBe(1)
  })

  test('round is scoped per (iteration, reviewIteration)', () => {
    const i0 = makeRun({ id: '01i0', iteration: 0, status: 'done' })
    const i1 = makeRun({ id: '02i1', iteration: 1, status: 'done' })
    // i1 is the first generation within its own iteration → round 0.
    expect(clarifyRoundForRun(i1, [i0, i1])).toBe(0)
  })

  test('US-2 re-review: a second done top-level row counts as a round (unchanged by the fix)', () => {
    // A review node's RFC-005 US-2 re-review mints a second done top-level row
    // at the SAME reviewIteration. Both the old retry=0 filter and the new
    // prior-done derivation count it as round 1 for review nodes — documenting
    // that this fix does NOT change review-node round display (the separate
    // "review nodes should not show a clarify chip at all" concern is tracked
    // independently and is out of scope for the designer regression).
    const r0 = makeRun({ id: '01r0', retryIndex: 0, status: 'done' })
    const r1 = makeRun({ id: '02r1', retryIndex: 0, status: 'done' })
    expect(clarifyRoundForRun(r1, [r0, r1])).toBe(1)
  })
})

describe('formatIterationLabel', () => {
  test('all counters zero → "initial"', () => {
    expect(formatIterationLabel(makeRun({ id: 'x' }), { t })).toBe('nodeDrawer.iterInitial')
  })

  test('only clarify non-zero → single chunk, no retry suffix', () => {
    // RFC-074 PR-C: the clarify round is the derived 3rd arg, not a row field.
    expect(formatIterationLabel(makeRun({ id: 'x' }), { t }, 2)).toBe('nodeDrawer.iterClarify=2')
  })

  test('loop + review + clarify joined with " · " in canonical order', () => {
    const run = makeRun({ id: 'x', iteration: 3, reviewIteration: 1 })
    expect(formatIterationLabel(run, { t }, 2)).toBe(
      'nodeDrawer.iterLoop=3 · nodeDrawer.iterReview=1 · nodeDrawer.iterClarify=2',
    )
  })

  test('retryIndex > 0 appends a retry chunk — covers the unified list', () => {
    // Pure retry of clarify round 1: rendered inline as the iteration label.
    const run = makeRun({ id: 'x', retryIndex: 2 })
    expect(formatIterationLabel(run, { t }, 1)).toBe(
      'nodeDrawer.iterClarify=1 · nodeDrawer.iterRetry=2',
    )
  })

  test('all counters zero but retryIndex > 0 → "initial · retry#N"', () => {
    // Edge case: a retry of the initial attempt shouldn't drop the
    // "initial" anchor or we'd render a bare "retry#1" with no context.
    const run = makeRun({ id: 'x', retryIndex: 1 })
    expect(formatIterationLabel(run, { t })).toBe('nodeDrawer.iterInitial · nodeDrawer.iterRetry=1')
  })

  // RFC-064: previously this section had 3 cases pinning a separate
  // `crossClarifyIteration` chip / fallthrough. Under the unified
  // clarifyIteration counter, mintQuestionerRerun / triggerDesignerRerun
  // now bump the single field on the same axis as self-clarify (design.md
  // §10.5 option D1), so the cross-specific label branch was deleted along
  // with its tests. The "clarify counter > 0 wins over initial" semantics
  // is now covered uniformly by the existing clarifyIteration cases above
  // — equally valid for both self and cross flows.
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
