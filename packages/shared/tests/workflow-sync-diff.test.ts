// RFC-109 — locks the pure diff between a task's frozen workflow snapshot and
// the latest workflow definition (drives the "sync latest workflow & continue"
// preview). This is the assertable oracle for the sync feature's classification
// + safety warnings/blockers; see design.md §2.3 / §9.
//
// Intent of each lock (so a future refactor that reddens it sees why):
//   * added/removed/modified by nodeId; position-only changes are NOT changes.
//   * dangling-input-port keys off the PRESERVED RUN's actual produced ports
//     (Codex F2) — a port rename whose old run lacks the new name warns even
//     though the new definition declares it.
//   * new-upstream-into-completed-node (Codex F1) — RFC-074 silently preserves.
//   * wrapper-structure-changed-with-live-state is a BLOCKER (Codex F3), but a
//     prompt change to a node INSIDE a wrapper is not (killer use case stays open).

import { describe, expect, test } from 'bun:test'
import {
  diffWorkflowForSync,
  type NodeRunSyncSummary,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowEdge,
  type NodeKind,
} from '../src/index'

function node(id: string, kind: NodeKind, extra: Record<string, unknown> = {}): WorkflowNode {
  return { id, kind, ...extra } as unknown as WorkflowNode
}
function edge(
  id: string,
  srcNode: string,
  srcPort: string,
  tgtNode: string,
  tgtPort: string,
  boundary?: 'wrapper-input' | 'wrapper-output',
): WorkflowEdge {
  return {
    id,
    source: { nodeId: srcNode, portName: srcPort },
    target: { nodeId: tgtNode, portName: tgtPort },
    ...(boundary ? { boundary } : {}),
  }
}
function def(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowDefinition {
  return { $schema_version: 4, inputs: [], nodes, edges } as unknown as WorkflowDefinition
}
function summary(m: Record<string, Partial<NodeRunSyncSummary>>): Map<string, NodeRunSyncSummary> {
  const out = new Map<string, NodeRunSyncSummary>()
  for (const [k, v] of Object.entries(m)) {
    out.set(k, {
      hasCompletedRun: v.hasCompletedRun ?? false,
      producedPorts: v.producedPorts ?? new Set<string>(),
      hasLiveWrapperState: v.hasLiveWrapperState ?? false,
    })
  }
  return out
}
const NO_RUNS = new Map<string, NodeRunSyncSummary>()

describe('RFC-109 diffWorkflowForSync — node classification', () => {
  test('added / removed / modified keyed by nodeId', () => {
    const oldDef = def(
      [node('a', 'agent-single', { prompt: 'p1' }), node('b', 'agent-single', { prompt: 'old' })],
      [],
    )
    const newDef = def(
      [
        node('a', 'agent-single', { prompt: 'p1' }),
        node('c', 'agent-single', { prompt: 'new node' }),
      ],
      [],
    )
    const d = diffWorkflowForSync(oldDef, newDef, NO_RUNS)
    expect(d.added.map((x) => x.nodeId)).toEqual(['c'])
    expect(d.removed.map((x) => x.nodeId)).toEqual(['b'])
    expect(d.modified).toEqual([]) // 'a' unchanged
    expect(d.differs).toBe(true)
  })

  test('modified lists changed top-level keys + completed flag from runSummary', () => {
    const oldDef = def([node('a', 'agent-single', { prompt: 'old', agent: 'x' })], [])
    const newDef = def([node('a', 'agent-single', { prompt: 'new', agent: 'x' })], [])
    const d = diffWorkflowForSync(oldDef, newDef, summary({ a: { hasCompletedRun: true } }))
    expect(d.modified).toHaveLength(1)
    expect(d.modified[0]).toMatchObject({ nodeId: 'a', completed: true, changed: ['prompt'] })
  })

  test('position-only change does not register as differs / modified', () => {
    const oldDef = def([node('a', 'agent-single', { prompt: 'p', position: { x: 0, y: 0 } })], [])
    const newDef = def([node('a', 'agent-single', { prompt: 'p', position: { x: 99, y: 99 } })], [])
    const d = diffWorkflowForSync(oldDef, newDef, NO_RUNS)
    expect(d.differs).toBe(false)
    expect(d.modified).toEqual([])
  })

  test('byte-identical definitions ⇒ differs false, all lists empty', () => {
    const a = def([node('a', 'agent-single', { prompt: 'p' })], [edge('e1', 'a', 'out', 'b', 'in')])
    const b = def([node('a', 'agent-single', { prompt: 'p' })], [edge('e1', 'a', 'out', 'b', 'in')])
    const d = diffWorkflowForSync(a, b, NO_RUNS)
    expect(d).toMatchObject({
      differs: false,
      added: [],
      removed: [],
      modified: [],
      warnings: [],
      blockers: [],
    })
  })
})

describe('RFC-109 diffWorkflowForSync — data-loss warnings', () => {
  test('removed-node-feeds-downstream when deleted producer fed a surviving node', () => {
    const oldDef = def(
      [node('a', 'agent-single'), node('b', 'agent-single')],
      [edge('e', 'a', 'out', 'b', 'in')],
    )
    const newDef = def([node('b', 'agent-single')], []) // 'a' removed
    const d = diffWorkflowForSync(oldDef, newDef, summary({ a: { hasCompletedRun: true } }))
    expect(d.warnings.map((w) => w.code)).toContain('removed-node-feeds-downstream')
    expect(d.warnings.find((w) => w.code === 'removed-node-feeds-downstream')?.nodeId).toBe('a')
  })

  test('removed node with NO completed run → no removed-node warning', () => {
    const oldDef = def(
      [node('a', 'agent-single'), node('b', 'agent-single')],
      [edge('e', 'a', 'out', 'b', 'in')],
    )
    const newDef = def([node('b', 'agent-single')], [])
    const d = diffWorkflowForSync(oldDef, newDef, NO_RUNS) // a not completed
    expect(d.warnings.map((w) => w.code)).not.toContain('removed-node-feeds-downstream')
  })

  test('dangling-input-port: port renamed, preserved upstream run lacks the new name', () => {
    // upstream 'a' completed producing port 'result'; new graph wires 'a.summary' → 'b'
    const oldDef = def(
      [node('a', 'agent-single'), node('b', 'agent-single')],
      [edge('e', 'a', 'result', 'b', 'in')],
    )
    const newDef = def(
      [node('a', 'agent-single'), node('b', 'agent-single')],
      [edge('e', 'a', 'summary', 'b', 'in')],
    )
    const d = diffWorkflowForSync(
      oldDef,
      newDef,
      summary({ a: { hasCompletedRun: true, producedPorts: new Set(['result']) } }),
    )
    const w = d.warnings.find((x) => x.code === 'dangling-input-port')
    expect(w?.nodeId).toBe('b')
  })

  test('dangling-input-port: declared-but-not-produced still warns (based on actual outputs, Codex F2)', () => {
    // 'a' completed but its run produced nothing on 'out'; 'b' will run reading 'a.out'
    const oldDef = def(
      [node('a', 'agent-single'), node('b', 'agent-single')],
      [edge('e', 'a', 'out', 'b', 'in')],
    )
    const newDef = oldDef
    const d = diffWorkflowForSync(
      oldDef,
      newDef,
      summary({ a: { hasCompletedRun: true, producedPorts: new Set() } }),
    )
    expect(d.warnings.find((x) => x.code === 'dangling-input-port')?.nodeId).toBe('b')
  })

  test('dangling-input-port: NOT raised when upstream run actually produced the port', () => {
    const oldDef = def(
      [node('a', 'agent-single'), node('b', 'agent-single')],
      [edge('e', 'a', 'result', 'b', 'in')],
    )
    const d = diffWorkflowForSync(
      oldDef,
      oldDef,
      summary({ a: { hasCompletedRun: true, producedPorts: new Set(['result']) } }),
    )
    expect(d.warnings.map((w) => w.code)).not.toContain('dangling-input-port')
  })

  test('new-upstream-into-completed-node when a new edge feeds an already-completed node', () => {
    const oldDef = def([node('a', 'agent-single'), node('b', 'agent-single')], [])
    const newDef = def(
      [node('a', 'agent-single'), node('b', 'agent-single')],
      [edge('e', 'a', 'out', 'b', 'in')],
    )
    const d = diffWorkflowForSync(
      oldDef,
      newDef,
      summary({
        b: { hasCompletedRun: true },
        a: { hasCompletedRun: true, producedPorts: new Set(['out']) },
      }),
    )
    expect(d.warnings.find((w) => w.code === 'new-upstream-into-completed-node')?.nodeId).toBe('b')
  })

  test('channel edges are excluded from data-loss warnings', () => {
    const oldDef = def([node('q', 'agent-single'), node('d', 'agent-single')], [])
    const newDef = def(
      [node('q', 'agent-single'), node('d', 'agent-single')],
      [edge('e', 'q', 'to_designer', 'd', 'in')],
    )
    const d = diffWorkflowForSync(oldDef, newDef, summary({ d: { hasCompletedRun: true } }))
    expect(d.warnings).toEqual([])
  })
})

describe('RFC-109 diffWorkflowForSync — wrapper blocker', () => {
  test('wrapper structure change + live state ⇒ blocker', () => {
    const oldDef = def([node('w', 'wrapper-loop', { nodeIds: ['x'], maxIterations: 3 })], [])
    const newDef = def([node('w', 'wrapper-loop', { nodeIds: ['x'], maxIterations: 9 })], [])
    const d = diffWorkflowForSync(oldDef, newDef, summary({ w: { hasLiveWrapperState: true } }))
    expect(d.blockers.map((b) => b.code)).toEqual(['wrapper-structure-changed-with-live-state'])
    expect(d.blockers[0]?.nodeId).toBe('w')
  })

  test('wrapper structure change WITHOUT live state ⇒ no blocker (only modified)', () => {
    const oldDef = def([node('w', 'wrapper-loop', { nodeIds: ['x'], maxIterations: 3 })], [])
    const newDef = def([node('w', 'wrapper-loop', { nodeIds: ['x'], maxIterations: 9 })], [])
    const d = diffWorkflowForSync(oldDef, newDef, summary({ w: { hasLiveWrapperState: false } }))
    expect(d.blockers).toEqual([])
    expect(d.modified.map((m) => m.nodeId)).toEqual(['w'])
  })

  test('changing a node INSIDE the wrapper does NOT block (wrapper node unchanged)', () => {
    // killer use case: fix the inner coder's prompt; wrapper 'w' itself is identical
    const oldDef = def(
      [
        node('w', 'wrapper-loop', { nodeIds: ['coder'] }),
        node('coder', 'agent-single', { prompt: 'bad' }),
      ],
      [],
    )
    const newDef = def(
      [
        node('w', 'wrapper-loop', { nodeIds: ['coder'] }),
        node('coder', 'agent-single', { prompt: 'fixed' }),
      ],
      [],
    )
    const d = diffWorkflowForSync(
      oldDef,
      newDef,
      summary({ w: { hasLiveWrapperState: true }, coder: { hasCompletedRun: false } }),
    )
    expect(d.blockers).toEqual([])
    expect(d.modified.map((m) => m.nodeId)).toEqual(['coder'])
  })

  // Codex impl-gate F1: structural changes that live OUTSIDE the wrapper node.
  test('boundary-edge change on a live wrapper ⇒ blocker', () => {
    const oldDef = def(
      [node('w', 'wrapper-fanout', { nodeIds: ['inner'] }), node('inner', 'agent-single')],
      [edge('b', 'w', 'shard', 'inner', 'in', 'wrapper-input')],
    )
    const newDef = def(
      [node('w', 'wrapper-fanout', { nodeIds: ['inner'] }), node('inner', 'agent-single')],
      [edge('b', 'w', 'broadcast', 'inner', 'in', 'wrapper-input')], // boundary port changed
    )
    const d = diffWorkflowForSync(oldDef, newDef, summary({ w: { hasLiveWrapperState: true } }))
    expect(d.blockers.map((b) => b.code)).toEqual(['wrapper-structure-changed-with-live-state'])
  })

  test('removing a live wrapper ⇒ blocker', () => {
    const oldDef = def([node('w', 'wrapper-loop', { nodeIds: ['x'] })], [])
    const newDef = def([node('x', 'agent-single')], []) // wrapper gone
    const d = diffWorkflowForSync(oldDef, newDef, summary({ w: { hasLiveWrapperState: true } }))
    expect(d.blockers.map((b) => b.code)).toEqual(['wrapper-structure-changed-with-live-state'])
  })

  test('changing a live wrapper kind ⇒ blocker', () => {
    const oldDef = def([node('w', 'wrapper-loop', { nodeIds: ['x'] })], [])
    const newDef = def([node('w', 'wrapper-git', { nodeIds: ['x'] })], [])
    const d = diffWorkflowForSync(oldDef, newDef, summary({ w: { hasLiveWrapperState: true } }))
    expect(d.blockers.map((b) => b.code)).toEqual(['wrapper-structure-changed-with-live-state'])
  })

  test('wrapper title change alone does NOT block (visual only)', () => {
    const oldDef = def([node('w', 'wrapper-loop', { nodeIds: ['x'], title: 'A' })], [])
    const newDef = def([node('w', 'wrapper-loop', { nodeIds: ['x'], title: 'B' })], [])
    const d = diffWorkflowForSync(oldDef, newDef, summary({ w: { hasLiveWrapperState: true } }))
    expect(d.blockers).toEqual([])
  })

  // Codex re-review F1 follow-up: inner-subgraph edge rewiring among nodeIds that
  // touches neither the wrapper node nor its incident edges must still block.
  test('inner-subgraph edge rewiring on a live wrapper ⇒ blocker', () => {
    const inner = [
      node('w', 'wrapper-loop', { nodeIds: ['x', 'y'] }),
      node('x', 'agent-single'),
      node('y', 'agent-single'),
    ]
    const oldDef = def(inner, [edge('e', 'x', 'out', 'y', 'in')]) // x→y inside wrapper
    const newDef = def(inner, []) // inner edge removed; wrapper node + nodeIds unchanged
    const d = diffWorkflowForSync(oldDef, newDef, summary({ w: { hasLiveWrapperState: true } }))
    expect(d.blockers.map((b) => b.code)).toEqual(['wrapper-structure-changed-with-live-state'])
  })

  test('inner node PROMPT change (edges/nodeIds unchanged) on a live wrapper does NOT block', () => {
    const oldDef = def(
      [node('w', 'wrapper-loop', { nodeIds: ['x'] }), node('x', 'agent-single', { prompt: 'a' })],
      [],
    )
    const newDef = def(
      [node('w', 'wrapper-loop', { nodeIds: ['x'] }), node('x', 'agent-single', { prompt: 'b' })],
      [],
    )
    const d = diffWorkflowForSync(oldDef, newDef, summary({ w: { hasLiveWrapperState: true } }))
    expect(d.blockers).toEqual([])
  })
})
