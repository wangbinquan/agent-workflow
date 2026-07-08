// RFC-076 PR-A — trim-B dispatch predicates (isDispatchable / wrapperHasFreshInnerWork).
//
// These lock the much-reviewed (3 adversarial rounds) corrections to the
// original full-B sketch. Pure-function locks in the style of freshness.test.ts.
// If any goes red, re-read design/RFC-076-…/design.md §3 + the round-2/3 reports.
//
// RFC-095 (audit S-22) flipped the `canceled` half of the old combined
// "canceled / running → NOT dispatchable" case: a plain canceled row is now a
// REVIVAL signal (same N1 class as failed/interrupted — task-cancel keeps the
// worktree; retryNode on a canceled task is a designed UI flow). Only a
// review-supersede row (superseded_by_review column non-null, RFC-145)
// stays parked — see design/RFC-095-scope-outcome-exhaustive/design.md §1.

import { describe, expect, test } from 'bun:test'
import type { NodeKind, WorkflowDefinition } from '@agent-workflow/shared'
import type { nodeRuns } from '../src/db/schema'
import {
  isDispatchable,
  wrapperExternalUpstreamSources,
  wrapperHasFreshInnerWork,
  wrapperInnerDescendants,
  wrapperRevivalEvidence,
} from '../src/services/dispatchFrontier'
import { encodeWrapperProgress } from '../src/services/wrapperProgress'

type Row = typeof nodeRuns.$inferSelect

function run(over: Partial<Row>): Row {
  return {
    id: '01R',
    nodeId: 'n',
    iteration: 0,
    status: 'done',
    // RFC-095: the canceled branch reads errorMessage (supersede-marker guard);
    // default to the DB's null so helper-built rows behave like real rows.
    errorMessage: null,
    consumedUpstreamRunsJson: null,
    wrapperProgressJson: null,
    ...over,
  } as unknown as Row
}
function doneRow(id: string): Row {
  return { id, status: 'done' } as unknown as Row
}
const NO_FRESH = new Map<string, Row>()
// A row whose consumed map is empty is ALWAYS fresh (isNodeRunFresh B1).
const FRESH_DONE = run({ status: 'done', consumedUpstreamRunsJson: null })
// done but stale: consumed an OLD upstream run while the upstream advanced.
const STALE_DONE = run({
  status: 'done',
  consumedUpstreamRunsJson: JSON.stringify({ up: '01OLD' }),
})
const STALE_FRESHEST = new Map<string, Row>([['up', doneRow('01NEW')]])

// Minimal WorkflowDefinition: only .nodes (id/kind/nodeIds) is read.
function def(nodes: Array<{ id: string; kind: NodeKind; nodeIds?: string[] }>): WorkflowDefinition {
  return { nodes, edges: [] } as unknown as WorkflowDefinition
}

describe('RFC-076 PR-A — isDispatchable (trim-B status gate)', () => {
  const emptyDef = def([{ id: 'n', kind: 'agent-single' }])

  test('never-ran (undefined) → dispatchable', () => {
    expect(isDispatchable(undefined, 'agent-single', NO_FRESH, [], emptyDef)).toBe(true)
  })
  test('pending → dispatchable (out-of-band mint / placeholder)', () => {
    expect(isDispatchable(run({ status: 'pending' }), 'agent-single', NO_FRESH, [], emptyDef)).toBe(
      true,
    )
  })
  test('done ∧ fresh → NOT dispatchable', () => {
    expect(isDispatchable(FRESH_DONE, 'agent-single', NO_FRESH, [], emptyDef)).toBe(false)
  })
  test('done ∧ stale → dispatchable (stale-done re-run)', () => {
    expect(isDispatchable(STALE_DONE, 'agent-single', STALE_FRESHEST, [], emptyDef)).toBe(true)
  })

  // N1 — the critical reversal: failed/interrupted are the resume/retry signal.
  test('failed → dispatchable (resume/retry re-mint signal, N1)', () => {
    expect(isDispatchable(run({ status: 'failed' }), 'agent-single', NO_FRESH, [], emptyDef)).toBe(
      true,
    )
  })
  test('interrupted → dispatchable (daemon-restart resume, N1)', () => {
    expect(
      isDispatchable(run({ status: 'interrupted' }), 'agent-single', NO_FRESH, [], emptyDef),
    ).toBe(true)
  })

  // HIGH-2 — exhausted (loop-max) is a true terminal, NOT dispatchable.
  test('exhausted → NOT dispatchable (loop-max true terminal, HIGH-2)', () => {
    expect(
      isDispatchable(run({ status: 'exhausted' }), 'wrapper-loop', NO_FRESH, [], emptyDef),
    ).toBe(false)
  })
  // RFC-095 (audit S-22) — the canceled flip: a plain canceled row joins the
  // N1 revival class (failed/interrupted). Execution was externally cut short;
  // retryNode→runTask on a canceled task must be able to re-mint the sibling
  // canceled rows instead of stranding them in the S-12 no-bucket black hole.
  test('canceled WITHOUT supersede marker → dispatchable (revival signal, RFC-095 S-22)', () => {
    expect(
      isDispatchable(
        run({ status: 'canceled', errorMessage: null }),
        'agent-single',
        NO_FRESH,
        [],
        emptyDef,
      ),
    ).toBe(true)
    // 'aborted by signal' is what the runner stamps on a task-cancel kill —
    // an ordinary cancellation, NOT a supersede marker.
    expect(
      isDispatchable(
        run({ status: 'canceled', errorMessage: 'aborted by signal' }),
        'agent-single',
        NO_FRESH,
        [],
        emptyDef,
      ),
    ).toBe(true)
  })
  // EXCEPT inside the review-supersede await window: submitReviewDecision flips
  // the old author row to canceled (errorMessage = marker) BEFORE minting the
  // pending rerun — dispatching the marker row there would run the agent
  // without its review context. The marker row stays parked forever; the rerun
  // row (fresh ULID) carries the revival.
  test('canceled WITH review-supersede marker → NOT dispatchable (supersede window stays parked)', () => {
    expect(
      isDispatchable(
        run({
          status: 'canceled',
          supersededByReview: 'iterated',
          errorMessage: 'superseded-by-review-iterated: superseded by review decision',
        }),
        'agent-single',
        NO_FRESH,
        [],
        emptyDef,
      ),
    ).toBe(false)
  })
  test('running → NOT dispatchable (in flight)', () => {
    expect(isDispatchable(run({ status: 'running' }), 'agent-single', NO_FRESH, [], emptyDef)).toBe(
      false,
    )
  })

  // C2 — a FRESH leaf parked node never re-dispatches (the round-1 busy-loop
  // fix); the `run` helper defaults consumed=null ⇒ always fresh.
  test('FRESH leaf awaiting_human (clarify) → NOT dispatchable (C2)', () => {
    expect(
      isDispatchable(run({ status: 'awaiting_human' }), 'clarify', NO_FRESH, [], emptyDef),
    ).toBe(false)
  })
  test('FRESH leaf awaiting_review (review) → NOT dispatchable (C2)', () => {
    expect(
      isDispatchable(run({ status: 'awaiting_review' }), 'review', NO_FRESH, [], emptyDef),
    ).toBe(false)
  })

  // RFC-076 S8/S11 fix — a STALE parked leaf (consumed an upstream run that has
  // since advanced) MUST re-dispatch, symmetric with stale `done`. Otherwise
  // approving a review built on an obsolete upstream re-reviews on next entry.
  // `dispatchedThisInvocation` (N3, in deriveFrontier) bounds the re-run to once.
  test('STALE leaf awaiting_review → dispatchable (re-park against fresh upstream, S8/S11)', () => {
    const staleParked = run({
      status: 'awaiting_review',
      consumedUpstreamRunsJson: JSON.stringify({ up: '01OLD' }),
    })
    expect(isDispatchable(staleParked, 'review', STALE_FRESHEST, [], emptyDef)).toBe(true)
  })
  test('STALE leaf awaiting_human → dispatchable (symmetry with stale done)', () => {
    const staleParked = run({
      status: 'awaiting_human',
      consumedUpstreamRunsJson: JSON.stringify({ up: '01OLD' }),
    })
    expect(isDispatchable(staleParked, 'clarify', STALE_FRESHEST, [], emptyDef)).toBe(true)
  })

  // N2 — wrapper awaiting_* is a resume anchor, dispatchable iff inner has fresh work.
  test('wrapper-loop awaiting_human WITH fresh inner pending → dispatchable (N2)', () => {
    const wrapDef = def([
      { id: 'lw', kind: 'wrapper-loop', nodeIds: ['inner_agent'] },
      { id: 'inner_agent', kind: 'agent-single' },
    ])
    const wrapperRow = run({
      nodeId: 'lw',
      status: 'awaiting_human',
      iteration: 0,
      wrapperProgressJson: encodeWrapperProgress({ kind: 'loop', iteration: 2, phase: 'awaiting' }),
    })
    const rows = [
      wrapperRow,
      run({ id: '01P', nodeId: 'inner_agent', status: 'pending', iteration: 2 }),
    ]
    expect(isDispatchable(wrapperRow, 'wrapper-loop', NO_FRESH, rows, wrapDef)).toBe(true)
  })
  test('wrapper-loop awaiting_human WITHOUT fresh inner → NOT dispatchable (stay parked)', () => {
    const wrapDef = def([
      { id: 'lw', kind: 'wrapper-loop', nodeIds: ['inner_agent'] },
      { id: 'inner_agent', kind: 'agent-single' },
    ])
    const wrapperRow = run({
      nodeId: 'lw',
      status: 'awaiting_human',
      iteration: 0,
      wrapperProgressJson: encodeWrapperProgress({ kind: 'loop', iteration: 2, phase: 'awaiting' }),
    })
    // inner only has a DONE row at iter 2 — no pending → user hasn't answered.
    const rows = [
      wrapperRow,
      run({ id: '01D', nodeId: 'inner_agent', status: 'done', iteration: 2 }),
    ]
    expect(isDispatchable(wrapperRow, 'wrapper-loop', NO_FRESH, rows, wrapDef)).toBe(false)
  })
})

describe('RFC-076 PR-A — wrapperHasFreshInnerWork (HIGH-1 iteration window)', () => {
  const loopDef = def([
    { id: 'lw', kind: 'wrapper-loop', nodeIds: ['a', 'c'] },
    { id: 'a', kind: 'agent-single' },
    { id: 'c', kind: 'clarify' },
  ])

  // HIGH-1 KEY: wrapper row at iteration 0, inner rerun at loop counter 2.
  test('loop: inner pending at progress.iteration (i≥1) while wrapper row at iter 0 → true', () => {
    const wrapperRow = run({
      nodeId: 'lw',
      iteration: 0, // parentIteration
      status: 'awaiting_human',
      wrapperProgressJson: encodeWrapperProgress({ kind: 'loop', iteration: 2, phase: 'awaiting' }),
    })
    const rows = [wrapperRow, run({ id: '01P', nodeId: 'a', status: 'pending', iteration: 2 })]
    expect(wrapperHasFreshInnerWork(wrapperRow, rows, loopDef)).toBe(true)
  })

  // Iteration window must be precise: a pending at the WRONG iteration doesn't count.
  test('loop: inner pending at iteration 1 but progress.iteration 2 → false (window precise)', () => {
    const wrapperRow = run({
      nodeId: 'lw',
      iteration: 0,
      status: 'awaiting_human',
      wrapperProgressJson: encodeWrapperProgress({ kind: 'loop', iteration: 2, phase: 'awaiting' }),
    })
    const rows = [wrapperRow, run({ id: '01P', nodeId: 'a', status: 'pending', iteration: 1 })]
    expect(wrapperHasFreshInnerWork(wrapperRow, rows, loopDef)).toBe(false)
  })

  test('loop: no inner pending anywhere → false', () => {
    const wrapperRow = run({
      nodeId: 'lw',
      iteration: 0,
      status: 'awaiting_human',
      wrapperProgressJson: encodeWrapperProgress({ kind: 'loop', iteration: 2, phase: 'awaiting' }),
    })
    const rows = [wrapperRow, run({ id: '01D', nodeId: 'a', status: 'done', iteration: 2 })]
    expect(wrapperHasFreshInnerWork(wrapperRow, rows, loopDef)).toBe(false)
  })

  test('loop: malformed/absent progress → fallback iteration 0', () => {
    const wrapperRow = run({
      nodeId: 'lw',
      iteration: 0,
      status: 'awaiting_human',
      wrapperProgressJson: null,
    })
    const atZero = [wrapperRow, run({ id: '01P', nodeId: 'a', status: 'pending', iteration: 0 })]
    expect(wrapperHasFreshInnerWork(wrapperRow, atZero, loopDef)).toBe(true)
    const atTwo = [wrapperRow, run({ id: '01P', nodeId: 'a', status: 'pending', iteration: 2 })]
    expect(wrapperHasFreshInnerWork(wrapperRow, atTwo, loopDef)).toBe(false)
  })

  // git inner shares the wrapper's own iteration.
  test('git: inner pending at the wrapper row iteration → true', () => {
    const gitDef = def([
      { id: 'gw', kind: 'wrapper-git', nodeIds: ['a'] },
      { id: 'a', kind: 'agent-single' },
    ])
    const wrapperRow = run({ nodeId: 'gw', iteration: 3, status: 'awaiting_review' })
    const rows = [wrapperRow, run({ id: '01P', nodeId: 'a', status: 'pending', iteration: 3 })]
    expect(wrapperHasFreshInnerWork(wrapperRow, rows, gitDef)).toBe(true)
    // pending at a different iteration → false
    const wrong = [wrapperRow, run({ id: '01P', nodeId: 'a', status: 'pending', iteration: 0 })]
    expect(wrapperHasFreshInnerWork(wrapperRow, wrong, gitDef)).toBe(false)
  })
})

// RFC-098 B3 (audit S-3) — wrapperRevivalEvidence: the review-done evidence
// extension. An approve flips the inner review row done WITHOUT minting any
// pending row, so a done∧fresh REVIEW row inside the window is now revival
// evidence. The review-kind restriction is load-bearing: an ordinary inner
// agent's done row must NOT unlock (the N2 cases above lock that with an
// agent-done fixture — both stay green by construction). The deep S-3 lock
// (post-approve loop/git shapes, max-id selection, revision-#8 fresh
// contract) lives in scheduler-audit-s03-wrapper-approve-stuck.test.ts.
describe('RFC-098 B3 — wrapperRevivalEvidence (review done∧fresh extension)', () => {
  const loopDef = def([
    { id: 'lw', kind: 'wrapper-loop', nodeIds: ['worker', 'rev'] },
    { id: 'worker', kind: 'agent-single' },
    { id: 'rev', kind: 'review' },
  ])
  const parked = run({
    id: '01W',
    nodeId: 'lw',
    iteration: 0,
    status: 'awaiting_review',
    wrapperProgressJson: encodeWrapperProgress({ kind: 'loop', iteration: 1, phase: 'awaiting' }),
  })
  // Helper rows must be TOP-LEVEL (parentNodeRunId null) so the in-window
  // freshest-done map sees them.
  function top(over: Partial<Row>): Row {
    return run({ parentNodeRunId: null, ...over } as Partial<Row>)
  }

  test('正例：窗口内 review done∧fresh 行即证据 → 谓词放行（approve 形态）', () => {
    const rows = [
      parked,
      top({ id: '01A', nodeId: 'worker', status: 'done', iteration: 1 }),
      top({ id: '01B', nodeId: 'rev', status: 'done', iteration: 1 }),
    ]
    expect(wrapperRevivalEvidence(parked, rows, loopDef)).toEqual({ rowId: '01B', nodeId: 'rev' })
    expect(wrapperHasFreshInnerWork(parked, rows, loopDef)).toBe(true)
    expect(isDispatchable(parked, 'wrapper-loop', NO_FRESH, rows, loopDef)).toBe(true)
  })

  test('负例：非 review 的 inner done（agent）不是证据 → 不解锁（clarify park 不受影响）', () => {
    const rows = [parked, top({ id: '01A', nodeId: 'worker', status: 'done', iteration: 1 })]
    expect(wrapperRevivalEvidence(parked, rows, loopDef)).toBeNull()
    expect(wrapperHasFreshInnerWork(parked, rows, loopDef)).toBe(false)
    expect(isDispatchable(parked, 'wrapper-loop', NO_FRESH, rows, loopDef)).toBe(false)
  })

  test('负例：review done 但 stale（消费的 inner 上游已推进）→ 不是证据', () => {
    const rows = [
      parked,
      top({ id: '01A', nodeId: 'worker', status: 'done', iteration: 1 }),
      top({
        id: '019',
        nodeId: 'rev',
        status: 'done',
        iteration: 1,
        consumedUpstreamRunsJson: JSON.stringify({ worker: '01OLD' }),
      }),
    ]
    expect(wrapperRevivalEvidence(parked, rows, loopDef)).toBeNull()
  })

  test('窗口规则对 review done 同样生效：落在窗口外的 review done 不解锁', () => {
    const rows = [
      parked,
      // review done at iteration 0 — outside the progress window (1).
      top({ id: '01B', nodeId: 'rev', status: 'done', iteration: 0 }),
    ]
    expect(wrapperRevivalEvidence(parked, rows, loopDef)).toBeNull()
  })

  test('证据选取 max-id：pending 与 review-done 并存时取 id 最大的行', () => {
    const rows = [
      parked,
      top({ id: '01B', nodeId: 'rev', status: 'done', iteration: 1 }),
      top({ id: '01C', nodeId: 'worker', status: 'pending', iteration: 1 }),
    ]
    expect(wrapperRevivalEvidence(parked, rows, loopDef)).toEqual({
      rowId: '01C',
      nodeId: 'worker',
    })
  })
})

describe('RFC-076 PR-A — wrapperInnerDescendants (G6 recursive expansion)', () => {
  test('nested git ∋ loop ∋ {agent,clarify} → all descendants collected', () => {
    const nested = def([
      { id: 'gw', kind: 'wrapper-git', nodeIds: ['lw'] },
      { id: 'lw', kind: 'wrapper-loop', nodeIds: ['a', 'c'] },
      { id: 'a', kind: 'agent-single' },
      { id: 'c', kind: 'clarify' },
    ])
    const d = wrapperInnerDescendants('gw', nested)
    expect([...d].sort()).toEqual(['a', 'c', 'lw'])
  })

  test('non-wrapper / unknown id → empty set; cycle-safe', () => {
    const d = def([{ id: 'a', kind: 'agent-single' }])
    expect(wrapperInnerDescendants('a', d).size).toBe(0)
    expect(wrapperInnerDescendants('ghost', d).size).toBe(0)
    // defensive cycle: gw contains itself
    const cyclic = def([
      { id: 'gw', kind: 'wrapper-git', nodeIds: ['gw', 'x'] },
      { id: 'x', kind: 'agent-single' },
    ])
    expect([...wrapperInnerDescendants('gw', cyclic)].sort()).toEqual(['gw', 'x'])
  })
})

// RFC-098 B3 (audit S-7) — wrapperExternalUpstreamSources: the provenance key
// set computeWrapperConsumed stamps onto loop/git wrapper rows at fresh-mint.
// Locks the membership rule (external → inner-descendant ∪ wrapper-self) and
// the channel-edge filtering, which MUST stay in lockstep with
// buildScopeUpstreams (scheduler.ts) — see the function doc.
describe('RFC-098 B3 — wrapperExternalUpstreamSources', () => {
  type EdgeSpec = { id: string; s: [string, string]; t: [string, string] }
  function defWithEdges(
    nodes: Array<Record<string, unknown> & { id: string; kind: NodeKind }>,
    edges: EdgeSpec[],
  ): WorkflowDefinition {
    return {
      nodes,
      edges: edges.map((e) => ({
        id: e.id,
        source: { nodeId: e.s[0], portName: e.s[1] },
        target: { nodeId: e.t[0], portName: e.t[1] },
      })),
    } as unknown as WorkflowDefinition
  }

  test('external → inner edge AND external → wrapper-self (ordering) edge both count; intra-wrapper edges do not', () => {
    const d = defWithEdges(
      [
        { id: 'up', kind: 'agent-single' },
        { id: 'order-src', kind: 'wrapper-git', nodeIds: ['x'] },
        { id: 'x', kind: 'agent-single' },
        { id: 'lw', kind: 'wrapper-loop', nodeIds: ['a', 'b'] },
        { id: 'a', kind: 'agent-single' },
        { id: 'b', kind: 'agent-single' },
      ],
      [
        { id: 'e1', s: ['up', 'doc'], t: ['a', 'doc'] }, // external → inner
        { id: 'e2', s: ['order-src', 'git_diff'], t: ['lw', 'dep'] }, // external → wrapper self (s04-style sequencing edge)
        { id: 'e3', s: ['a', 'out'], t: ['b', 'in'] }, // intra-wrapper — NOT a source
      ],
    )
    expect([...wrapperExternalUpstreamSources('lw', d)].sort()).toEqual(['order-src', 'up'])
  })

  test('nested wrappers: sources of deep inner descendants are collected once', () => {
    const d = defWithEdges(
      [
        { id: 'up', kind: 'agent-single' },
        { id: 'gw', kind: 'wrapper-git', nodeIds: ['lw'] },
        { id: 'lw', kind: 'wrapper-loop', nodeIds: ['a'] },
        { id: 'a', kind: 'agent-single' },
      ],
      [
        { id: 'e1', s: ['up', 'doc'], t: ['a', 'doc'] },
        { id: 'e2', s: ['up', 'doc'], t: ['lw', 'dep'] },
      ],
    )
    expect([...wrapperExternalUpstreamSources('gw', d)]).toEqual(['up'])
    // From the INNER loop's perspective `up` is also external.
    expect([...wrapperExternalUpstreamSources('lw', d)]).toEqual(['up'])
  })

  test('channel edges are filtered exactly like buildScopeUpstreams', () => {
    const d = defWithEdges(
      [
        { id: 'helper', kind: 'agent-single' },
        { id: 'cc', kind: 'clarify-cross-agent' },
        { id: 'questioner', kind: 'agent-single' },
        { id: 'lw', kind: 'wrapper-loop', nodeIds: ['ag', 'cl', 'inner-cc'] },
        { id: 'ag', kind: 'agent-single' },
        { id: 'cl', kind: 'clarify' },
        { id: 'inner-cc', kind: 'clarify-cross-agent' },
      ],
      [
        // answer / feedback back-channels into the inner agent → filtered.
        { id: 'e1', s: ['cl', 'answers'], t: ['ag', '__clarify_response__'] },
        { id: 'e2', s: ['cc', 'to_designer'], t: ['ag', '__external_feedback__'] },
        { id: 'e3', s: ['cc', 'to_questioner'], t: ['ag', '__clarify_response__'] },
        // external agent.__clarify__ → inner clarify node → filtered (clarify
        // nodes are dispatched out-of-band).
        { id: 'e4', s: ['helper', '__clarify__'], t: ['cl', 'questions'] },
        // external questioner.__clarify__ → inner clarify-cross-agent → KEPT
        // (real dataflow dep — the buildScopeUpstreams carve-out).
        { id: 'e5', s: ['questioner', '__clarify__'], t: ['inner-cc', 'questions'] },
      ],
    )
    expect([...wrapperExternalUpstreamSources('lw', d)]).toEqual(['questioner'])
  })

  test('review inputSource: external implicit dep counts; in-scope one does not', () => {
    const d = defWithEdges(
      [
        { id: 'designer', kind: 'agent-single' },
        { id: 'lw', kind: 'wrapper-loop', nodeIds: ['rev', 'author'] },
        { id: 'author', kind: 'agent-single' },
        {
          id: 'rev',
          kind: 'review',
          inputSource: { nodeId: 'designer', portName: 'doc' },
        },
      ],
      [],
    )
    expect([...wrapperExternalUpstreamSources('lw', d)]).toEqual(['designer'])
    // Same review pointing at an in-scope sibling → intra-wrapper dataflow,
    // not provenance.
    const d2 = defWithEdges(
      [
        { id: 'lw', kind: 'wrapper-loop', nodeIds: ['rev', 'author'] },
        { id: 'author', kind: 'agent-single' },
        { id: 'rev', kind: 'review', inputSource: { nodeId: 'author', portName: 'doc' } },
      ],
      [],
    )
    expect(wrapperExternalUpstreamSources('lw', d2).size).toBe(0)
  })

  test('no external edges → empty set (consumed degrades to {})', () => {
    const d = defWithEdges(
      [
        { id: 'lw', kind: 'wrapper-loop', nodeIds: ['a'] },
        { id: 'a', kind: 'agent-single' },
      ],
      [],
    )
    expect(wrapperExternalUpstreamSources('lw', d).size).toBe(0)
  })
})
