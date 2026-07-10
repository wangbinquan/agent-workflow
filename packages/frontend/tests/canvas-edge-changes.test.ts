// Regression tests for the three EdgeInspector reachability bugs fixed
// in commit 9b7ba31. Each one independently blocked clicking an edge
// from opening the EdgeInspector; we lock the fixes in here so future
// refactors can't silently re-break them.

import { describe, expect, test } from 'vitest'
import { applyEdgeChanges, type Edge, type EdgeChange } from '@xyflow/react'
import {
  affectsEdgeDefinition,
  applySelection,
  clearFlowSelection,
} from '../src/components/canvas/WorkflowCanvas'

// --- Bug 1: handleEdgesChange used to filter ONLY for `remove`. xyflow
// reports edge selection via a `select` change; if we drop that the edge
// never gets `selected: true`, no `.selected` class, no
// onSelectionChange (`{nodes:[], edges:['x']}`), no EdgeInspector. The
// `affectsEdgeDefinition` predicate must say YES for structural changes
// and NO for purely UI ones, so selection-only ticks stay local but
// removals / adds / replacements still round-trip into the persisted
// WorkflowDefinition. ---

describe('affectsEdgeDefinition (handleEdgesChange propagation gate)', () => {
  test('select-only change is local UI state — does NOT affect definition', () => {
    const changes: EdgeChange[] = [{ id: 'e1', type: 'select', selected: true }]
    expect(affectsEdgeDefinition(changes)).toBe(false)
  })

  test('select=false (deselect) is also local-only', () => {
    const changes: EdgeChange[] = [{ id: 'e1', type: 'select', selected: false }]
    expect(affectsEdgeDefinition(changes)).toBe(false)
  })

  test('a remove change DOES affect the definition', () => {
    const changes: EdgeChange[] = [{ id: 'e1', type: 'remove' }]
    expect(affectsEdgeDefinition(changes)).toBe(true)
  })

  test('an add change DOES affect the definition', () => {
    const changes: EdgeChange[] = [
      {
        type: 'add',
        item: {
          id: 'e_new',
          source: 'a',
          target: 'b',
        } as Edge,
      },
    ]
    expect(affectsEdgeDefinition(changes)).toBe(true)
  })

  test('a replace change DOES affect the definition', () => {
    const changes: EdgeChange[] = [
      {
        id: 'e1',
        type: 'replace',
        item: { id: 'e1', source: 'a', target: 'c' } as Edge,
      },
    ]
    expect(affectsEdgeDefinition(changes)).toBe(true)
  })

  test('mixed select + remove still propagates (remove dominates)', () => {
    const changes: EdgeChange[] = [
      { id: 'e1', type: 'select', selected: true },
      { id: 'e2', type: 'remove' },
    ]
    expect(affectsEdgeDefinition(changes)).toBe(true)
  })

  test('empty change list is a no-op', () => {
    expect(affectsEdgeDefinition([])).toBe(false)
  })
})

// --- Bug 1 (continued): the previous `handleEdgesChange` used a custom
// filter that dropped every change type except `remove`. We now use
// xyflow's `applyEdgeChanges` so `select` flows through and edges get
// `selected: true`. This smoke-test pins us to xyflow's helper rather
// than re-rolling our own (which is exactly what introduced the bug). ---

describe('applyEdgeChanges propagates select (regression smoke)', () => {
  const baseEdges: Edge[] = [
    { id: 'e1', source: 'a', target: 'b' },
    { id: 'e2', source: 'b', target: 'c' },
  ]

  test('a `select` change with selected:true sets edge.selected', () => {
    const next = applyEdgeChanges([{ id: 'e1', type: 'select', selected: true }], baseEdges)
    expect(next.find((e) => e.id === 'e1')?.selected).toBe(true)
    // The other edge stays untouched.
    expect(next.find((e) => e.id === 'e2')?.selected).toBeUndefined()
  })

  test('a `select` change with selected:false unsets edge.selected', () => {
    const selected = baseEdges.map((e) => ({ ...e, selected: true }))
    const next = applyEdgeChanges([{ id: 'e1', type: 'select', selected: false }], selected)
    expect(next.find((e) => e.id === 'e1')?.selected).toBe(false)
  })

  test('a `remove` change drops the edge', () => {
    const next = applyEdgeChanges([{ id: 'e1', type: 'remove' }], baseEdges)
    expect(next.map((e) => e.id)).toEqual(['e2'])
  })
})

// --- Bug 2: `selectionOnDrag={true}` + `panOnDrag={[1,2]}` reserved
// every left-button click for a zero-distance lasso, silently swallowing
// edge clicks. We assert here that the WorkflowCanvas source does NOT
// reintroduce `selectionOnDrag`. The check is textual rather than
// behavioral because xyflow's drag/click interpretation is hard to
// simulate in JSDOM, but the bug is a one-line config regression so a
// source assertion catches it cheaply. ---

describe('WorkflowCanvas does not enable selectionOnDrag', () => {
  test('`selectionOnDrag` prop is absent from WorkflowCanvas source', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const here = path.dirname(new URL(import.meta.url).pathname)
    const src = await fs.readFile(
      path.join(here, '../src/components/canvas/WorkflowCanvas.tsx'),
      'utf8',
    )
    // Strip line comments so an explanatory mention in a `//` comment
    // doesn't trip the regex; we only care about an actual prop usage.
    const code = src.replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/selectionOnDrag\s*=/)
  })

  // Since the Shift+drag lasso is the only box-select path (the comment in
  // WorkflowCanvas explains why selectionOnDrag is unsafe), the gesture
  // must stay discoverable. Lock in the bottom-center hint chip + its
  // i18n key so a future refactor doesn't quietly strip it.
  test('canvas renders the Shift box-select hint in editable mode', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const here = path.dirname(new URL(import.meta.url).pathname)
    const src = await fs.readFile(
      path.join(here, '../src/components/canvas/WorkflowCanvas.tsx'),
      'utf8',
    )
    expect(src).toMatch(/workflow-canvas__hint-bottom/)
    expect(src).toMatch(/editor\.boxSelectHint/)

    const zh = await fs.readFile(path.join(here, '../src/i18n/zh-CN.ts'), 'utf8')
    const en = await fs.readFile(path.join(here, '../src/i18n/en-US.ts'), 'utf8')
    expect(zh).toMatch(/boxSelectHint:\s*'按住 Shift 框选'/)
    expect(en).toMatch(/boxSelectHint:\s*'Hold Shift to box-select'/)
  })

  test('WorkflowCanvas threads applySelection through the def-sync rebuild', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const here = path.dirname(new URL(import.meta.url).pathname)
    const src = await fs.readFile(
      path.join(here, '../src/components/canvas/WorkflowCanvas.tsx'),
      'utf8',
    )
    // The def-sync useEffect MUST wrap toFlowNodes/toFlowEdges in
    // applySelection — bug 5 regresses (inspector closes on every
    // keystroke) if either rebuild loses the `selected` flag. After
    // RFC-016 the node path interposes projectDefinitionForXyflow
    // between applySelection and toFlowNodes so xyflow nodes get
    // parentId / relative-position projection at rebuild time. The
    // intent we lock here is "applySelection wraps the result",
    // regardless of any intermediate transform.
    expect(src).toMatch(
      /setNodes\(\s*applySelection\(\s*projectDefinitionForXyflow\(\s*definition,\s*toFlowNodes\(/,
    )
    // setEdges still wraps toFlowEdges in applySelection. After RFC-015 the
    // path additionally spreads buildSourcePortDisplayEdges alongside, so we
    // allow an optional `[` + spread between `setEdges(` and `applySelection`.
    // The control-flow change (toFlowEdges' 2nd arg) lengthens the call so
    // prettier may wrap it onto its own line — allow whitespace between
    // `applySelection(` and `toFlowEdges(` (the locked intent is the wrap).
    expect(src).toMatch(/setEdges\(\s*\[?\s*\.{0,3}\s*applySelection\(\s*toFlowEdges\(/)
  })

  test('Delete-key paths clear parent selection so the inspector column folds away', async () => {
    // Regression: pressing Delete on a selected node removed the node
    // from definition but the parent route's `selection` state still
    // held `{kind:'node', id:'foo'}` → `editorLayoutClass` kept the
    // 3rd grid column open AND `canvas-frame` stayed at its narrower
    // width because the grid column track was still reserved. xyflow's
    // built-in `deleteKeyCode` fires `onNodesChange` / `onEdgesChange`
    // — NOT our `deleteSelected` callback (which is wired only to the
    // right-click menu). So all THREE paths must clear onSelect.
    //
    // Source-level lock because triggering xyflow's Delete-key path in
    // JSDOM is brittle; the regex survives prettier reformatting.
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const here = path.dirname(new URL(import.meta.url).pathname)
    const src = await fs.readFile(
      path.join(here, '../src/components/canvas/WorkflowCanvas.tsx'),
      'utf8',
    )

    function bodyOf(opener: string, closer: string): string {
      const start = src.indexOf(opener)
      expect(start).toBeGreaterThan(-1)
      const end = src.indexOf(closer, start)
      return src.slice(start, end)
    }

    // Path 1: right-click menu / explicit deleteSelected callback.
    const deleteSelectedBody = bodyOf('const deleteSelected = useCallback(', '[commitChange')
    expect(deleteSelectedBody).toMatch(/lastEmittedSelectionSig\.current\s*=\s*['"]null['"]/)
    expect(deleteSelectedBody).toMatch(/onSelect\s*\(\s*null\s*\)/)

    // Path 2: Delete key on a selected node — handleNodesChange must
    // detect that the emitted-selection node id is in removedIds and
    // clear the parent selection.
    const handleNodesChangeBody = bodyOf(
      'const handleNodesChange = useCallback(',
      '[commitChange, definition, edges',
    )
    expect(handleNodesChangeBody).toMatch(/lastEmittedSelectionSig\.current/)
    expect(handleNodesChangeBody).toMatch(/onSelect\s*\(\s*null\s*\)/)

    // Path 3: Delete key on a selected edge — same shape via
    // handleEdgesChange.
    const handleEdgesChangeBody = bodyOf(
      'const handleEdgesChange = useCallback(',
      '[commitChange, definition, nodes',
    )
    expect(handleEdgesChangeBody).toMatch(/lastEmittedSelectionSig\.current/)
    expect(handleEdgesChangeBody).toMatch(/onSelect\s*\(\s*null\s*\)/)
  })
})

// --- Bug 4: clicking the EdgeInspector ✕ used to call only
// `setSelection(null)` in the route. That left xyflow's edge.selected
// = true AND pinned `lastEmittedSelectionSig` to `edge:<id>`, so:
//   - the edge stayed visually highlighted
//   - the next click on the same edge produced no new `select` change
//     (xyflow had nothing to flip), the onSelectionChange/onEdgeClick
//     dedupe swallowed it, and the inspector never reopened.
// The fix is the imperative `clearSelection` handle on WorkflowCanvas;
// `clearFlowSelection` is its pure inner step.

describe('clearFlowSelection (EdgeInspector close → reclick reachability)', () => {
  test('flips selected:true → false on every item', () => {
    const before = [
      { id: 'a', selected: true },
      { id: 'b', selected: true },
    ]
    const after = clearFlowSelection(before)
    expect(after).not.toBe(before)
    expect(after.every((it) => it.selected === false)).toBe(true)
  })

  test('leaves items without selected:true untouched (reference-stable)', () => {
    const before = [{ id: 'a', selected: false }, { id: 'b' }]
    const after = clearFlowSelection(before)
    // Reference equality matters — returning a fresh array on every call
    // would mint a new xyflow edges/nodes array every render and retrigger
    // the def-sync useEffect feedback loop the canvas already had to guard.
    expect(after).toBe(before)
  })

  test('mixed array: only the selected entries are cloned', () => {
    const before = [
      { id: 'a', selected: true },
      { id: 'b', selected: false },
    ]
    const after = clearFlowSelection(before)
    expect(after).not.toBe(before)
    expect(after[0]).not.toBe(before[0])
    expect(after[0]?.selected).toBe(false)
    expect(after[1]).toBe(before[1])
  })

  test('empty array is the identity', () => {
    const before: Array<{ selected?: boolean }> = []
    expect(clearFlowSelection(before)).toBe(before)
  })
})

// Source-text assertion: the editor route MUST route both inspector
// close paths (Edge + Node in /workflows/$id — creation moved into the
// /workflows list-page quick-create dialog and has no canvas anymore)
// through `canvasRef.current?.clearSelection()` — otherwise the bug
// regresses silently because the inspector still unmounts and looks
// closed, but the underlying edge stays stuck-selected. Each individual
// step is hard to simulate in JSDOM (xyflow needs ResizeObserver +
// layout), so we mirror the existing `selectionOnDrag` style and pin
// the wiring textually.

// --- Bug 5: editing any field in the NodeInspector closed the inspector
// on every keystroke. Root cause: NodeInspector's onChange minted a new
// `definition` reference; the def-sync useEffect rebuilt nodes/edges via
// `toFlowNodes` / `toFlowEdges` which DON'T carry `selected: true`; xyflow
// saw the selected node go from selected to not-selected and fired
// onSelectionChange with empty arrays; our handler routed that through
// onSelect(null) and the parent unmounted the inspector. Fix: restore
// `selected:true` on the rebuild path via `applySelection`.

describe('applySelection (def-sync rebuild keeps the selected flag)', () => {
  test('flips selected:true on items whose id is in the set', () => {
    const before: Array<{ id: string; selected?: boolean }> = [
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ]
    const after = applySelection(before, ['b'])
    expect(after).not.toBe(before)
    expect(after.find((i) => i.id === 'b')?.selected).toBe(true)
    expect(after.find((i) => i.id === 'a')?.selected).toBeUndefined()
    expect(after.find((i) => i.id === 'c')?.selected).toBeUndefined()
  })

  test('no-op (reference-stable) when the matched item is already selected', () => {
    const before = [{ id: 'a', selected: true }, { id: 'b' }]
    const after = applySelection(before, ['a'])
    // Critical: returning a fresh array would mint new xyflow node refs on
    // every keystroke, retriggering def-sync via the parent's onChange
    // and ultimately the same render storm we already guard against.
    expect(after).toBe(before)
  })

  test('no-op when the selected id is not in the items', () => {
    const before = [{ id: 'a' }]
    expect(applySelection(before, ['missing'])).toBe(before)
  })

  test('empty selectedIds → identity', () => {
    const before = [{ id: 'a' }, { id: 'b' }]
    expect(applySelection(before, [])).toBe(before)
  })

  test('mixed selection: only the matching item gets cloned', () => {
    const before = [{ id: 'a' }, { id: 'b', selected: true }, { id: 'c' }]
    const after = applySelection(before, ['a', 'b'])
    expect(after).not.toBe(before)
    expect(after[0]).not.toBe(before[0])
    expect(after[0]?.selected).toBe(true)
    // b was already selected — same ref preserved when we walked it.
    expect(after[1]).toBe(before[1])
    expect(after[2]).toBe(before[2])
  })
})

describe('workflows.edit.tsx wires clearSelection into inspector close', () => {
  test('route source calls canvasRef.current?.clearSelection() and uses it on both Edge + Node onClose', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const here = path.dirname(new URL(import.meta.url).pathname)
    const src = await fs.readFile(path.join(here, '../src/routes/workflows.edit.tsx'), 'utf8')
    expect(src).toMatch(/canvasRef\.current\?\.clearSelection\(\)/)
    // Both inspectors share the `closeInspector` helper; it must be
    // wired on EdgeInspector AND NodeInspector. The edit route is the
    // only canvas block left (creation is a list-page dialog), so we
    // expect at least one Edge + one Node occurrence.
    const onCloseHits = src.match(/onClose=\{closeInspector\}/g) ?? []
    expect(onCloseHits.length).toBeGreaterThanOrEqual(2)
    // Forbid the old pattern that left the edge stuck.
    expect(src).not.toMatch(/onClose=\{\(\) => setSelection\(null\)\}/)
  })
})
