// RFC-076 PR-B — deriveFrontier 'exhausted' (loop-max terminal) bucketing locks.
//
// Locks the regression guarded by the comment at scheduler.ts:1083-1089: an
// 'exhausted' top-level loop row (hit max_iterations without satisfying its
// exit_condition) is a TERMINAL FAILURE, not a completion. A prior bug flipped
// such a failed task to `done` by marking the exhausted loop completed, so its
// downstream consumed empty output. deriveFrontier must bucket it into
// exhausted[], keep it OUT of completed/ready/failed, count it in
// remainingCount (allSettled=false), and HOLD any downstream consumer (its
// transitive upstream is not completed).
//
// Coverage gap: derive-frontier.test.ts (F1,F2,C1,C2,N1,N3,N6,S12,fix-A,N2)
// NEVER constructs an 'exhausted' row; dispatch-frontier.test.ts only covers
// isDispatchable(exhausted)=false in isolation. This file asserts the bucketing
// + allSettled + downstream-hold composition inside deriveFrontier itself.
//
// def()/row() are replicated minimally from derive-frontier.test.ts (those are
// file-local there) — this file does NOT edit the shared test.

import { describe, expect, test } from 'bun:test'
import type { NodeKind, WorkflowDefinition } from '@agent-workflow/shared'
import type { nodeRuns } from '../src/db/schema'
import { deriveFrontier } from '../src/modules/task-execution/composition/dagFrontier'

type Row = typeof nodeRuns.$inferSelect
type WorkflowNode = WorkflowDefinition['nodes'][number]
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

const ups = (m: Record<string, string[]>): Map<string, string[]> => new Map(Object.entries(m))

describe("RFC-076 PR-B — deriveFrontier 'exhausted' bucketing", () => {
  test('exhausted loop → exhausted[] (not completed/ready/failed), allSettled=false, downstream held', () => {
    const { definition, scopeNodes, scopeIds } = def([
      { id: 'lw', kind: 'wrapper-loop' },
      { id: 'down', kind: 'agent-single' },
    ])
    // lw hit max_iterations without satisfying exit_condition → terminal failure.
    const rows = [row('lw', 'exhausted', { iteration: 0 })]
    const f = deriveFrontier(
      rows,
      definition,
      scopeNodes,
      scopeIds,
      { containerRunId: null, iteration: 0 },
      ups({ down: ['lw'] }),
      NONE, // inFlight
      NONE, // dispatchedThisInvocation
      NONE, // openClarifyNodeIds
    )
    // Bucketed into exhausted[], never completed.
    expect(f.exhausted).toEqual(['lw'])
    expect(f.completed.has('lw')).toBe(false)
    // Not (re-)dispatchable and not a failed/awaiting bucket.
    expect(f.ready).not.toContain('lw')
    expect(f.failed).not.toContain('lw')
    // Not completed ⇒ counted in remainingCount ⇒ scope not settled.
    expect(f.allSettled).toBe(false)
    // Downstream consumer is held: its transitive upstream 'lw' is not completed.
    expect(f.ready).not.toContain('down')
  })

  test('exhausted loop alongside a done+fresh sibling → sibling completed, exhausted unchanged, allSettled=false', () => {
    const { definition, scopeNodes, scopeIds } = def([
      { id: 'lw', kind: 'wrapper-loop' },
      { id: 'sib', kind: 'agent-single' },
      { id: 'down', kind: 'agent-single' },
    ])
    // sib: done with no consumed-upstream entries → isNodeRunFresh true → completed.
    const rows = [row('lw', 'exhausted', { iteration: 0 }), row('sib', 'done')]
    const f = deriveFrontier(
      rows,
      definition,
      scopeNodes,
      scopeIds,
      { containerRunId: null, iteration: 0 },
      ups({ down: ['lw'] }),
      NONE,
      NONE,
      NONE,
    )
    expect(f.completed.has('sib')).toBe(true)
    expect(f.exhausted).toEqual(['lw'])
    expect(f.completed.has('lw')).toBe(false)
    expect(f.allSettled).toBe(false)
  })
})
