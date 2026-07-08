// RFC-095 — scope-outcome exhaustive bucketing
// (design/RFC-095-scope-outcome-exhaustive/design.md; audit S-12 / S-22 / S-1).
//
// Pure-function locks for the three RFC-095 surfaces:
//
//   1. decideScopeOutcome (dispatchFrontier.ts) — the quiescent-scope decision
//      extracted from runScope's inline if-chain. Priority is byte-equivalent
//      to the pre-RFC-095 block: awaitingHuman > awaitingReview >
//      firstFailureDetail > exhausted > allSettled→ok > stalled. Only
//      increment: the stalled summary now names the Frontier.blocked nodes
//      (audit S-12 — the old "scheduler stalled" named no node at all) while
//      the machine-facing message stays 'no ready nodes in scope'.
//
//   2. deriveFrontier (scheduler.ts) NodeRunStatus-UNIVERSE property (design
//      §2.3, runtime half — the compile-time half is the assertNever switches):
//      every status in shared NODE_RUN_STATUS lands in EXACTLY ONE of
//      completed / ready / awaitingReview / awaitingHuman / failed / exhausted
//      / blocked. A new status value added without an EXPECTED_BUCKET row turns
//      this red at runtime (and the Record<NodeRunStatus, …> type at tsc time).
//
//   3. canceled-revival semantics (audit S-22): a plain canceled row is a
//      REVIVAL signal (dispatchable, same class as interrupted — this FLIPS
//      the pre-RFC-095 "canceled → NOT dispatchable" lock). ONLY a
//      review-supersede marker row (errorMessage prefix
//      'superseded-by-review-') stays parked: submitReviewDecision flips the
//      old author row to canceled BEFORE minting the pending rerun, and
//      dispatching inside that await window would run the agent without its
//      review context.
//
// Frontier.blocked[].reason is a DIAGNOSTIC payload, not an API contract —
// assertions below prefix-match only (design §2.2 备注).

import { describe, expect, test } from 'bun:test'
import type { NodeKind, NodeRunStatus, WorkflowDefinition } from '@agent-workflow/shared'
import { NODE_RUN_STATUS } from '@agent-workflow/shared'
import type { nodeRuns } from '../src/db/schema'
import {
  decideScopeOutcome,
  isDispatchable,
  isReviewSupersededRow,
  type ScopeOutcome,
  type ScopeOutcomeInput,
} from '../src/services/dispatchFrontier'
import { deriveFrontier, type Frontier } from '../src/services/scheduler'

type Row = typeof nodeRuns.$inferSelect
type WorkflowNode = WorkflowDefinition['nodes'][number]
const NONE: ReadonlySet<string> = new Set()

let seq = 0
function row(nodeId: string, status: string, over: Partial<Row> = {}): Row {
  // Monotonic id so isFresherNodeRun (pure id-order) picks the last-inserted
  // row (same pattern as derive-frontier.test.ts).
  seq += 1
  return {
    id: `01R${String(seq).padStart(4, '0')}`,
    nodeId,
    iteration: 0,
    status,
    parentNodeRunId: null,
    consumedUpstreamRunsJson: null,
    wrapperProgressJson: null,
    errorMessage: null,
    ...over,
  } as unknown as Row
}

function def(nodes: Array<{ id: string; kind: NodeKind }>): {
  definition: WorkflowDefinition
  scopeNodes: WorkflowNode[]
  scopeIds: Set<string>
} {
  const definition = { nodes, edges: [] } as unknown as WorkflowDefinition
  return {
    definition,
    scopeNodes: nodes as unknown as WorkflowNode[],
    scopeIds: new Set(nodes.map((n) => n.id)),
  }
}

const ups = (m: Record<string, string[]>): Map<string, string[]> => new Map(Object.entries(m))

// -----------------------------------------------------------------------------
// 1. decideScopeOutcome — priority matrix (table-driven)
// -----------------------------------------------------------------------------

function scope(over: Partial<ScopeOutcomeInput> = {}): ScopeOutcomeInput {
  return {
    awaitingHuman: [],
    awaitingReview: [],
    exhausted: [],
    failed: [],
    blocked: [],
    allSettled: false,
    ...over,
  }
}

const FFD = { summary: 'node x failed: exit 1', message: 'exit 1', nodeId: 'x' }

describe('RFC-095 — decideScopeOutcome priority matrix', () => {
  const matrix: Array<{
    name: string
    input: ScopeOutcomeInput
    ffd?: { summary: string; message: string; nodeId?: string }
    expected: ScopeOutcome
  }> = [
    {
      name: 'awaitingHuman alone → awaiting_human, nodeId = first entry',
      input: scope({ awaitingHuman: ['h1', 'h2'] }),
      expected: { kind: 'awaiting_human', nodeId: 'h1' },
    },
    {
      name: 'awaitingHuman + awaitingReview both present → human wins',
      input: scope({ awaitingHuman: ['h1'], awaitingReview: ['r1'] }),
      expected: { kind: 'awaiting_human', nodeId: 'h1' },
    },
    {
      name: 'awaitingReview alone → awaiting_review, nodeId = first entry',
      input: scope({ awaitingReview: ['r1', 'r2'] }),
      expected: { kind: 'awaiting_review', nodeId: 'r1' },
    },
    {
      name: 'awaitingReview + firstFailureDetail → review wins',
      input: scope({ awaitingReview: ['r1'] }),
      ffd: FFD,
      expected: { kind: 'awaiting_review', nodeId: 'r1' },
    },
    {
      name: 'firstFailureDetail alone → failed with the passed detail verbatim',
      input: scope(),
      ffd: FFD,
      expected: { kind: 'failed', detail: { ...FFD } },
    },
    {
      name: 'firstFailureDetail + exhausted → firstFailureDetail wins (no synthesis)',
      input: scope({ exhausted: ['loopA'] }),
      ffd: FFD,
      expected: { kind: 'failed', detail: { ...FFD } },
    },
    {
      name: 'exhausted alone → synthesized wrapper-loop-exhausted detail, nodeId = exhausted[0]',
      input: scope({ exhausted: ['loopA', 'loopB'] }),
      expected: {
        kind: 'failed',
        detail: {
          summary: 'wrapper-loop loopA exhausted (max iterations reached)',
          message: 'wrapper-loop-exhausted',
          nodeId: 'loopA',
        },
      },
    },
    {
      name: 'exhausted + allSettled → exhausted still fails (never falls through to ok)',
      input: scope({ exhausted: ['loopA'], allSettled: true }),
      expected: {
        kind: 'failed',
        detail: {
          summary: 'wrapper-loop loopA exhausted (max iterations reached)',
          message: 'wrapper-loop-exhausted',
          nodeId: 'loopA',
        },
      },
    },
    {
      name: 'allSettled, everything empty → ok',
      input: scope({ allSettled: true }),
      expected: { kind: 'ok' },
    },
    {
      // Synthetic input (a real allSettled frontier has empty blocked, since
      // every node is completed) — locks the ORDERING: allSettled→ok is
      // checked before the stalled fallback.
      name: 'allSettled → ok even with blocked diagnostics present (ordering lock)',
      input: scope({
        allSettled: true,
        blocked: [{ nodeId: 'z', status: 'running', reason: 'whatever' }],
      }),
      expected: { kind: 'ok' },
    },
    {
      name: 'everything empty ∧ !allSettled → stalled (failed, machine-stable message)',
      input: scope(),
      expected: {
        kind: 'failed',
        detail: { summary: 'scheduler stalled', message: 'no ready nodes in scope' },
      },
    },
    {
      name: 'full stack (human + review + ffd + exhausted + failed + blocked + allSettled) → human wins',
      input: scope({
        awaitingHuman: ['h1'],
        awaitingReview: ['r1'],
        exhausted: ['loopA'],
        failed: ['f1'],
        blocked: [{ nodeId: 'b1', status: 'running', reason: 'r' }],
        allSettled: true,
      }),
      ffd: FFD,
      expected: { kind: 'awaiting_human', nodeId: 'h1' },
    },
  ]

  for (const c of matrix) {
    test(c.name, () => {
      expect(decideScopeOutcome(c.input, c.ffd)).toEqual(c.expected)
    })
  }
})

// -----------------------------------------------------------------------------
// 2. stalled diagnostics — summary carries blocked + failed-parked (audit S-12)
// -----------------------------------------------------------------------------

describe('RFC-095 — stalled diagnostics', () => {
  test('summary names every blocked node (id, status, reason prefix) + failed-parked list; nodeId = blocked[0]', () => {
    const out = decideScopeOutcome(
      scope({
        blocked: [
          {
            nodeId: 'nA',
            status: 'running',
            reason: 'orphaned-running-row (restart daemon to reap, audit S-12)',
          },
          { nodeId: 'nB', status: 'canceled', reason: 'review-superseded' },
        ],
        failed: ['nC'],
      }),
    )
    if (out.kind !== 'failed') throw new Error(`expected kind=failed, got ${out.kind}`)
    expect(out.detail.message).toBe('no ready nodes in scope')
    expect(out.detail.nodeId).toBe('nA') // blocked[0].nodeId
    const s = out.detail.summary
    expect(s.startsWith('scheduler stalled')).toBe(true)
    // reason is diagnostic free text — prefix-match only.
    expect(s).toContain('nA(running: orphaned-running-row')
    expect(s).toContain('nB(canceled: review-superseded')
    expect(s).toContain('failed parked: nC')
  })

  test('no blocked, no failed → bare "scheduler stalled" summary, no nodeId', () => {
    const out = decideScopeOutcome(scope())
    if (out.kind !== 'failed') throw new Error(`expected kind=failed, got ${out.kind}`)
    expect(out.detail.summary).toBe('scheduler stalled')
    expect(out.detail.message).toBe('no ready nodes in scope')
    expect(out.detail.nodeId).toBeUndefined()
    expect('nodeId' in out.detail).toBe(false)
  })

  test('failed-parked only (no blocked) → tail without blocked list, still no nodeId', () => {
    const out = decideScopeOutcome(scope({ failed: ['nC'] }))
    if (out.kind !== 'failed') throw new Error(`expected kind=failed, got ${out.kind}`)
    expect(out.detail.summary).toBe('scheduler stalled; failed parked: nC')
    expect(out.detail.nodeId).toBeUndefined()
  })
})

// -----------------------------------------------------------------------------
// 3. deriveFrontier — NodeRunStatus universe property (design §2.3)
// -----------------------------------------------------------------------------

type Bucket =
  | 'completed'
  | 'ready'
  | 'awaitingReview'
  | 'awaitingHuman'
  | 'failed'
  | 'exhausted'
  | 'blocked'

function buckets(f: Frontier, nodeId: string): Bucket[] {
  const out: Bucket[] = []
  if (f.completed.has(nodeId)) out.push('completed')
  if (f.ready.includes(nodeId)) out.push('ready')
  if (f.awaitingReview.includes(nodeId)) out.push('awaitingReview')
  if (f.awaitingHuman.includes(nodeId)) out.push('awaitingHuman')
  if (f.failed.includes(nodeId)) out.push('failed')
  if (f.exhausted.includes(nodeId)) out.push('exhausted')
  if (f.blocked.some((b) => b.nodeId === nodeId)) out.push('blocked')
  return out
}

/**
 * Single node `n` (agent-single, no upstreams, not in flight), latest = the
 * given row. dedup defaults to {n} — "already dispatched this invocation" —
 * which is the harness that routes non-park statuses into `blocked` instead of
 * `ready` (the diagnostic branches only fire behind the dedup/anchor gates).
 */
function frontierFor(latest: Row, opts: { dedup?: ReadonlySet<string> } = {}): Frontier {
  const { definition, scopeNodes, scopeIds } = def([{ id: 'n', kind: 'agent-single' }])
  return deriveFrontier(
    [latest],
    definition,
    scopeNodes,
    scopeIds,
    0,
    ups({}),
    NONE,
    opts.dedup ?? new Set(['n']),
    NONE,
  )
}

// Expected classification under the dedup harness. Typed Record over the FULL
// NodeRunStatus union: a new status value fails tsc here; the runtime
// toBeDefined() guard below fails bun:test (which transpiles without checking).
const EXPECTED_BUCKET: Record<NodeRunStatus, Bucket> = {
  // RFC-092 pending-anchor bypass: a pending latest row short-circuits the
  // node-level dedup (released once per ROW id) → ready even when dedup'd.
  pending: 'ready',
  running: 'blocked',
  done: 'completed', // consumed=null ⇒ fresh ⇒ pass-1 completed
  failed: 'failed', // park bucket collects UNCONDITIONALLY
  // Unmarked canceled IS dispatchable (revival, S-22), but the dedup gate
  // blocks it this invocation → falls into the canceled diagnostic branch
  // with its own reason ('canceled-in-invocation-dedup'); only marker rows
  // read 'review-superseded' (reason is diagnostic payload, not a contract).
  canceled: 'blocked',
  interrupted: 'blocked',
  skipped: 'blocked',
  exhausted: 'exhausted', // pass-1 terminal-failure bucket
  awaiting_review: 'awaitingReview', // park bucket, unconditional
  awaiting_human: 'awaitingHuman', // park bucket, unconditional
}

// For statuses landing in `blocked`: the expected diagnostic reason PREFIX.
const BLOCKED_REASON_PREFIX: Partial<Record<NodeRunStatus, string>> = {
  running: 'orphaned-running-row',
  canceled: 'canceled-in-invocation-dedup',
  interrupted: 'interrupted-in-invocation-dedup',
  skipped: 'skipped-has-no-dispatch-semantics',
}

describe('RFC-095 — NodeRunStatus universe → exactly one frontier bucket', () => {
  for (const status of NODE_RUN_STATUS) {
    test(`${status} → exactly [${EXPECTED_BUCKET[status]}]`, () => {
      // Runtime half of the double insurance: a NEW NodeRunStatus value that
      // nobody registered in EXPECTED_BUCKET must turn this red.
      expect(EXPECTED_BUCKET[status]).toBeDefined()
      const r = row('n', status)
      const f = frontierFor(r)
      expect(buckets(f, 'n')).toEqual([EXPECTED_BUCKET[status]])
      const prefix = BLOCKED_REASON_PREFIX[status]
      if (prefix !== undefined) {
        const b = f.blocked.find((x) => x.nodeId === 'n')
        expect(b?.status).toBe(status)
        expect(b?.reason.startsWith(prefix)).toBe(true)
      }
      if (status === 'pending') {
        // The anchor row id is what the caller records into
        // dispatchedPendingRowIds — prove the bypass (not plain dedup miss)
        // is what made it ready.
        expect(f.pendingAnchors.get('n')).toBe(r.id)
      }
    })
  }

  test('control — canceled NOT in dedup → ready (revival dispatch, audit S-22)', () => {
    const f = frontierFor(row('n', 'canceled'), { dedup: NONE })
    expect(buckets(f, 'n')).toEqual(['ready'])
  })

  test('control — superseded canceled row, dedup empty → blocked(review-superseded), NOT ready', () => {
    const marked = row('n', 'canceled', { supersededByReview: 'iterated' })
    const f = frontierFor(marked, { dedup: NONE })
    expect(buckets(f, 'n')).toEqual(['blocked'])
    const b = f.blocked.find((x) => x.nodeId === 'n')
    expect(b?.status).toBe('canceled')
    expect(b?.reason.startsWith('review-superseded')).toBe(true)
  })
})

// Diagnostic branches the single-row universe harness cannot reach (they need
// a stale done / consumed anchor / open session) — covers the remaining
// blocked reason values from design §2.2.
describe('RFC-095 — blocked diagnostic branches beyond the single-row universe', () => {
  test('stale done in invocation dedup → blocked(stale-done-in-invocation-dedup)', () => {
    const { definition, scopeNodes, scopeIds } = def([
      { id: 'up', kind: 'agent-single' },
      { id: 'a', kind: 'agent-single' },
    ])
    const upOld = row('up', 'done')
    const aDone = row('a', 'done', {
      consumedUpstreamRunsJson: JSON.stringify({ up: upOld.id }),
    })
    const upNew = row('up', 'done') // upstream advanced → aDone is stale
    const f = deriveFrontier(
      [upOld, aDone, upNew],
      definition,
      scopeNodes,
      scopeIds,
      0,
      ups({ a: ['up'] }),
      NONE,
      new Set(['a']),
      NONE,
    )
    expect(buckets(f, 'a')).toEqual(['blocked'])
    const b = f.blocked.find((x) => x.nodeId === 'a')
    expect(b?.status).toBe('done')
    expect(b?.reason.startsWith('stale-done-in-invocation-dedup')).toBe(true)
  })

  test('consumed pending anchor (row id already released) → blocked(pending-anchor-consumed)', () => {
    const { definition, scopeNodes, scopeIds } = def([{ id: 'n', kind: 'agent-single' }])
    const p = row('n', 'pending')
    const f = deriveFrontier(
      [p],
      definition,
      scopeNodes,
      scopeIds,
      0,
      ups({}),
      NONE,
      new Set(['n']),
      NONE,
      new Set(),
      new Set([p.id]), // dispatchedPendingRowIds — the anchor was consumed
    )
    expect(f.ready).toEqual([])
    expect(buckets(f, 'n')).toEqual(['blocked'])
    const b = f.blocked.find((x) => x.nodeId === 'n')
    expect(b?.status).toBe('pending')
    expect(b?.reason.startsWith('pending-anchor-consumed')).toBe(true)
  })

  test('pending rerun while its asking clarify session is still open → blocked(open-clarify-window)', () => {
    // The legacy quick channel minted the rerun BEFORE flipping the session;
    // the guard stays generic: a pending row must NOT release while its asking
    // clarify session is still open (RFC-092 / audit S-1).
    const { definition, scopeNodes, scopeIds } = def([{ id: 'n', kind: 'agent-single' }])
    const asking = row('n', 'done')
    const rerun = row('n', 'pending') // later id → latest
    const f = deriveFrontier(
      [asking, rerun],
      definition,
      scopeNodes,
      scopeIds,
      0,
      ups({}),
      NONE,
      new Set(['n']),
      NONE,
      new Set([asking.id]), // askingRunIds — the asking run's session is open
    )
    expect(buckets(f, 'n')).toEqual(['blocked'])
    const b = f.blocked.find((x) => x.nodeId === 'n')
    expect(b?.status).toBe('pending')
    expect(b?.reason.startsWith('open-clarify-window')).toBe(true)
  })

  test('absent row, dispatched this invocation, no row written → blocked(absent, in-invocation-dedup)', () => {
    const { definition, scopeNodes, scopeIds } = def([{ id: 'n', kind: 'agent-single' }])
    const f = deriveFrontier(
      [],
      definition,
      scopeNodes,
      scopeIds,
      0,
      ups({}),
      NONE,
      new Set(['n']),
      NONE,
    )
    expect(buckets(f, 'n')).toEqual(['blocked'])
    const b = f.blocked.find((x) => x.nodeId === 'n')
    expect(b?.status).toBe('absent')
    expect(b?.reason.startsWith('in-invocation-dedup')).toBe(true)
  })

  test('clarify node with open session + dedup → blocked(absent, open-clarify-window)', () => {
    const { definition, scopeNodes, scopeIds } = def([{ id: 'c', kind: 'clarify' }])
    const f = deriveFrontier(
      [],
      definition,
      scopeNodes,
      scopeIds,
      0,
      ups({}),
      NONE,
      new Set(['c']),
      new Set(['c']), // openClarifyNodeIds — session open ⇒ pass-2 must not settle it
    )
    expect(f.completed.has('c')).toBe(false)
    expect(buckets(f, 'c')).toEqual(['blocked'])
    const b = f.blocked.find((x) => x.nodeId === 'c')
    expect(b?.status).toBe('absent')
    expect(b?.reason.startsWith('open-clarify-window')).toBe(true)
  })
})

// -----------------------------------------------------------------------------
// 4. supersede window — isDispatchable / isReviewSupersededRow pure facet
// -----------------------------------------------------------------------------

describe('RFC-095 — supersede window (isDispatchable / isReviewSupersededRow)', () => {
  const { definition } = def([{ id: 'n', kind: 'agent-single' }])
  const NO_FRESH = new Map<string, Row>()

  test('canceled WITHOUT marker → dispatchable (revival; flips the pre-RFC-095 lock)', () => {
    expect(isDispatchable(row('n', 'canceled'), 'agent-single', NO_FRESH, [], definition)).toBe(
      true,
    )
  })

  test('canceled runner-abort row ("aborted by signal") → dispatchable (the revival target)', () => {
    const aborted = row('n', 'canceled', { errorMessage: 'aborted by signal' })
    expect(isDispatchable(aborted, 'agent-single', NO_FRESH, [], definition)).toBe(true)
  })

  test('canceled WITH superseded_by_review → NOT dispatchable (parked in the supersede→mint window)', () => {
    // RFC-145: the dispatch contract reads the structured column (review.ts
    // writes it in the same supersede write; migration 0077 backfilled legacy
    // rows). errorMessage 只是人读 breadcrumb，不参与判定。
    const marked = row('n', 'canceled', {
      supersededByReview: 'iterated',
      errorMessage:
        'superseded-by-review-iterated: Replaced by retry_index 2 due to review iterated of rv',
    })
    expect(isDispatchable(marked, 'agent-single', NO_FRESH, [], definition)).toBe(false)
  })

  test('isReviewSupersededRow：列判定语义（非空即 superseded；errorMessage 不参与）', () => {
    expect(isReviewSupersededRow({ supersededByReview: null })).toBe(false)
    expect(isReviewSupersededRow({ supersededByReview: 'iterated' })).toBe(true)
    expect(isReviewSupersededRow({ supersededByReview: 'rejected' })).toBe(true)
  })

  test('列未置时即便 errorMessage 带旧 marker 文案也不判 superseded（机器地位已取消）', () => {
    const breadcrumbOnly = row('n', 'canceled', {
      errorMessage: 'superseded-by-review-iterated: legacy-looking breadcrumb',
    })
    // 现实中 0077 backfill + review.ts 双写保证列恒在；此格锁「列是唯一判据」。
    expect(isDispatchable(breadcrumbOnly, 'agent-single', NO_FRESH, [], definition)).toBe(true)
  })
})
