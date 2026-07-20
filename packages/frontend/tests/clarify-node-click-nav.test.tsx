// RFC-161 — task-detail canvas clarify-node click → clarify page.
//
// Locks, from the pure oracle out to the wiring:
//   1. deriveClarifyNodeNav: PURE freshest-run over the backend-stamped
//      `clarifyNavKind` (node current state = ULID-newest run; a newer null/guard
//      run shadows an older answered/awaiting one — the fix the design gate
//      converged on). Unlike deriveReviewNodeNav it does NOT filter shard children.
//   2. Clarify/CrossClarifyNode render the click hint + data-clarify-nav ONLY when
//      data.clarifyNav is set (editor canvas / non-clickable stays hint-free).
//   3. toFlowNodes stamps data.clarifyNav only on the two clarify kinds present in
//      the map, and NOTHING when no map is passed (byte-for-byte editor canvas).
//   4. tasks.detail wiring: clarify nodes route to /clarify (never the drawer),
//      clearSelection BEFORE navigate, no search param.
//   5. useTaskSync cross-clarify events invalidate node-runs (keeping directives);
//      CentralizedAnswerDialog full-seal invalidates node-runs locally.
//   6. CSS pointer affordance (both kinds) + i18n keys exist.

import { describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { NodeRun } from '@agent-workflow/shared'
import { deriveClarifyNodeNav } from '../src/lib/clarify-node-nav'
import { ClarifyNode } from '../src/components/canvas/nodes/ClarifyNode'
import { CrossClarifyNode } from '../src/components/canvas/nodes/CrossClarifyNode'
import type { CanvasNodeData } from '../src/components/canvas/nodes/types'
import { __testToFlowNodes as toFlowNodes } from '../src/components/canvas/WorkflowCanvas'

// --- group 1: deriveClarifyNodeNav (pure freshest-run) ---------------------

function run(over: Partial<NodeRun> & Pick<NodeRun, 'id'>): NodeRun {
  return {
    nodeId: 'clr',
    parentNodeRunId: null,
    clarifyNavKind: null,
    ...over,
  } as NodeRun
}

describe('deriveClarifyNodeNav (pure freshest-run)', () => {
  test('no runs → null', () => {
    expect(deriveClarifyNodeNav([], 'clr')).toBeNull()
  })

  test('all clarifyNavKind=null → null', () => {
    const runs = [run({ id: '01A' }), run({ id: '01B' })]
    expect(deriveClarifyNodeNav(runs, 'clr')).toBeNull()
  })

  test("single 'awaiting' → awaiting target", () => {
    const runs = [run({ id: '01A', clarifyNavKind: 'awaiting' })]
    expect(deriveClarifyNodeNav(runs, 'clr')).toEqual({ kind: 'awaiting', nodeRunId: '01A' })
  })

  test("single 'answered' → answered target", () => {
    const runs = [run({ id: '01A', clarifyNavKind: 'answered' })]
    expect(deriveClarifyNodeNav(runs, 'clr')).toEqual({ kind: 'answered', nodeRunId: '01A' })
  })

  test("freshest 'awaiting' over older 'answered' → awaiting (loop iter2 re-ask)", () => {
    const runs = [
      run({ id: '01A', clarifyNavKind: 'answered' }),
      run({ id: '01Z', clarifyNavKind: 'awaiting' }),
    ]
    expect(deriveClarifyNodeNav(runs, 'clr')).toEqual({ kind: 'awaiting', nodeRunId: '01Z' })
  })

  test("freshest 'answered' over older 'awaiting' → answered (shard mixed, documented)", () => {
    // The freshest run is already answered; clicking lands on its read-only echo.
    // Reaching a still-pending older shard is via the detail shard switcher /
    // the node-runs table 'Clarify' button (design §2.3).
    const runs = [
      run({ id: '01A', clarifyNavKind: 'awaiting' }),
      run({ id: '01Z', clarifyNavKind: 'answered' }),
    ]
    expect(deriveClarifyNodeNav(runs, 'clr')).toEqual({ kind: 'answered', nodeRunId: '01Z' })
  })

  test("multi 'answered' → ULID-newest", () => {
    const runs = [
      run({ id: '01A', clarifyNavKind: 'answered' }),
      run({ id: '01C', clarifyNavKind: 'answered' }),
      run({ id: '01B', clarifyNavKind: 'answered' }),
    ]
    expect(deriveClarifyNodeNav(runs, 'clr')).toEqual({ kind: 'answered', nodeRunId: '01C' })
  })

  test("multi 'awaiting' (sharded self-clarify) → ULID-newest shard", () => {
    const runs = [
      run({ id: '01A', clarifyNavKind: 'awaiting' }),
      run({ id: '01C', clarifyNavKind: 'awaiting' }),
      run({ id: '01B', clarifyNavKind: 'awaiting' }),
    ]
    expect(deriveClarifyNodeNav(runs, 'clr')).toEqual({ kind: 'awaiting', nodeRunId: '01C' })
  })

  test('Codex ①: newer null (persistent-stop guard) shadows older answered → null', () => {
    const runs = [
      run({ id: '01A', clarifyNavKind: 'answered' }),
      run({ id: '01Z', clarifyNavKind: null }),
    ]
    expect(deriveClarifyNodeNav(runs, 'clr')).toBeNull()
  })

  test('Codex ②b: newer null shadows a stale older awaiting → null', () => {
    // A cancel-orphaned awaiting run must NOT be reached past a newer null/guard run.
    const runs = [
      run({ id: '01A', clarifyNavKind: 'awaiting' }),
      run({ id: '01Z', clarifyNavKind: null }),
    ]
    expect(deriveClarifyNodeNav(runs, 'clr')).toBeNull()
  })

  test('older null does NOT shadow a newer answered (freshest is the answer)', () => {
    const runs = [
      run({ id: '01A', clarifyNavKind: null }),
      run({ id: '01Z', clarifyNavKind: 'answered' }),
    ]
    expect(deriveClarifyNodeNav(runs, 'clr')).toEqual({ kind: 'answered', nodeRunId: '01Z' })
  })

  test('shard run with parentNodeRunId PARTICIPATES (not filtered) and can be freshest', () => {
    // Unlike deriveReviewNodeNav, a clarify shard session may carry a parent and is
    // a legitimate click target; the backend stamp is the safety gate.
    const runs = [
      run({ id: '01A', clarifyNavKind: null }),
      run({ id: '01Z', clarifyNavKind: 'awaiting', parentNodeRunId: 'parent' }),
    ]
    expect(deriveClarifyNodeNav(runs, 'clr')).toEqual({ kind: 'awaiting', nodeRunId: '01Z' })
  })

  test('does not cross node ids', () => {
    const runs = [run({ id: '01A', nodeId: 'other', clarifyNavKind: 'awaiting' })]
    expect(deriveClarifyNodeNav(runs, 'clr')).toBeNull()
  })

  test('absent clarifyNavKind (older daemon) → not clickable', () => {
    const runs = [{ id: '01A', nodeId: 'clr', parentNodeRunId: null } as NodeRun]
    expect(deriveClarifyNodeNav(runs, 'clr')).toBeNull()
  })
})

// --- group 2: Clarify / CrossClarifyNode render ----------------------------

function clarifyData(over: Partial<CanvasNodeData> = {}): CanvasNodeData {
  return {
    surface: over.surface ?? 'task',
    nodeId: 'clr',
    kind: 'clarify',
    title: 'Clarify',
    inputPorts: [],
    outputPorts: [],
    ...over,
  }
}

function mount(Comp: typeof ClarifyNode | typeof CrossClarifyNode, data: CanvasNodeData) {
  return render(
    <ReactFlowProvider>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <Comp {...({ data, selected: false, id: data.nodeId, type: data.kind } as any)} />
    </ReactFlowProvider>,
  )
}

for (const [name, Comp] of [
  ['ClarifyNode', ClarifyNode],
  ['CrossClarifyNode', CrossClarifyNode],
] as const) {
  describe(`${name} click affordance`, () => {
    test("clarifyNav='awaiting' → hint line + data-clarify-nav='awaiting'", () => {
      const { container } = mount(Comp, clarifyData({ clarifyNav: 'awaiting' }))
      const hint = container.querySelector('.canvas-node__clarify-nav')
      expect(hint).toBeTruthy()
      expect((hint?.textContent ?? '').length).toBeGreaterThan(0)
      expect(container.querySelector('[data-clarify-nav="awaiting"]')).toBeTruthy()
    })

    test("clarifyNav='answered' → hint line + data-clarify-nav='answered'", () => {
      const { container } = mount(Comp, clarifyData({ clarifyNav: 'answered' }))
      const hint = container.querySelector('.canvas-node__clarify-nav')
      expect(hint).toBeTruthy()
      expect((hint?.textContent ?? '').length).toBeGreaterThan(0)
      expect(container.querySelector('[data-clarify-nav="answered"]')).toBeTruthy()
    })

    test('no clarifyNav → no hint line, no data-clarify-nav attribute (golden-lock)', () => {
      const { container } = mount(Comp, clarifyData())
      expect(container.querySelector('.canvas-node__clarify-nav')).toBeNull()
      expect(container.querySelector('[data-clarify-nav]')).toBeNull()
    })
  })
}

// --- group 3: toFlowNodes injection (golden-lock) --------------------------

// clarifyNavs is the 10th positional arg (after reviewNavs, arg 9).
function flowWithClarifyNavs(
  nodes: { id: string; kind: string }[],
  clarifyNavs?: Record<string, 'awaiting' | 'answered'>,
) {
  return toFlowNodes(
    nodes as never,
    [],
    [],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    clarifyNavs,
  )
}

describe('toFlowNodes clarifyNav propagation (golden-lock)', () => {
  test('stamps data.clarifyNav on a clarify node present in the map', () => {
    const flow = flowWithClarifyNavs([{ id: 'clr', kind: 'clarify' }], { clr: 'answered' })
    expect((flow[0]?.data as CanvasNodeData).clarifyNav).toBe('answered')
  })

  test('stamps data.clarifyNav on a cross-clarify node too', () => {
    const flow = flowWithClarifyNavs([{ id: 'x', kind: 'clarify-cross-agent' }], { x: 'awaiting' })
    expect((flow[0]?.data as CanvasNodeData).clarifyNav).toBe('awaiting')
  })

  test('does not stamp non-clarify nodes even if keyed', () => {
    const flow = flowWithClarifyNavs([{ id: 'a1', kind: 'agent-single' }], {
      a1: 'awaiting',
    } as never)
    expect((flow[0]?.data as CanvasNodeData).clarifyNav).toBeUndefined()
  })

  test('omits clarifyNav entirely when no map is supplied (editor canvas byte-for-byte)', () => {
    const flow = flowWithClarifyNavs([{ id: 'clr', kind: 'clarify' }])
    expect((flow[0]?.data as CanvasNodeData).clarifyNav).toBeUndefined()
  })
})

// --- group 4/5/6: wiring + WS + CSS + i18n source locks --------------------

const FRONTEND = path.dirname(new URL(import.meta.url).pathname)
const read = (rel: string) => fs.readFile(path.join(FRONTEND, '..', rel), 'utf8')

describe('tasks.detail clarify-node wiring', () => {
  test('clarify branch routes to /clarify and never opens the drawer', async () => {
    const src = await read('src/routes/tasks.detail.tsx')
    const branchIdx = src.indexOf('clarifyNodeIds.has(sel.id)')
    const drawerMapIdx = src.indexOf('latestRunByNode.get(sel.id)')
    expect(branchIdx).toBeGreaterThan(-1)
    expect(drawerMapIdx).toBeGreaterThan(branchIdx)
  })

  test('clearSelection is called BEFORE navigate inside the clarify branch', async () => {
    const src = await read('src/routes/tasks.detail.tsx')
    expect(src).toMatch(
      /clarifyNodeIds\.has\(sel\.id\)\)\s*\{\s*canvasRef\?\.current\?\.clearSelection\(\)\s*onSelectNodeRun\(null\)/,
    )
    // clarify branch's clearSelection precedes its /clarify navigate.
    const clarifyBranchIdx = src.indexOf('clarifyNodeIds.has(sel.id)')
    const navIdx = src.indexOf("to: '/clarify/$nodeRunId'")
    expect(navIdx).toBeGreaterThan(clarifyBranchIdx)
    // onSelectNodeRun(null) appears in the branch → drawer never opens for clarify.
    expect(src).toMatch(/onSelectNodeRun\(null\)\s*const nav = clarifyNavByNode\.get/)
  })

  test('clarify navigate has NO search param (unlike review)', async () => {
    const src = await read('src/routes/tasks.detail.tsx')
    // The /clarify navigate object closes with params only, no `search:`.
    expect(src).toMatch(
      /to: '\/clarify\/\$nodeRunId',\s*params: \{ nodeRunId: nav\.nodeRunId \},\s*\}/,
    )
  })

  test('clarifyNavs is threaded to WorkflowCanvas', async () => {
    const src = await read('src/routes/tasks.detail.tsx')
    expect(src).toMatch(/clarifyNavs=\{clarifyNavs\}/)
  })
})

describe('useTaskSync cross-clarify node-runs refresh (RFC-161)', () => {
  test('all three cross-clarify events invalidate node-runs (keeping directives)', async () => {
    const src = await read('src/hooks/useTaskSync.ts')
    for (const evt of [
      'cross-clarify.created',
      'cross-clarify.answered',
      'cross-clarify.rejected',
    ]) {
      const idx = src.indexOf(`'${evt}':`)
      expect(idx).toBeGreaterThan(-1)
      // the rule body (up to the next event key) must invalidate node-runs.
      const body = src.slice(idx, idx + 220)
      expect(body).toMatch(/\['tasks', taskId, 'node-runs'\]/)
    }
    // answered/rejected keep the RFC-123 directive invalidation.
    expect(src).toMatch(/'cross-clarify\.answered':[\s\S]*?\['task-clarify-directives', taskId\]/)
    expect(src).toMatch(/'cross-clarify\.rejected':[\s\S]*?\['task-clarify-directives', taskId\]/)
  })
})

describe('CentralizedAnswerDialog full-seal node-runs invalidation (RFC-161)', () => {
  test('success handler invalidates node-runs locally', async () => {
    const src = await read('src/components/clarify/CentralizedAnswerDialog.tsx')
    expect(src).toMatch(/invalidateQueries\(\{ queryKey: \['tasks', taskId, 'node-runs'\] \}\)/)
  })
})

describe('CSS + i18n', () => {
  test('styles.css gives a clickable clarify / cross-clarify node a pointer cursor', async () => {
    const css = await read('src/styles.css')
    expect(css).toMatch(/\.canvas-node--clarify\[data-clarify-nav\]/)
    expect(css).toMatch(/\.canvas-node--clarify-cross-agent\[data-clarify-nav\]/)
    expect(css).toMatch(/cursor:\s*pointer/)
  })

  test('both locales define clarifyNode.navAwaiting / navAnswered', async () => {
    for (const loc of ['zh-CN', 'en-US']) {
      const src = await read(`src/i18n/${loc}.ts`)
      expect(src).toMatch(/navAwaiting:/)
      expect(src).toMatch(/navAnswered:/)
    }
  })
})
