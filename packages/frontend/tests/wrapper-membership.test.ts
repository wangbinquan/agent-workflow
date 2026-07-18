// RFC-016 §2.1 #2 + §2.2 / C1: locks the wrapper-membership state machine.
// resolveMembershipOnDragStop must (a) ignore the wrapper-on-itself case,
// (b) pick the innermost hit when nested, (c) return both-null when the drop
// stays inside the same wrapper. applyMembershipPatch must keep reference
// equality when there's nothing to do, must remove from the old wrapper +
// add to the new wrapper atomically, and must invalidate stale wrapper.size
// so the next fit pass reflects the new bbox.

import { describe, expect, test } from 'vitest'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import {
  applyMembershipPatch,
  resolveMembershipOnDragStop,
  wrapperDescendantIds,
  type WrapperHitInput,
} from '../src/components/canvas/wrapperMembership'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function gitWrap(
  id: string,
  nodeIds: string[],
  rect = { x: 0, y: 0, width: 400, height: 300 },
): WrapperHitInput {
  return { id, nodeIds, rect }
}

describe('resolveMembershipOnDragStop', () => {
  test('drop into a wrapper from outside → join only, leave null', () => {
    const r = resolveMembershipOnDragStop({
      draggedNodeId: 'a1',
      draggedCenter: { x: 100, y: 100 },
      wrappers: [gitWrap('w1', [], { x: 0, y: 0, width: 200, height: 200 })],
    })
    expect(r).toEqual({ draggedNodeId: 'a1', joinWrapperId: 'w1', leaveWrapperId: null })
  })

  test('drop outside any wrapper while currently inside one → leave only', () => {
    const r = resolveMembershipOnDragStop({
      draggedNodeId: 'a1',
      draggedCenter: { x: 1000, y: 1000 },
      wrappers: [gitWrap('w1', ['a1'], { x: 0, y: 0, width: 200, height: 200 })],
    })
    expect(r).toEqual({ draggedNodeId: 'a1', joinWrapperId: null, leaveWrapperId: 'w1' })
  })

  test('drop into nested wrappers picks the innermost (smallest area)', () => {
    const r = resolveMembershipOnDragStop({
      draggedNodeId: 'a1',
      draggedCenter: { x: 100, y: 100 },
      wrappers: [
        gitWrap('outer', [], { x: 0, y: 0, width: 1000, height: 1000 }),
        gitWrap('inner', [], { x: 50, y: 50, width: 200, height: 200 }),
      ],
    })
    expect(r.joinWrapperId).toBe('inner')
  })

  test('switching from wrapper-A to wrapper-B yields both join + leave (atomic)', () => {
    const r = resolveMembershipOnDragStop({
      draggedNodeId: 'a1',
      draggedCenter: { x: 500, y: 50 },
      wrappers: [
        gitWrap('wA', ['a1'], { x: 0, y: 0, width: 200, height: 200 }),
        gitWrap('wB', [], { x: 400, y: 0, width: 200, height: 200 }),
      ],
    })
    expect(r).toEqual({ draggedNodeId: 'a1', joinWrapperId: 'wB', leaveWrapperId: 'wA' })
  })

  test('drop inside the same wrapper returns both-null (no patch needed)', () => {
    const r = resolveMembershipOnDragStop({
      draggedNodeId: 'a1',
      draggedCenter: { x: 100, y: 100 },
      wrappers: [gitWrap('w1', ['a1'], { x: 0, y: 0, width: 200, height: 200 })],
    })
    expect(r).toEqual({ draggedNodeId: 'a1', joinWrapperId: null, leaveWrapperId: null })
  })

  test('a wrapper does not hit-test against itself when dragged', () => {
    const r = resolveMembershipOnDragStop({
      draggedNodeId: 'w1',
      draggedCenter: { x: 100, y: 100 },
      wrappers: [gitWrap('w1', [], { x: 0, y: 0, width: 1000, height: 1000 })],
    })
    expect(r.joinWrapperId).toBeNull()
  })

  test('a dragged wrapper cannot join one of its descendants and create a membership cycle', () => {
    const definition = def([
      wrapperNode('outer', 'wrapper-loop', ['inner']),
      wrapperNode('inner', 'wrapper-git', ['leaf']),
      { id: 'leaf', kind: 'agent-single' } as unknown as WorkflowNode,
    ])
    const blocked = wrapperDescendantIds(definition, 'outer')
    const r = resolveMembershipOnDragStop({
      draggedNodeId: 'outer',
      draggedCenter: { x: 100, y: 100 },
      wrappers: [
        gitWrap('outer', ['inner'], { x: 0, y: 0, width: 600, height: 500 }),
        gitWrap('inner', ['leaf'], { x: 50, y: 50, width: 200, height: 200 }),
      ],
      blockedWrapperIds: blocked,
    })
    expect([...blocked]).toEqual(['inner'])
    expect(r.joinWrapperId).toBeNull()
  })
})

function def(nodes: WorkflowNode[]): WorkflowDefinition {
  return { $schema_version: 2, inputs: [], nodes, edges: [] } as WorkflowDefinition
}
function wrapperNode(
  id: string,
  kind: 'wrapper-git' | 'wrapper-loop',
  nodeIds: string[],
  extra: Record<string, unknown> = {},
): WorkflowNode {
  return { id, kind, position: { x: 0, y: 0 }, nodeIds, ...extra } as unknown as WorkflowNode
}

describe('applyMembershipPatch', () => {
  test('returns prevDef by reference when both fields null', () => {
    const d = def([wrapperNode('w1', 'wrapper-git', ['a1'])])
    const out = applyMembershipPatch(d, {
      draggedNodeId: 'a1',
      joinWrapperId: null,
      leaveWrapperId: null,
    })
    expect(out).toBe(d)
  })

  test('removes draggedNodeId from leaveWrapperId.nodeIds', () => {
    const d = def([wrapperNode('w1', 'wrapper-git', ['a1', 'b1'])])
    const out = applyMembershipPatch(d, {
      draggedNodeId: 'a1',
      joinWrapperId: null,
      leaveWrapperId: 'w1',
    })
    const w = out.nodes[0] as unknown as { nodeIds: string[] }
    expect(w.nodeIds).toEqual(['b1'])
  })

  test('adds draggedNodeId to joinWrapperId.nodeIds (dedup)', () => {
    const d = def([wrapperNode('w1', 'wrapper-git', ['existing'])])
    const out1 = applyMembershipPatch(d, {
      draggedNodeId: 'a1',
      joinWrapperId: 'w1',
      leaveWrapperId: null,
    })
    expect((out1.nodes[0] as unknown as { nodeIds: string[] }).nodeIds).toEqual(['existing', 'a1'])
    // idempotent if already present
    const out2 = applyMembershipPatch(out1, {
      draggedNodeId: 'a1',
      joinWrapperId: 'w1',
      leaveWrapperId: null,
    })
    expect((out2.nodes[0] as unknown as { nodeIds: string[] }).nodeIds).toEqual(['existing', 'a1'])
  })

  test('switching wrappers is atomic (one definition update touches both)', () => {
    const d = def([wrapperNode('wA', 'wrapper-git', ['a1']), wrapperNode('wB', 'wrapper-loop', [])])
    const out = applyMembershipPatch(d, {
      draggedNodeId: 'a1',
      joinWrapperId: 'wB',
      leaveWrapperId: 'wA',
    })
    expect((out.nodes[0] as unknown as { nodeIds: string[] }).nodeIds).toEqual([])
    expect((out.nodes[1] as unknown as { nodeIds: string[] }).nodeIds).toEqual(['a1'])
  })

  test('clears wrapper.size on membership change (so next render re-fits)', () => {
    const d = def([wrapperNode('w1', 'wrapper-git', [], { size: { width: 800, height: 800 } })])
    const out = applyMembershipPatch(d, {
      draggedNodeId: 'a1',
      joinWrapperId: 'w1',
      leaveWrapperId: null,
    })
    expect((out.nodes[0] as unknown as { size?: unknown }).size).toBeUndefined()
  })

  test('preserves wrapper.size when sizeLocked=true (user resized manually)', () => {
    const d = def([
      wrapperNode('w1', 'wrapper-git', [], { size: { width: 800, height: 800, sizeLocked: true } }),
    ])
    const out = applyMembershipPatch(d, {
      draggedNodeId: 'a1',
      joinWrapperId: 'w1',
      leaveWrapperId: null,
    })
    const w = out.nodes[0] as unknown as {
      size?: { width: number; height: number; sizeLocked?: boolean }
    }
    expect(w.size).toEqual({ width: 800, height: 800, sizeLocked: true })
  })

  test('non-wrapper kinds are not consulted in the patch loop', () => {
    const agent: WorkflowNode = {
      id: 'a1',
      kind: 'agent-single',
      position: { x: 0, y: 0 },
    } as WorkflowNode
    const d = def([agent, wrapperNode('w1', 'wrapper-git', [])])
    const out = applyMembershipPatch(d, {
      draggedNodeId: 'a1',
      joinWrapperId: 'w1',
      leaveWrapperId: null,
    })
    expect(out.nodes[0]).toBe(agent) // unchanged reference
  })

  test('unknown wrapper id is a noop on that side (silent)', () => {
    const d = def([wrapperNode('w1', 'wrapper-git', ['a1'])])
    const out = applyMembershipPatch(d, {
      draggedNodeId: 'a1',
      joinWrapperId: 'does-not-exist',
      leaveWrapperId: 'w1',
    })
    // a1 is removed from w1; non-existent join target is silently dropped.
    expect((out.nodes[0] as unknown as { nodeIds: string[] }).nodeIds).toEqual([])
  })

  test('defense in depth refuses a direct cyclic wrapper patch', () => {
    const d = def([
      wrapperNode('outer', 'wrapper-loop', ['inner']),
      wrapperNode('inner', 'wrapper-git', []),
    ])
    const out = applyMembershipPatch(d, {
      draggedNodeId: 'outer',
      joinWrapperId: 'inner',
      leaveWrapperId: null,
    })
    expect(out).toBe(d)
  })

  test('defense in depth refuses a direct self-membership patch', () => {
    const d = def([wrapperNode('w1', 'wrapper-loop', [])])
    const out = applyMembershipPatch(d, {
      draggedNodeId: 'w1',
      joinWrapperId: 'w1',
      leaveWrapperId: null,
    })
    expect(out).toBe(d)
  })
})

describe('WorkflowCanvas wrapper drag wiring', () => {
  test('wrapper drags use the same membership path as ordinary nodes', () => {
    const src = readFileSync(
      resolve(import.meta.dirname, '..', 'src', 'components', 'canvas', 'WorkflowCanvas.tsx'),
      'utf8',
    )
    expect(src).not.toMatch(/if \(isWrapperKind\(dn\.type\)\) continue/)
    expect(src).toMatch(/wrapperDescendantIds\(nextDef, dn\.id\)/)
  })
})
