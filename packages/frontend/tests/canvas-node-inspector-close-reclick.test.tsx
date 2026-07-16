// Regression: in /workflows/:id, clicking the NodeInspector ✕ used to leave
// the node visually selected and unclickable. Source-text test in
// `canvas-edge-changes.test.ts:258` only proved that the route wires
// `closeInspector` through `canvasRef.current?.clearSelection()` — but the
// inner implementation, `setNodes((prev) => clearFlowSelection(prev))`,
// only flipped React-side `selected: false`. xyflow's internal
// `handleNodeClick` reads `nodeLookup.get(id).selected` to decide between
// `addSelectedNodes` and `unselectNodesAndEdges`; if the internal flag
// stays `true` and multi-select isn't active, NEITHER branch fires and the
// click is swallowed. Symptom: node stays highlighted, inspector never
// reopens.
//
// Fix: drive `unselectNodesAndEdges()` via `useStoreApi`, which mutates
// `internalNode.selected = false` synchronously AND emits the proper
// change events back through onNodesChange.
//
// Lock that with a source-text guard so a future refactor cannot silently
// revert to the broken `setNodes(clearFlowSelection)` body.

import { describe, expect, test } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const SRC = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '../src/components/canvas/WorkflowCanvas.tsx',
)

describe('clearSelection drives xyflow unselectNodesAndEdges', () => {
  test('imports useStoreApi from @xyflow/react', async () => {
    const src = await fs.readFile(SRC, 'utf8')
    // The canonical xyflow API needs the store handle. Without the
    // import, the call below would be impossible.
    expect(src).toMatch(/from '@xyflow\/react'/)
    expect(src).toMatch(/useStoreApi/)
  })

  test('CanvasInner grabs the storeApi handle', async () => {
    const src = await fs.readFile(SRC, 'utf8')
    expect(src).toMatch(/const storeApi = useStoreApi\(\)/)
  })

  test('clearSelection body calls storeApi.getState().unselectNodesAndEdges()', async () => {
    const src = await fs.readFile(SRC, 'utf8')
    // Anchor on the imperative-handle block to avoid matching unrelated
    // mentions in comments.
    const block = src.match(
      /useImperativeHandle\([\s\S]*?clearSelection: \(\) => \{[\s\S]*?\},\s*\}\),\s*\[storeApi\],\s*\)/,
    )
    expect(block).not.toBeNull()
    expect(block?.[0] ?? '').toMatch(/storeApi\.getState\(\)\.unselectNodesAndEdges\(\)/)
    // Forbid the old broken impl from creeping back in.
    expect(block?.[0] ?? '').not.toMatch(/setNodes\(\(prev\) => clearFlowSelection\(prev\)\)/)
    expect(block?.[0] ?? '').not.toMatch(/setEdges\(\(prev\) => clearFlowSelection\(prev\)\)/)
  })

  test('storeApi is a dep of useImperativeHandle so React refreshes the handle if the provider remounts', async () => {
    const src = await fs.readFile(SRC, 'utf8')
    // [] would freeze a closure over the first storeApi, which is benign
    // today (storeApi is stable per ReactFlowProvider) but is a footgun if
    // we ever mount the canvas outside its own ReactFlowProvider.
    expect(src).toMatch(/useImperativeHandle\([\s\S]*?\),\s*\[storeApi\],\s*\)/)
  })

  test('still resets the dedupe sig and the local selection mirror', async () => {
    const src = await fs.readFile(SRC, 'utf8')
    const block = src.match(/clearSelection: \(\) => \{[\s\S]*?\n\s*\},\n\s*restoreSelection:/)
    expect(block?.[0] ?? '').toMatch(/lastEmittedSelectionSig\.current = 'null'/)
    expect(block?.[0] ?? '').toMatch(/setSelection\(\(prev\) =>/)
  })
})

// `clearFlowSelection` survives as a pure helper used by the def-sync
// rebuild path's tests, but the imperative-handle MUST NOT use it anymore
// (it doesn't touch xyflow's internal store). This test pins that
// separation so a future cleanup that tries to "reuse" the helper inside
// the handle re-introduces the bug.
describe('clearSelection does not delegate to clearFlowSelection', () => {
  test('clearFlowSelection is not referenced inside the imperative handle', async () => {
    const src = await fs.readFile(SRC, 'utf8')
    const block = src.match(/clearSelection: \(\) => \{[\s\S]*?\n\s*\},\n\s*restoreSelection:/)
    expect(block?.[0] ?? '').not.toMatch(/clearFlowSelection/)
  })
})
