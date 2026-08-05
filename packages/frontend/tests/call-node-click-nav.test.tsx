// RFC-245 — task-detail canvas call-node click → child task.
//
// Locks, from the pure oracle out to the wiring (same six-group shape as
// clarify-node-click-nav.test.tsx, plus the three groups the design gate added):
//   1. deriveCallNodeNav: strict freshest TOP-LEVEL run, mirroring
//      isFresherNodeRun (services/freshness.ts). A newer run WITHOUT a
//      childTaskId shadows an older one that has one — a retry's fresh empty
//      generation must never route to the superseded child.
//   2. callNavIsReachable: demote only on PROVEN absence (children list loaded
//      and missing the id); loading/errored keeps the node clickable.
//   3. CallWorkflowNode / CallWorkgroupNode render the hint + data-call-nav ONLY
//      when data.callNav is set (editor canvas / non-clickable stays hint-free).
//   4. toFlowNodes stamps data.callNav only on the two call kinds present in the
//      map, and NOTHING when no map is passed (byte-for-byte editor canvas).
//   5. WorkflowCanvas repaints on a callNavs-ONLY change — the design gate's
//      P1-3: a ref-guard without the effect dependency leaves the card's hint
//      stale while the click closure has already updated.
//   6. tasks.detail wiring: call nodes route to /tasks (never the drawer),
//      clearSelection BEFORE navigate, children query gated + parentActive.
//   7. Route remountDeps — detail→detail navigation must not carry the previous
//      task's selectedNodeRunId (which reserves an empty drawer column).
//   8. The node-runs table's call-row drawer entry (design D1 compensation:
//      Retry + cascade + attempt history live ONLY in the drawer).
//   9. CSS pointer affordance + i18n keys exist in both locales.

import { afterEach, describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { ReactFlowProvider } from '@xyflow/react'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NodeRun, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { WorkflowCanvas } from '../src/components/canvas/WorkflowCanvas'
import i18n from '../src/i18n'
import { callNavIsReachable, deriveCallNodeNav } from '../src/lib/call-node-nav'
import { CallWorkflowNode } from '../src/components/canvas/nodes/CallWorkflowNode'
import { CallWorkgroupNode } from '../src/components/canvas/nodes/CallWorkgroupNode'
import type { CanvasNodeData } from '../src/components/canvas/nodes/types'
import { __testToFlowNodes as toFlowNodes } from '../src/components/canvas/WorkflowCanvas'
import { deriveCanvasNodeStatuses, isCallNodeKind } from '../src/routes/tasks.detail'

afterEach(() => {
  document.body.innerHTML = ''
})

// --- group 1: deriveCallNodeNav (pure freshest-run) ------------------------

function run(over: Partial<NodeRun> & Pick<NodeRun, 'id'>): NodeRun {
  return {
    nodeId: 'call1',
    parentNodeRunId: null,
    childTaskId: null,
    ...over,
  } as NodeRun
}

describe('deriveCallNodeNav (strict freshest generation)', () => {
  test('no runs → null', () => {
    expect(deriveCallNodeNav([], 'call1')).toBeNull()
  })

  test('runs without childTaskId → null (not dispatched / failed before launch)', () => {
    expect(deriveCallNodeNav([run({ id: '01A' }), run({ id: '01B' })], 'call1')).toBeNull()
  })

  test('single run with a child → that child', () => {
    expect(deriveCallNodeNav([run({ id: '01A', childTaskId: 'kid-a' })], 'call1')).toEqual({
      childTaskId: 'kid-a',
    })
  })

  test('multiple generations → freshest child (loop iteration 2 wins)', () => {
    const runs = [
      run({ id: '01A', childTaskId: 'kid-iter1' }),
      run({ id: '01Z', childTaskId: 'kid-iter2' }),
    ]
    expect(deriveCallNodeNav(runs, 'call1')).toEqual({ childTaskId: 'kid-iter2' })
  })

  test('newer EMPTY run shadows an older run that has a child (retry mint window)', () => {
    // retryNode mints a fresh generation whose child is not launched yet. The
    // node must be un-clickable in that window rather than route to the child
    // the retry just superseded.
    const runs = [run({ id: '01A', childTaskId: 'kid-old' }), run({ id: '01Z' })]
    expect(deriveCallNodeNav(runs, 'call1')).toBeNull()
  })

  test('daemon-shutdown adoption: a CANCELED freshest row keeps its child clickable', () => {
    // scheduler.ts's ADOPTABLE_CALL_ROW_STATUSES = pending|running|interrupted|
    // canceled: a call row that a daemon shutdown settled as `canceled` is
    // RE-ADOPTED in place on resume (minting a new row would abandon the
    // child's canonical iso). So the freshest row still owns the live child and
    // must stay clickable — this is why the oracle keys on childTaskId, never on
    // the row's status.
    const runs = [run({ id: '01A', childTaskId: 'kid-a', status: 'canceled' } as never)]
    expect(deriveCallNodeNav(runs, 'call1')).toEqual({ childTaskId: 'kid-a' })
  })

  test('cascade retry placeholder shadows an older row whose child may still be live', () => {
    // retryNode's cascade mints `retryIndex+1` placeholders for downstream call
    // nodes WITHOUT cancelling their children (an RFC-243 backend gap, logged in
    // docs/audit-backlog.md). Freshest-wins keeps the canvas SAFE in that state:
    // it goes inert rather than routing to a generation the parent has already
    // superseded. The older row's child stays reachable from the node-runs table.
    const runs = [
      run({ id: '01A', childTaskId: 'kid-old', status: 'done' } as never),
      run({ id: '01Z', status: 'failed', errorMessage: 'queued for retry' } as never),
    ]
    expect(deriveCallNodeNav(runs, 'call1')).toBeNull()
  })

  test('ULID ordering, not array order', () => {
    const runs = [
      run({ id: '01C', childTaskId: 'kid-c' }),
      run({ id: '01A', childTaskId: 'kid-a' }),
      run({ id: '01B', childTaskId: 'kid-b' }),
    ]
    expect(deriveCallNodeNav(runs, 'call1')).toEqual({ childTaskId: 'kid-c' })
  })

  test('shard children (parentNodeRunId set) are filtered out entirely', () => {
    // RFC-243 v1 rejects call-in-fanout, so no such row exists today; the filter
    // is defensive so a future per-shard call cannot silently inherit this rule.
    const runs = [
      run({ id: '01A', childTaskId: 'kid-top' }),
      run({ id: '01Z', childTaskId: 'kid-shard', parentNodeRunId: 'parent-run' }),
    ]
    expect(deriveCallNodeNav(runs, 'call1')).toEqual({ childTaskId: 'kid-top' })
  })

  test('does not cross node ids', () => {
    const runs = [run({ id: '01A', nodeId: 'other', childTaskId: 'kid-a' })]
    expect(deriveCallNodeNav(runs, 'call1')).toBeNull()
  })

  test('absent childTaskId field (older daemon) → not clickable', () => {
    const runs = [{ id: '01A', nodeId: 'call1', parentNodeRunId: null } as NodeRun]
    expect(deriveCallNodeNav(runs, 'call1')).toBeNull()
  })

  test('empty-string childTaskId is treated as absent', () => {
    expect(deriveCallNodeNav([run({ id: '01A', childTaskId: '' })], 'call1')).toBeNull()
  })

  test('canvas status uses that same freshest generation even before startedAt is stamped', () => {
    const runs = [
      run({ id: '01A', childTaskId: 'kid-old', status: 'done', startedAt: 100 } as never),
      run({ id: '01Z', status: 'pending', startedAt: null } as never),
    ]
    expect(deriveCanvasNodeStatuses(runs, new Set(['call1']))).toEqual({ call1: 'pending' })
  })
})

// --- group 2: callNavIsReachable (ACL composition, design D5) --------------

describe('callNavIsReachable (proof of absence, not absence of proof)', () => {
  test('children still loading / errored (undefined) → reachable', () => {
    expect(callNavIsReachable('kid-a', undefined)).toBe(true)
  })

  test('children loaded and containing the child → reachable', () => {
    expect(callNavIsReachable('kid-a', [{ id: 'kid-a' }, { id: 'kid-b' }])).toBe(true)
  })

  test('children loaded WITHOUT the child (deleted / invisible) → not reachable', () => {
    expect(callNavIsReachable('kid-a', [{ id: 'kid-b' }])).toBe(false)
  })

  test('children loaded empty → not reachable', () => {
    expect(callNavIsReachable('kid-a', [])).toBe(false)
  })

  test('refetch error wins over retained stale data → reachable', () => {
    // TanStack Query can expose isError together with its last successful [];
    // D5 treats query failure as absence-of-proof, so stale [] must not demote.
    expect(callNavIsReachable('kid-a', [], true)).toBe(true)
  })
})

// --- group 3: node render -------------------------------------------------

function callData(over: Partial<CanvasNodeData> = {}): CanvasNodeData {
  return {
    surface: over.surface ?? 'task',
    nodeId: 'call1',
    kind: 'call-workflow',
    title: 'Call',
    inputPorts: [],
    outputPorts: [],
    ...over,
  }
}

function mount(Comp: typeof CallWorkflowNode | typeof CallWorkgroupNode, data: CanvasNodeData) {
  return render(
    <ReactFlowProvider>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <Comp {...({ data, selected: false, id: data.nodeId, type: data.kind } as any)} />
    </ReactFlowProvider>,
  )
}

for (const [name, Comp, kind] of [
  ['CallWorkflowNode', CallWorkflowNode, 'call-workflow'],
  ['CallWorkgroupNode', CallWorkgroupNode, 'call-workgroup'],
] as const) {
  describe(`${name} click affordance`, () => {
    test("callNav='child' → hint line + data-call-nav", () => {
      const { container } = mount(Comp, callData({ kind, callNav: 'child' }))
      const hint = container.querySelector('.canvas-node__call-nav')
      expect(hint).toBeTruthy()
      expect((hint?.textContent ?? '').length).toBeGreaterThan(0)
      expect(container.querySelector('[data-call-nav="child"]')).toBeTruthy()
    })

    test('no callNav → no hint line, no data-call-nav (golden-lock)', () => {
      const { container } = mount(Comp, callData({ kind }))
      expect(container.querySelector('.canvas-node__call-nav')).toBeNull()
      expect(container.querySelector('[data-call-nav]')).toBeNull()
    })

    test('data-reference-state survives alongside data-call-nav', () => {
      const { container } = mount(Comp, callData({ kind, callNav: 'child' }))
      expect(container.querySelector('[data-reference-state]')).toBeTruthy()
    })
  })
}

// --- group 4: toFlowNodes injection (golden-lock) --------------------------

// callNavs is the 14th positional arg (appended after workflowByRef, arg 13).
function flowWithCallNavs(
  nodes: { id: string; kind: string }[],
  callNavs?: Record<string, 'child'>,
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
    undefined,
    undefined,
    'task',
    undefined,
    callNavs,
  )
}

describe('toFlowNodes callNav propagation (golden-lock)', () => {
  test('stamps data.callNav on a call-workflow node present in the map', () => {
    const flow = flowWithCallNavs([{ id: 'c1', kind: 'call-workflow' }], { c1: 'child' })
    expect((flow[0]?.data as CanvasNodeData).callNav).toBe('child')
  })

  test('stamps data.callNav on a call-workgroup node too', () => {
    const flow = flowWithCallNavs([{ id: 'c2', kind: 'call-workgroup' }], { c2: 'child' })
    expect((flow[0]?.data as CanvasNodeData).callNav).toBe('child')
  })

  test('does not stamp non-call nodes even if keyed', () => {
    const flow = flowWithCallNavs([{ id: 'a1', kind: 'agent-single' }], {
      a1: 'child',
    } as never)
    expect((flow[0]?.data as CanvasNodeData).callNav).toBeUndefined()
  })

  test('call node absent from the map stays un-clickable', () => {
    const flow = flowWithCallNavs([{ id: 'c1', kind: 'call-workflow' }], { other: 'child' })
    expect((flow[0]?.data as CanvasNodeData).callNav).toBeUndefined()
  })

  test('omits callNav entirely when no map is supplied (editor canvas byte-for-byte)', () => {
    const flow = flowWithCallNavs([{ id: 'c1', kind: 'call-workflow' }])
    expect((flow[0]?.data as CanvasNodeData).callNav).toBeUndefined()
  })

  test('appending at position 14 leaves the existing positional args intact', () => {
    // A 13-arg call (the shape every pre-RFC-245 test uses) still resolves
    // `surface` to 'editor' — proof the new parameter was appended, not inserted.
    const flow = toFlowNodes(
      [{ id: 'c1', kind: 'call-workflow' }] as never,
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'editor',
      undefined,
    )
    expect((flow[0]?.data as CanvasNodeData).surface).toBe('editor')
    expect((flow[0]?.data as CanvasNodeData).callNav).toBeUndefined()
  })
})

// --- group 5-9: wiring + route + table + CSS + i18n source locks -----------

const FRONTEND = path.dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => fs.readFile(path.join(FRONTEND, '..', rel), 'utf8')

describe('WorkflowCanvas repaints on a callNavs-ONLY change (design-gate P1-3)', () => {
  // The behavioral half of the P1-3 lock: a ref-guard without the effect
  // dependency never re-runs the rebuild, so the card's hint/cursor would stay
  // stale while the parent's click closure had already updated — visual and
  // behavior silently diverge. Same definition object across all three renders,
  // so ONLY callNavs changes.
  const def: WorkflowDefinition = {
    $schema_version: 2,
    inputs: [],
    nodes: [
      {
        id: 'call1',
        kind: 'call-workflow',
        workflowName: 'child-flow',
      } as unknown as WorkflowNode,
    ],
    edges: [],
  }
  // STABLE identities for every other input. An inline `agents={[]}` would mint
  // a new array per render, flip the canvas' `agentsChanged` guard and rebuild
  // the nodes for the wrong reason — the test would then pass even with the
  // `callNavs` dependency removed (verified: it did).
  const NO_AGENTS: never[] = []
  const view = (callNavs?: Record<string, 'child'>) => (
    <I18nextProvider i18n={i18n}>
      <WorkflowCanvas
        surface="task"
        definition={def}
        agents={NO_AGENTS}
        callNavs={callNavs}
        readOnly
      />
    </I18nextProvider>
  )

  test('undefined → present → absent flips the hint and the data attribute', () => {
    const { container, rerender } = render(view(undefined))
    expect(container.querySelector('[data-call-nav]')).toBeNull()

    // children query resolves / child task appears
    rerender(view({ call1: 'child' }))
    expect(container.querySelector('[data-call-nav="child"]')).toBeTruthy()
    expect(container.querySelector('.canvas-node__call-nav')).toBeTruthy()

    // child becomes unreachable (deleted / retry minted a fresh empty run)
    rerender(view({}))
    expect(container.querySelector('[data-call-nav]')).toBeNull()
    expect(container.querySelector('.canvas-node__call-nav')).toBeNull()
  })
})

describe('WorkflowCanvas callNavs plumbing (design-gate P1-3)', () => {
  test('callNavs is in the def-sync effect dependency array, not just the ref-guard', async () => {
    const src = await read('src/components/canvas/WorkflowCanvas.tsx')
    // ref-guard
    expect(src).toMatch(/const externalCallNavsRef = useRef\(callNavs\)/)
    expect(src).toMatch(/const callNavsChanged = callNavs !== externalCallNavsRef\.current/)
    // …and the dependency that makes the effect run at all. The array is the one
    // ending in `workflowByRef,\n  ])` right after the def-sync effect body.
    const effectIdx = src.indexOf('const callNavsChanged =')
    const depsIdx = src.indexOf('workflowByRef,\n  ])', effectIdx)
    expect(depsIdx).toBeGreaterThan(effectIdx)
    expect(src.slice(effectIdx, depsIdx)).toMatch(/\n {4}callNavs,\n/)
  })

  test('all three production toFlowNodes call sites pass callNavs', async () => {
    const src = await read('src/components/canvas/WorkflowCanvas.tsx')
    // initial state / def-sync rebuild / undo-restore rebuild + the test export.
    const occurrences = src.match(/^\s*callNavs,$/gm) ?? []
    expect(occurrences.length).toBeGreaterThanOrEqual(4)
  })
})

describe('tasks.detail call-node wiring', () => {
  test('call branch routes to /tasks and never opens the drawer', async () => {
    const src = await read('src/routes/tasks.detail.tsx')
    const branchIdx = src.indexOf('callNodeIds.has(sel.id)')
    const drawerMapIdx = src.indexOf('latestRunByNode.get(sel.id)')
    expect(branchIdx).toBeGreaterThan(-1)
    expect(drawerMapIdx).toBeGreaterThan(branchIdx)
    expect(src).toMatch(/to: '\/tasks\/\$id', params: \{ id: childTaskId \}/)
  })

  test('clearSelection is called BEFORE navigate inside the call branch', async () => {
    const src = await read('src/routes/tasks.detail.tsx')
    expect(src).toMatch(
      /callNodeIds\.has\(sel\.id\)\)\s*\{\s*canvasRef\?\.current\?\.clearSelection\(\)\s*onSelectNodeRun\(null\)/,
    )
    // onSelectNodeRun(null) sits in the branch → drawer never opens for calls.
    expect(src).toMatch(/onSelectNodeRun\(null\)\s*const childTaskId = callNavByNode\.get/)
  })

  test('callNavs is threaded to WorkflowCanvas', async () => {
    const src = await read('src/routes/tasks.detail.tsx')
    expect(src).toMatch(/callNavs=\{callNavs\}/)
  })

  test('children query is gated on having call nodes and on parent activity', async () => {
    const src = await read('src/routes/tasks.detail.tsx')
    expect(src).toMatch(
      /useTaskChildren\(task\.id, callNodeIds\.size > 0, !isTerminal\(task\.status\)\)/,
    )
  })

  test('reachability gate is applied when building callNavByNode', async () => {
    const src = await read('src/routes/tasks.detail.tsx')
    expect(src).toMatch(/callNavIsReachable\(nav\.childTaskId, children\.data, children\.isError\)/)
  })
})

describe('children query re-validation (design-gate P0-2)', () => {
  test('useTaskSync invalidates the children key on node.status and on task terminal', async () => {
    const src = await read('src/hooks/useTaskSync.ts')
    const nodeStatusIdx = src.indexOf("'node.status':")
    expect(nodeStatusIdx).toBeGreaterThan(-1)
    expect(src.slice(nodeStatusIdx, nodeStatusIdx + 900)).toMatch(/taskChildrenQueryKey\(/)
    const terminalIdx = src.indexOf('const taskTerminal =')
    expect(src.slice(terminalIdx, nodeStatusIdx)).toMatch(/taskChildrenQueryKey\(/)
  })

  test('useTaskChildren keeps polling while the parent is active', async () => {
    const src = await read('src/hooks/useTaskChildren.ts')
    expect(src).toMatch(/parentActive: boolean = false/)
    expect(src).toMatch(/refetchInterval: \(q\) =>\s*\n?\s*parentActive \|\|/)
  })
})

describe('task detail route remount (design D8)', () => {
  test('remountDeps keys on params so detail→detail does not carry task state', async () => {
    const src = await read('src/routes/tasks.detail.tsx')
    expect(src).toMatch(/remountDeps: \(\{ params \}\) => params/)
  })

  test('the empty-drawer column is what stale selection would leave behind', async () => {
    // Guards the reason the remount matters: layout only checks non-null.
    const src = await read('src/routes/tasks.detail.tsx')
    expect(src).toMatch(
      /selectedNodeRunId !== null\s*\?\s*'task-canvas-layout task-canvas-layout--with-drawer'/,
    )
  })
})

describe('node-runs table call-row drawer entry (design D1 compensation)', () => {
  test('isCallNodeKind covers exactly the two call kinds', () => {
    expect(isCallNodeKind('call-workflow')).toBe(true)
    expect(isCallNodeKind('call-workgroup')).toBe(true)
    expect(isCallNodeKind('agent-single')).toBe(false)
    expect(isCallNodeKind(null)).toBe(false)
  })

  test('the entry is gated on the workflow-status pane existing', async () => {
    // The drawer only renders inside that pane, so offering the button on a tab
    // set without it would navigate nowhere useful.
    const src = await read('src/routes/tasks.detail.tsx')
    expect(src).toMatch(
      /onOpenRunDetail=\{canOfferFailedJump\(displayedTabs\) \? openRunDetail : undefined\}/,
    )
  })

  test('the button renders only for call rows and opens the drawer pane', async () => {
    const src = await read('src/routes/tasks.detail.tsx')
    expect(src).toMatch(/isCallNodeKind\(nodeKind\) \|\| r\.childTaskId != null/)
    expect(src).toMatch(/data-testid=\{`node-run-detail-\$\{r\.id\}`\}/)
    // openRunDetail selects the run and switches to the pane hosting the drawer.
    expect(src).toMatch(
      /const openRunDetail = useCallback\(\s*\(nodeRunId: string\) => \{\s*setSelectedNodeRunId\(nodeRunId\)\s*navigateTaskTab\('workflow-status'\)/,
    )
  })
})

describe('CSS + i18n', () => {
  test('styles.css gives a clickable call node a pointer cursor', async () => {
    const css = await read('src/styles.css')
    expect(css).toMatch(/\.canvas-node--call\[data-call-nav\]\s*\{\s*cursor:\s*pointer/)
    expect(css).toMatch(/\.canvas-node__call-nav/)
  })

  test('both locales define callNode.navChild and tasks.runDetailButton', async () => {
    for (const loc of ['zh-CN', 'en-US']) {
      const src = await read(`src/i18n/${loc}.ts`)
      expect(src).toMatch(/callNode: \{\s*navChild:/)
      expect(src).toMatch(/runDetailButton:/)
    }
  })
})
