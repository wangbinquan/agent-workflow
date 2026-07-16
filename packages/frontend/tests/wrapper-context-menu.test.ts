// RFC-016 §4.5 / T8: locks the wrapper-specific right-click menu actions.
// Two layers of guarantee:
//   1. Pure transforms (clearWrapperSize / deleteWrapperWithChildren) own
//      the actual WorkflowDefinition mutation — unit tested here.
//   2. The menuItems closure in WorkflowCanvas wires them to the
//      `wrapperNode.fitToChildren` / `wrapperNode.unwrap` /
//      `wrapperNode.deleteWithInner` i18n keys — source-level fs guard so
//      future refactors can't silently drop the user-facing menu entries.

import { describe, expect, test } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import {
  clearWrapperSize,
  deleteWrapperWithChildren,
  isWrapperDeleteSnapshotCurrent,
  snapshotWrapperDelete,
} from '../src/components/canvas/wrapperOps'

function def(nodes: WorkflowNode[], edges: WorkflowDefinition['edges'] = []): WorkflowDefinition {
  return { $schema_version: 2, inputs: [], nodes, edges } as WorkflowDefinition
}
function wrap(
  id: string,
  kind: 'wrapper-git' | 'wrapper-loop',
  nodeIds: string[],
  extra: Record<string, unknown> = {},
): WorkflowNode {
  return { id, kind, position: { x: 0, y: 0 }, nodeIds, ...extra } as unknown as WorkflowNode
}
function agent(id: string): WorkflowNode {
  return {
    id,
    kind: 'agent-single',
    position: { x: 0, y: 0 },
    agentName: 'a',
  } as unknown as WorkflowNode
}

describe('clearWrapperSize (Fit to children)', () => {
  test('removes wrapper.size so the next render re-fits to current bbox', () => {
    const d = def([
      wrap('w1', 'wrapper-git', ['a1'], { size: { width: 800, height: 600 } }),
      agent('a1'),
    ])
    const out = clearWrapperSize(d, 'w1')
    expect((out.nodes[0] as unknown as { size?: unknown }).size).toBeUndefined()
  })

  test('also drops sizeLocked (user resize) so right-click force-resets', () => {
    const d = def([
      wrap('w1', 'wrapper-git', ['a1'], { size: { width: 800, height: 600, sizeLocked: true } }),
      agent('a1'),
    ])
    const out = clearWrapperSize(d, 'w1')
    expect((out.nodes[0] as unknown as { size?: unknown }).size).toBeUndefined()
  })

  test('returns prevDef by reference when wrapper has no size already', () => {
    const d = def([wrap('w1', 'wrapper-git', ['a1']), agent('a1')])
    const out = clearWrapperSize(d, 'w1')
    expect(out).toBe(d)
  })

  test('non-wrapper target is a noop (returns prevDef by reference)', () => {
    const d = def([agent('a1')])
    const out = clearWrapperSize(d, 'a1')
    expect(out).toBe(d)
  })
})

describe('deleteWrapperWithChildren', () => {
  test('removes the wrapper and every inner node', () => {
    const d = def([
      wrap('w1', 'wrapper-git', ['a1', 'a2']),
      agent('a1'),
      agent('a2'),
      agent('outside'),
    ])
    const out = deleteWrapperWithChildren(d, 'w1')
    const ids = out.nodes.map((n) => n.id)
    expect(ids).toEqual(['outside'])
  })

  test('recursively removes nested wrappers and their descendants', () => {
    const d = def([
      wrap('outer', 'wrapper-git', ['inner-wrapper']),
      wrap('inner-wrapper', 'wrapper-loop', ['nested-child']),
      agent('nested-child'),
      agent('outside'),
    ])
    const out = deleteWrapperWithChildren(d, 'outer')
    expect(out.nodes.map((node) => node.id)).toEqual(['outside'])
  })

  test('drops edges whose endpoints were removed alongside the wrapper', () => {
    const edges = [
      {
        id: 'e1',
        source: { nodeId: 'a1', portName: 'out' },
        target: { nodeId: 'a2', portName: 'in' },
      },
      {
        id: 'e2',
        source: { nodeId: 'outside', portName: 'out' },
        target: { nodeId: 'a1', portName: 'in' },
      },
    ]
    const d = def(
      [wrap('w1', 'wrapper-git', ['a1', 'a2']), agent('a1'), agent('a2'), agent('outside')],
      edges,
    )
    const out = deleteWrapperWithChildren(d, 'w1')
    expect(out.edges).toEqual([])
  })

  test('non-wrapper target returns prevDef by reference (safe no-op)', () => {
    const d = def([agent('a1')])
    const out = deleteWrapperWithChildren(d, 'a1')
    expect(out).toBe(d)
  })

  test('unknown id returns prevDef by reference', () => {
    const d = def([wrap('w1', 'wrapper-git', ['a1']), agent('a1')])
    const out = deleteWrapperWithChildren(d, 'does-not-exist')
    expect(out).toBe(d)
  })
})

describe('wrapper delete confirmation snapshot', () => {
  test('uses a stable, sorted child set and tolerates nodeIds reordering', () => {
    const snapshot = snapshotWrapperDelete(
      def([wrap('w1', 'wrapper-git', ['a2', 'a1']), agent('a1'), agent('a2')]),
      'w1',
    )
    expect(snapshot).toEqual({ wrapperId: 'w1', childIds: ['a1', 'a2'] })
    expect(
      snapshot !== null &&
        isWrapperDeleteSnapshotCurrent(
          def([wrap('w1', 'wrapper-git', ['a1', 'a2']), agent('a1'), agent('a2')]),
          snapshot,
        ),
    ).toBe(true)
  })

  test('snapshots recursive descendants so nested scope changes invalidate confirmation', () => {
    const original = def([
      wrap('outer', 'wrapper-git', ['inner']),
      wrap('inner', 'wrapper-loop', ['a1']),
      agent('a1'),
      agent('a2'),
    ])
    const snapshot = snapshotWrapperDelete(original, 'outer')
    expect(snapshot).toEqual({ wrapperId: 'outer', childIds: ['a1', 'inner'] })
    expect(
      snapshot !== null &&
        isWrapperDeleteSnapshotCurrent(
          def([
            wrap('outer', 'wrapper-git', ['inner']),
            wrap('inner', 'wrapper-loop', ['a1', 'a2']),
            agent('a1'),
            agent('a2'),
          ]),
          snapshot,
        ),
    ).toBe(false)
  })

  test('rejects a removed wrapper or a changed destructive child set', () => {
    const original = def([wrap('w1', 'wrapper-git', ['a1']), agent('a1')])
    const snapshot = snapshotWrapperDelete(original, 'w1')
    expect(snapshot).not.toBeNull()
    expect(
      snapshot !== null &&
        isWrapperDeleteSnapshotCurrent(
          def([wrap('w1', 'wrapper-git', ['a1', 'a2']), agent('a1'), agent('a2')]),
          snapshot,
        ),
    ).toBe(false)
    expect(snapshot !== null && isWrapperDeleteSnapshotCurrent(def([agent('a1')]), snapshot)).toBe(
      false,
    )
  })
})

// Source-level guard: the WorkflowCanvas menu items must surface these
// three i18n strings + the two new callbacks must be referenced from the
// menu closure. Red here means the right-click entries have regressed.
describe('WorkflowCanvas menu source-level guards', () => {
  test('menuItems references wrapperNode.fitToChildren / unwrap / deleteWithInner + new callbacks', async () => {
    const here = path.dirname(new URL(import.meta.url).pathname)
    const src = await fs.readFile(
      path.join(here, '../src/components/canvas/WorkflowCanvas.tsx'),
      'utf8',
    )
    expect(src).toMatch(/wrapperNode\.fitToChildren/)
    expect(src).toMatch(/wrapperNode\.unwrap/)
    expect(src).toMatch(/wrapperNode\.deleteWithInner/)
    expect(src).toMatch(/wrapperNode\.confirmDeleteWithInner/)
    expect(src).toMatch(/<ConfirmDialog/)
    expect(src).not.toMatch(/window\.confirm/)
    expect(src).toMatch(/fitWrapperToChildren\(/)
    expect(src).toMatch(/deleteWrapperWithInner\(/)
  })
})
