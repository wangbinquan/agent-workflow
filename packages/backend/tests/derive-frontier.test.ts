// RFC-076 PR-B — deriveFrontier orchestrator (the dispatch brain).
//
// End-to-end pure-function locks for the frontier derivation that runScope's
// race loop consumes every dispatch tick (LIVE since PR-B; the stale
// "currently UNWIRED" note removed by RFC-094, audit S-26). Composes fix A's
// transitive-closure readiness + PR-A's isDispatchable /
// wrapperHasFreshInnerWork + settles-without-row (C1) + N6 open-session
// evidence + N3 per-invocation dedup (+ RFC-092 pending-anchor row-id release,
// locked separately in scheduler-audit-s01 / rfc092-answer-race-window).

import { describe, expect, test } from 'bun:test'
import type { NodeKind, WorkflowDefinition } from '@agent-workflow/shared'
import type { nodeRuns } from '../src/db/schema'
import { deriveFrontier } from '../src/services/scheduler'

type Row = typeof nodeRuns.$inferSelect
const NONE: ReadonlySet<string> = new Set()

let seq = 0
function row(nodeId: string, status: string, over: Partial<Row> = {}): Row {
  // Monotonic id so isFresherNodeRun (pure id-order) picks the last-inserted row.
  seq += 1
  return {
    id: `01R${String(seq).padStart(4, '0')}`,
    nodeId,
    iteration: 0,
    status,
    parentNodeRunId: null,
    consumedUpstreamRunsJson: null,
    wrapperProgressJson: null,
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
type WorkflowNode = WorkflowDefinition['nodes'][number]

const ups = (m: Record<string, string[]>): Map<string, string[]> => new Map(Object.entries(m))

describe('RFC-076 PR-B — deriveFrontier', () => {
  test('F1 — chain all done∧fresh → completed all, ready empty, allSettled', () => {
    const { definition, scopeNodes, scopeIds } = def([
      { id: 'in', kind: 'input' },
      { id: 'a', kind: 'agent-single' },
      { id: 'out', kind: 'output' },
    ])
    const rows = [row('in', 'done'), row('a', 'done'), row('out', 'done')]
    const f = deriveFrontier(
      rows,
      definition,
      scopeNodes,
      scopeIds,
      0,
      ups({ a: ['in'], out: ['a'] }),
      NONE,
      NONE,
      NONE,
    )
    expect([...f.completed].sort()).toEqual(['a', 'in', 'out'])
    expect(f.ready).toEqual([])
    expect(f.allSettled).toBe(true)
  })

  test('F2 — out-of-band fresh pending → ready', () => {
    const { definition, scopeNodes, scopeIds } = def([
      { id: 'in', kind: 'input' },
      { id: 'a', kind: 'agent-single' },
    ])
    const rows = [row('in', 'done'), row('a', 'pending')]
    const f = deriveFrontier(
      rows,
      definition,
      scopeNodes,
      scopeIds,
      0,
      ups({ a: ['in'] }),
      NONE,
      NONE,
      NONE,
    )
    expect(f.ready).toEqual(['a'])
    expect(f.allSettled).toBe(false)
  })

  test('C1 — clarify leaf with NO row + upstream done → settles-without-row (completed), allSettled', () => {
    const { definition, scopeNodes, scopeIds } = def([
      { id: 'in', kind: 'input' },
      { id: 'a', kind: 'agent-single' },
      { id: 'c', kind: 'clarify' },
    ])
    // clarify node 'c' has NO row; its channel edges are dropped so it has no structural upstream.
    const rows = [row('in', 'done'), row('a', 'done')]
    const f = deriveFrontier(
      rows,
      definition,
      scopeNodes,
      scopeIds,
      0,
      ups({ a: ['in'] }),
      NONE,
      NONE,
      NONE,
    )
    expect(f.completed.has('c')).toBe(true)
    expect(f.ready).toEqual([])
    expect(f.allSettled).toBe(true)
  })

  test('N6 — clarify leaf with an OPEN session → NOT completed (no false-complete)', () => {
    const { definition, scopeNodes, scopeIds } = def([
      { id: 'in', kind: 'input' },
      { id: 'a', kind: 'agent-single' },
      { id: 'c', kind: 'clarify' },
    ])
    const rows = [row('in', 'done'), row('a', 'done')]
    const f = deriveFrontier(
      rows,
      definition,
      scopeNodes,
      scopeIds,
      0,
      ups({ a: ['in'] }),
      NONE,
      NONE,
      new Set(['c']), // openClarifyNodeIds — a session is open/imminent
    )
    expect(f.completed.has('c')).toBe(false)
    expect(f.allSettled).toBe(false)
  })

  test('C2 — parked clarify (awaiting_human row) → awaitingHuman bucket, not ready', () => {
    const { definition, scopeNodes, scopeIds } = def([
      { id: 'a', kind: 'agent-single' },
      { id: 'c', kind: 'clarify' },
    ])
    const rows = [row('a', 'done'), row('c', 'awaiting_human')]
    const f = deriveFrontier(rows, definition, scopeNodes, scopeIds, 0, ups({}), NONE, NONE, NONE)
    expect(f.awaitingHuman).toEqual(['c'])
    expect(f.ready).toEqual([])
    expect(f.allSettled).toBe(false)
  })

  test('asking-run park (S12): a done agent run in askingRunIds is NOT completed, parks awaitingHuman', () => {
    // designer → builder. designer emitted <workflow-clarify>: the runner marked
    // designer's OWN run `done`, but it is mid-conversation (open clarify
    // session). It must NOT complete (else builder runs prematurely on a
    // clarify-only / empty output — the S12 diamond double-run). askingRunIds
    // carries the designer run id from the open session.
    const { definition, scopeNodes, scopeIds } = def([
      { id: 'in', kind: 'input' },
      { id: 'designer', kind: 'agent-single' },
      { id: 'builder', kind: 'agent-single' },
    ])
    const designer = row('designer', 'done')
    const rows = [row('in', 'done'), designer, row('builder', 'pending')]
    const askingRunIds = new Set([designer.id])
    const f = deriveFrontier(
      rows,
      definition,
      scopeNodes,
      scopeIds,
      0,
      ups({ designer: ['in'], builder: ['designer'] }),
      NONE,
      NONE,
      NONE,
      askingRunIds,
    )
    expect(f.completed.has('designer')).toBe(false)
    expect(f.awaitingHuman).toEqual(['designer'])
    // builder is held: its upstream designer is not completed.
    expect(f.ready).not.toContain('builder')
    expect(f.allSettled).toBe(false)
  })

  test('N1 — failed agent with upstream done → READY (resume re-mint), not in failed bucket', () => {
    const { definition, scopeNodes, scopeIds } = def([
      { id: 'in', kind: 'input' },
      { id: 'a', kind: 'agent-single' },
    ])
    const rows = [row('in', 'done'), row('a', 'failed')]
    const f = deriveFrontier(
      rows,
      definition,
      scopeNodes,
      scopeIds,
      0,
      ups({ a: ['in'] }),
      NONE,
      NONE,
      NONE,
    )
    expect(f.ready).toEqual(['a'])
    expect(f.failed).toEqual([])
  })

  test('failed agent with upstream NOT done → failed bucket, not ready', () => {
    const { definition, scopeNodes, scopeIds } = def([
      { id: 'up', kind: 'agent-single' },
      { id: 'a', kind: 'agent-single' },
    ])
    const rows = [row('up', 'pending'), row('a', 'failed')]
    const f = deriveFrontier(
      rows,
      definition,
      scopeNodes,
      scopeIds,
      0,
      ups({ a: ['up'] }),
      NONE,
      NONE,
      NONE,
    )
    // `up` (pending, no upstream) is itself ready; `a` (failed) is held because
    // its upstream `up` is not completed → `a` goes to the failed bucket, not ready.
    expect(f.ready).toEqual(['up'])
    expect(f.ready).not.toContain('a')
    expect(f.failed).toEqual(['a'])
  })

  test('N3 — dispatchedThisInvocation excludes an otherwise-ready node', () => {
    const { definition, scopeNodes, scopeIds } = def([
      { id: 'in', kind: 'input' },
      { id: 'a', kind: 'agent-single' },
    ])
    const rows = [row('in', 'done'), row('a', 'failed')]
    const f = deriveFrontier(
      rows,
      definition,
      scopeNodes,
      scopeIds,
      0,
      ups({ a: ['in'] }),
      NONE,
      new Set(['a']), // already dispatched this invocation
      NONE,
    )
    expect(f.ready).toEqual([])
  })

  test('fix-A window — designer re-running (pending) → designer ready, rev1 stale, questioner held', () => {
    // in → designer → rev1 → questioner. designer has a fresh pending rerun;
    // rev1 done but consumed the OLD designer run → stale; questioner held.
    const { definition, scopeNodes, scopeIds } = def([
      { id: 'in', kind: 'input' },
      { id: 'designer', kind: 'agent-single' },
      { id: 'rev1', kind: 'review' },
      { id: 'questioner', kind: 'agent-single' },
    ])
    const designerOld = row('designer', 'done') // 01R…(early)
    const designerNew = row('designer', 'pending') // rerun, later id
    const rev1 = row('rev1', 'done', {
      consumedUpstreamRunsJson: JSON.stringify({ designer: designerOld.id }),
    })
    const questioner = row('questioner', 'done', {
      consumedUpstreamRunsJson: JSON.stringify({ rev1: rev1.id }),
    })
    const rows = [row('in', 'done'), designerOld, designerNew, rev1, questioner]
    const f = deriveFrontier(
      rows,
      definition,
      scopeNodes,
      scopeIds,
      0,
      ups({ designer: ['in'], rev1: ['designer'], questioner: ['rev1'] }),
      NONE,
      NONE,
      NONE,
    )
    // designer's latest is the pending rerun → dispatchable.
    expect(f.ready).toEqual(['designer'])
    // rev1 consumed the OLD designer done but freshestDone[designer] is still that
    // old done (the rerun isn't done yet) → rev1 is one-hop fresh ⇒ completed; but
    // it is NOT dispatched because designer (its upstream) is not completed.
    // questioner is held (upstream rev1's upstream designer not settled).
    expect(f.ready).not.toContain('questioner')
    expect(f.allSettled).toBe(false)
  })

  test('wrapper-loop parked with fresh inner pending at i≥1 → ready (N2/HIGH-1)', () => {
    // This test builds defWithInner inline (the wrapper needs a nodeIds inner set),
    // so the generic def() helper isn't used here.
    // The wrapper's own row at iteration 0; mark progress iteration 2.
    const wrapperRow = row('lw', 'awaiting_human', {
      iteration: 0,
      wrapperProgressJson: JSON.stringify({ kind: 'loop', iteration: 2, phase: 'awaiting' }),
    })
    // Inner pending lives at the loop counter 2 (different nodeId, in definition.nodes
    // via the wrapper's nodeIds — here we add it so wrapperInnerDescendants finds it).
    const defWithInner = {
      nodes: [
        { id: 'lw', kind: 'wrapper-loop', nodeIds: ['inner'] },
        { id: 'inner', kind: 'agent-single' },
      ],
      edges: [],
    } as unknown as WorkflowDefinition
    const innerPending = row('inner', 'pending', { iteration: 2 })
    const rows = [wrapperRow, innerPending]
    const f = deriveFrontier(
      rows,
      defWithInner,
      [{ id: 'lw', kind: 'wrapper-loop' }] as unknown as WorkflowNode[],
      new Set(['lw']),
      0,
      ups({}),
      NONE,
      NONE,
      NONE,
    )
    expect(f.ready).toEqual(['lw'])
  })
})
