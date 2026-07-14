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
import {
  clarifyRoundForRun,
  displayRetryForRun,
  formatIterationLabel,
  nodeRunHistory,
} from '../src/lib/node-history'

function makeRun(partial: Partial<NodeRun> & { id: string }): NodeRun {
  return {
    id: partial.id,
    taskId: 't1',
    nodeId: partial.nodeId ?? 'n1',
    parentNodeRunId: partial.parentNodeRunId ?? null,
    iteration: partial.iteration ?? 0,
    shardKey: partial.shardKey ?? null,
    retryIndex: partial.retryIndex ?? 0,
    wgRound: null,
    rerunCause: null,
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

  // Workgroup regression (task 01KXFYSZ7GQW8GW191VM1GWAWY): all member runs
  // share the `__wg_member__` node and are top-level, distinguished ONLY by
  // shardKey (assignment id / `msg:*`). The pre-fix derivation ignored
  // shardKey, so three PARALLEL assignments counted each other as prior
  // clarify generations and rendered 初次 / 反问#1 / 反问#2. The fix mirrors
  // the backend's canonical `priorDoneGenerationsForRun` shardKey scope.
  describe('workgroup host runs (shard-scoped lineages)', () => {
    test('parallel member assignments are independent lineages — all round 0', () => {
      const alpha = makeRun({ id: '01a', nodeId: '__wg_member__', shardKey: 'asg1' })
      const gamma = makeRun({ id: '02g', nodeId: '__wg_member__', shardKey: 'asg3' })
      const beta = makeRun({
        id: '03b',
        nodeId: '__wg_member__',
        shardKey: 'asg2',
        status: 'failed',
      })
      const betaRetry = makeRun({
        id: '04br',
        nodeId: '__wg_member__',
        shardKey: 'asg2',
        retryIndex: 1,
      })
      const runs = [alpha, gamma, beta, betaRetry]
      expect(clarifyRoundForRun(alpha, runs)).toBe(0)
      expect(clarifyRoundForRun(gamma, runs)).toBe(0)
      expect(clarifyRoundForRun(beta, runs)).toBe(0)
      expect(clarifyRoundForRun(betaRetry, runs)).toBe(0)
    })

    test('clarify-answer rerun of the SAME assignment (same shardKey) is round 1', () => {
      // RFC-182 design-gate P1: a clarify-answer host rerun keeps its shard
      // lineage — the prior done row of the SAME shardKey is a real prior
      // generation and must still count.
      const asked = makeRun({ id: '01q', nodeId: '__wg_member__', shardKey: 'asg1' })
      const other = makeRun({ id: '02o', nodeId: '__wg_member__', shardKey: 'asg2' })
      const resumed = makeRun({ id: '03r', nodeId: '__wg_member__', shardKey: 'asg1' })
      expect(clarifyRoundForRun(resumed, [asked, other, resumed])).toBe(1)
    })

    test('leader rounds never derive a clarify round', () => {
      // Successive `__wg_leader__` done rows are LEADER ROUNDS minted by the
      // turn machinery (wg-leader-round), all on the same null-shard lineage
      // — id-order cannot separate them from clarify generations, so the
      // derivation is suppressed outright for the leader host node.
      const round1 = makeRun({ id: '01l1', nodeId: '__wg_leader__' })
      const round2 = makeRun({ id: '02l2', nodeId: '__wg_leader__', retryIndex: 1 })
      const runs = [round1, round2]
      expect(clarifyRoundForRun(round1, runs)).toBe(0)
      expect(clarifyRoundForRun(round2, runs)).toBe(0)
    })
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

  // RFC-182 P1-3 turn-kind prefixes for workgroup host runs. Paired with the
  // shard-scoped clarifyRoundForRun above, a parallel assignment run renders
  // as a bare "派发轮" — never "派发轮 · 反问#N".
  test('workgroup member assignment run leads with the assignment turn kind, no initial chunk', () => {
    const run = makeRun({ id: 'x', nodeId: '__wg_member__', shardKey: '01ASG' })
    expect(formatIterationLabel(run, { t })).toBe('workgroups.room.turnKindAssignment')
  })

  test('workgroup member msg:* run leads with the mention turn kind', () => {
    const run = makeRun({ id: 'x', nodeId: '__wg_member__', shardKey: 'msg:m1:5' })
    expect(formatIterationLabel(run, { t })).toBe('workgroups.room.turnKindMessage')
  })

  test('workgroup leader run leads with the leader turn kind; the ordinal retryIndex is NOT a retry', () => {
    // driveLeaderTurn mints retryIndex = prior-leader-run-count, so a normal
    // second round carries retryIndex=1 with zero retries. Without an
    // explicit retryOrdinal the label must suppress the suffix rather than
    // render a lying "重试#1" (Codex impl-gate P2 on this fix).
    const run = makeRun({ id: 'x', nodeId: '__wg_leader__', retryIndex: 1 })
    expect(formatIterationLabel(run, { t })).toBe('workgroups.room.turnKindLeader')
  })

  test('workgroup run with a derived retryOrdinal appends the real retry suffix', () => {
    const run = makeRun({ id: 'x', nodeId: '__wg_member__', shardKey: '01ASG', retryIndex: 3 })
    expect(formatIterationLabel(run, { t }, 0, 1)).toBe(
      'workgroups.room.turnKindAssignment · nodeDrawer.iterRetry=1',
    )
  })

  test('regular node keeps raw retryIndex when no retryOrdinal is passed', () => {
    const run = makeRun({ id: 'x', retryIndex: 2 })
    expect(formatIterationLabel(run, { t })).toBe('nodeDrawer.iterInitial · nodeDrawer.iterRetry=2')
  })
})

describe('displayRetryForRun (workgroup retryIndex is a turn ordinal, not a retry count)', () => {
  test('regular node: passthrough of retryIndex', () => {
    const run = makeRun({ id: '01x', retryIndex: 2 })
    expect(displayRetryForRun(run, [run])).toBe(2)
  })

  test('leader round 2 (retryIndex=1, prior round done) → 0 retries', () => {
    const round1 = makeRun({ id: '01l1', nodeId: '__wg_leader__' })
    const round2 = makeRun({ id: '02l2', nodeId: '__wg_leader__', retryIndex: 1 })
    expect(displayRetryForRun(round2, [round1, round2])).toBe(0)
  })

  test('assignment failed → rerun counts as retry#1', () => {
    const fail = makeRun({ id: '01f', nodeId: '__wg_member__', shardKey: 'asg1', status: 'failed' })
    const retry = makeRun({ id: '02r', nodeId: '__wg_member__', shardKey: 'asg1', retryIndex: 1 })
    expect(displayRetryForRun(retry, [fail, retry])).toBe(1)
  })

  test('clarify-answer resume after a done row is NOT a retry', () => {
    // Lineage: [failed, done(retry that asked), clarify-resume]. The failure
    // belongs to the generation it crashed in — the resume after the done row
    // starts fresh at 0 retries.
    const fail = makeRun({ id: '01f', nodeId: '__wg_member__', shardKey: 'asg1', status: 'failed' })
    const asked = makeRun({ id: '02d', nodeId: '__wg_member__', shardKey: 'asg1', retryIndex: 1 })
    const resume = makeRun({ id: '03c', nodeId: '__wg_member__', shardKey: 'asg1', retryIndex: 2 })
    expect(displayRetryForRun(resume, [fail, asked, resume])).toBe(0)
  })

  test('other assignments (different shardKey) never bleed into the count', () => {
    const otherFail = makeRun({
      id: '01of',
      nodeId: '__wg_member__',
      shardKey: 'asg9',
      status: 'failed',
    })
    const mine = makeRun({ id: '02m', nodeId: '__wg_member__', shardKey: 'asg1', retryIndex: 4 })
    expect(displayRetryForRun(mine, [otherFail, mine])).toBe(0)
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
