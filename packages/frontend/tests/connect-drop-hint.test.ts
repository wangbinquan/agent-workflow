// RFC-106 T3 — live drag-connect feedback. Locks the pointer hit-test that
// drives BOTH the preview (ConnectDropHint) and the body-drop edge build
// (WorkflowCanvas.onConnectEnd) — so "what you see while dragging over a node"
// === "what gets wired on release": a NEW input, named + deconflicted.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@agent-workflow/shared'
import {
  findNewInputTarget,
  namedInputDropPolicy,
  type NodeBox,
} from '../src/components/canvas/dropTarget'
import { nearestPort, REUSE_RADIUS_PX } from '../src/components/canvas/connectResolve'

const here = path.dirname(fileURLToPath(import.meta.url))

function def(
  nodes: Array<{ id: string; kind: string } & Record<string, unknown>>,
  edges: Array<{ s: [string, string]; t: [string, string] }> = [],
): WorkflowDefinition {
  return {
    nodes: nodes as unknown as WorkflowNode[],
    edges: edges.map((e, i) => ({
      id: `e${i}`,
      source: { nodeId: e.s[0], portName: e.s[1] },
      target: { nodeId: e.t[0], portName: e.t[1] },
    })) as unknown as WorkflowEdge[],
  } as unknown as WorkflowDefinition
}

const box = (id: string, x: number, y: number): NodeBox => ({ id, x, y, w: 100, h: 60 })

describe('findNewInputTarget (pointer hit-test)', () => {
  const d = def([
    { id: 'A', kind: 'agent-single', agentName: 'a' },
    { id: 'C', kind: 'agent-single', agentName: 'c' },
    { id: 'R', kind: 'review', inputSource: { nodeId: 'A', portName: 'o' } },
  ])
  const boxes = [box('A', 0, 0), box('C', 200, 0), box('R', 400, 0)]

  test('pointer over an agent → new input named after the source port', () => {
    expect(findNewInputTarget(d, boxes, { x: 250, y: 30 }, 'A', 'result')).toEqual({
      nodeId: 'C',
      portName: 'result',
    })
  })

  test.each(['agent-single', 'call-workgroup', 'script', 'code-host-call'] as const)(
    '%s keeps the shared NEW + REUSE input-drop contract',
    (kind) => {
      expect(namedInputDropPolicy(kind)).toBe('new-or-reuse')
      const targetDef = def([
        { id: 'A', kind: 'agent-single', agentName: 'a' },
        { id: 'C', kind, ...(kind === 'agent-single' ? { agentName: 'c' } : {}) },
      ])
      expect(
        findNewInputTarget(
          targetDef,
          [box('A', 0, 0), box('C', 200, 0)],
          { x: 250, y: 30 },
          'A',
          'result',
        ),
      ).toEqual({ nodeId: 'C', portName: 'result' })
    },
  )

  test('output keeps NEW-only semantics while closed call-workflow is not a body-drop target', () => {
    expect(namedInputDropPolicy('output')).toBe('new-only')
    expect(namedInputDropPolicy('call-workflow')).toBeNull()
  })

  test('deconflicts the new name against existing inputs', () => {
    const d2 = def(
      [
        { id: 'A', kind: 'agent-single', agentName: 'a' },
        { id: 'C', kind: 'agent-single', agentName: 'c' },
      ],
      [{ s: ['X', 'r'], t: ['C', 'result'] }],
    )
    expect(findNewInputTarget(d2, boxes, { x: 250, y: 30 }, 'A', 'result')).toEqual({
      nodeId: 'C',
      portName: 'result_2',
    })
  })

  test('channel drag from an agent `__clarify__` ask port → null (no new-input preview)', () => {
    expect(findNewInputTarget(d, boxes, { x: 250, y: 30 }, 'A', '__clarify__')).toBeNull()
  })

  test('channel drag from a clarify node → null', () => {
    const d2 = def([
      { id: 'CL', kind: 'clarify' },
      { id: 'C', kind: 'agent-single', agentName: 'c' },
    ])
    expect(findNewInputTarget(d2, boxes, { x: 250, y: 30 }, 'CL', 'answers')).toBeNull()
  })

  test('pointer over the SOURCE node → null (no self-loop)', () => {
    expect(findNewInputTarget(d, boxes, { x: 50, y: 30 }, 'A', 'result')).toBeNull()
  })

  test('pointer over an out-of-scope node (review) → null', () => {
    expect(findNewInputTarget(d, boxes, { x: 450, y: 30 }, 'A', 'result')).toBeNull()
  })

  test('pointer over empty canvas → null', () => {
    expect(findNewInputTarget(d, boxes, { x: 999, y: 999 }, 'A', 'result')).toBeNull()
  })
})

describe('nearestPort (precise-reuse geometry)', () => {
  const centers = [
    { name: 'requirement', x: 100, y: 100 },
    { name: 'ctx', x: 100, y: 140 },
  ]
  test('within the (small) radius of a port → that port', () => {
    expect(nearestPort(centers, 104, 138, REUSE_RADIUS_PX)).toBe('ctx')
  })
  test('beyond the radius → null (flips back to NEW input)', () => {
    expect(nearestPort(centers, 100, 120, REUSE_RADIUS_PX)).toBeNull()
  })
  test('radius is small so reuse needs precision', () => {
    expect(REUSE_RADIUS_PX).toBeLessThanOrEqual(10)
  })
  test('picks the closest when two are in range', () => {
    expect(nearestPort(centers, 100, 101, 50)).toBe('requirement')
  })
})

describe('RFC-106 wiring (source anchors)', () => {
  const read = (p: string) => readFileSync(path.resolve(here, p), 'utf-8')
  const canvas = read('../src/components/canvas/WorkflowCanvas.tsx')
  const hint = read('../src/components/canvas/ConnectDropHint.tsx')
  const resolve = read('../src/components/canvas/connectResolve.ts')
  const portHandles = read('../src/components/canvas/nodes/PortHandles.tsx')

  test('preview injector is rendered in the canvas', () => {
    expect(canvas).toContain('<ConnectDropHint')
  })

  test('reuse follows the shared open-input policy (output still always appends)', () => {
    // Rebinding an output port would clear its ports[].bind, so output remains
    // NEW-only. Agent/workgroup/script/code-host edge-derived inputs share
    // precise reuse.
    expect(resolve).toContain("namedInputDropPolicy(targetNode.kind) === 'new-or-reuse'")
  })

  test('preview, build and line all resolve via the SAME resolveDropTarget', () => {
    // ConnectDropHint (preview), onConnectEnd + onConnect (build) and the custom
    // line all go through resolveDropTarget — one authority for new-vs-reuse.
    expect(hint).toContain('resolveDropTarget(')
    expect(canvas).toContain('onConnectEnd={handleConnectEnd}')
    expect(canvas).toContain('resolveDropTarget(')
  })

  test('catch-all build and validity checks use the same open-input node policy', () => {
    // Both the actual onConnect adapter and xyflow's preflight must include
    // workgroup/script/code-host targets; otherwise preview would claim a port
    // that the release path names differently or refuses.
    expect(canvas.match(/namedInputDropPolicy\(targetNode\.kind\)/g)).toHaveLength(2)
  })

  test('node hit-test uses connection.to (flow); reuse probe uses the client pointerRef', () => {
    // useConnection().to is FLOW (the selector converts it via pointToRendererPoint),
    // so it is transform-aware and drives the node hit-test directly. The precise-
    // reuse probe needs the RAW cursor in CLIENT px (pointerRef vs getBoundingClientRect),
    // since `to` is snapped to the catch-all.
    expect(hint).toContain('connection.to')
    expect(hint).toContain('pointerRef.current')
    expect(hint).toContain('getNodeBoxes(rf)')
  })

  test('the custom connection line anchors the in-flight line to the resolved port', () => {
    expect(canvas).toContain('connectionLineComponent={ConnectionLine}')
    expect(canvas).toContain('data-handleid')
  })

  test('a floating NEW/REUSE badge names the outcome', () => {
    expect(hint).toContain('canvas-connect-badge')
    expect(hint).toContain('labels.reuseInput')
    expect(hint).toContain('labels.newInput')
  })

  test('catch-all drops always deconflict the new name (no A.result/B.result collision)', () => {
    // Codex P2: key off the KNOWN target node, deconflicting via nextFreeInputPort
    // — even when the cursor is on the catch-all's outside overhang (resolveDropTarget
    // null). Must NOT fall back to translateInboundConnection's raw source name.
    expect(canvas).toContain('nextFreeInputPort(')
    expect(canvas).toContain('existingInputPorts(definition, targetNode)')
  })

  test('body-drop fallback only fires for a SOURCE-handle drag (no reverse-drag mis-source)', () => {
    // Codex P2: a reverse drag started from a target/input handle must not treat
    // that input as the edge source.
    expect(canvas).toContain("connState.fromHandle?.type !== 'source'")
  })

  test('preview is gated on source handles (preview === release)', () => {
    // Codex P2: a reverse drag from a target handle is not honored on release, so
    // it must not show a New/Reuse preview/line either.
    expect(hint).toContain("connection.fromHandle?.type === 'source'")
    expect(canvas).toContain("fromHandle.type === 'source'")
  })

  test('the tracked pointer is cleared at drag end (no stale click-connect reuse)', () => {
    // Codex P2: click-to-connect never fires onConnectStart, so a stale pointer
    // from a prior drag must not leak into the reuse branch.
    expect(canvas).toContain('connectPointer.current = null')
  })

  test('input handles are purely visual; wiring is drag-only', () => {
    // Codex P2: named input handles are neither connection START (no reverse-drag
    // collision) nor END (no snap-reuse); click-to-connect is disabled so it can't
    // silently no-op on a non-connectable input handle.
    expect(portHandles).toContain('isConnectableStart: false')
    expect(portHandles).toContain('isConnectableEnd: false')
    expect(canvas).toContain('connectOnClick={false}')
  })
})
