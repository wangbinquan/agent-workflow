// RFC-158 — task-detail canvas review-node click → review page.
//
// Locks, from the pure oracle out to the wiring:
//   1. deriveReviewNodeNav: ULID orchestration over the backend-stamped
//      `reviewNavKind` ('awaiting' precedence, ULID-newest 'decided', strict
//      match so an un-stamped older daemon collapses to not-clickable).
//   2. ReviewNode renders the click hint + data-review-nav ONLY when data.reviewNav
//      is set (editor canvas / non-clickable reviews stay hint-free — golden-lock).
//   3. toFlowNodes stamps data.reviewNav only on review nodes present in the map,
//      and NOTHING when no map is passed (byte-for-byte unchanged editor canvas).
//   4. tasks.detail wiring: review nodes route to /reviews (never the drawer),
//      clearSelection BEFORE navigate, search:{}.
//   5. CSS pointer affordance + i18n keys exist.

import { describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { NodeRun } from '@agent-workflow/shared'
import { deriveReviewNodeNav } from '../src/lib/review-node-nav'
import { ReviewNode } from '../src/components/canvas/nodes/ReviewNode'
import type { CanvasNodeData } from '../src/components/canvas/nodes/types'
import { __testToFlowNodes as toFlowNodes } from '../src/components/canvas/WorkflowCanvas'

// --- group 1: deriveReviewNodeNav ------------------------------------------

function run(over: Partial<NodeRun> & Pick<NodeRun, 'id'>): NodeRun {
  return {
    nodeId: 'rev',
    parentNodeRunId: null,
    reviewNavKind: null,
    ...over,
  } as NodeRun
}

describe('deriveReviewNodeNav', () => {
  test('no runs → null', () => {
    expect(deriveReviewNodeNav([], 'rev')).toBeNull()
  })

  test('all reviewNavKind=null → null', () => {
    const runs = [run({ id: '01A' }), run({ id: '01B' })]
    expect(deriveReviewNodeNav(runs, 'rev')).toBeNull()
  })

  test("single 'awaiting' → awaiting target", () => {
    const runs = [run({ id: '01A', reviewNavKind: 'awaiting' })]
    expect(deriveReviewNodeNav(runs, 'rev')).toEqual({ kind: 'awaiting', nodeRunId: '01A' })
  })

  test("freshest run wins: newer 'awaiting' over older 'decided' (US-2 re-review)", () => {
    // The awaiting re-review is minted AFTER the prior decision, so it's ULID-newer.
    const runs = [
      run({ id: '01A', reviewNavKind: 'decided' }),
      run({ id: '01Z', reviewNavKind: 'awaiting' }),
    ]
    expect(deriveReviewNodeNav(runs, 'rev')).toEqual({ kind: 'awaiting', nodeRunId: '01Z' })
  })

  test("freshest run wins: newer 'decided' over older 'decided' → newest", () => {
    const runs = [
      run({ id: '01A', reviewNavKind: 'decided' }),
      run({ id: '01C', reviewNavKind: 'decided' }),
      run({ id: '01B', reviewNavKind: 'decided' }),
    ]
    expect(deriveReviewNodeNav(runs, 'rev')).toEqual({ kind: 'decided', nodeRunId: '01C' })
  })

  test('R3 shadow: newer null run shadows an older decided run → not clickable', () => {
    // Impl-gate regression: the freshest run (re-park-then-supersede) stamps null;
    // it MUST shadow the older human-decided run so the canvas does not route to
    // a stale, superseded conclusion.
    const runs = [
      run({ id: '01A', reviewNavKind: 'decided' }),
      run({ id: '01Z', reviewNavKind: null }),
    ]
    expect(deriveReviewNodeNav(runs, 'rev')).toBeNull()
  })

  test('older null does NOT shadow a newer decided (freshest is the decision)', () => {
    const runs = [
      run({ id: '01A', reviewNavKind: null }),
      run({ id: '01Z', reviewNavKind: 'decided' }),
    ]
    expect(deriveReviewNodeNav(runs, 'rev')).toEqual({ kind: 'decided', nodeRunId: '01Z' })
  })

  test('ignores fan-out shard children (parentNodeRunId set)', () => {
    const runs = [
      // A newer shard child is skipped; the top-level decided is the freshest top-level.
      run({ id: '01Z', reviewNavKind: 'awaiting', parentNodeRunId: 'parent' }),
      run({ id: '01B', reviewNavKind: 'decided' }),
    ]
    expect(deriveReviewNodeNav(runs, 'rev')).toEqual({ kind: 'decided', nodeRunId: '01B' })
  })

  test('does not cross node ids', () => {
    const runs = [run({ id: '01A', nodeId: 'other', reviewNavKind: 'decided' })]
    expect(deriveReviewNodeNav(runs, 'rev')).toBeNull()
  })

  test('absent reviewNavKind (older daemon) → not clickable', () => {
    const runs = [{ id: '01A', nodeId: 'rev', parentNodeRunId: null } as NodeRun]
    expect(deriveReviewNodeNav(runs, 'rev')).toBeNull()
  })
})

// --- group 2: ReviewNode render --------------------------------------------

function reviewData(over: Partial<CanvasNodeData> = {}): CanvasNodeData {
  return {
    surface: over.surface ?? 'task',
    nodeId: 'rev',
    kind: 'review',
    title: 'Review',
    inputPorts: [],
    outputPorts: ['approved_doc'],
    ...over,
  }
}

function mountReview(data: CanvasNodeData) {
  return render(
    <ReactFlowProvider>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <ReviewNode {...({ data, selected: false, id: data.nodeId, type: data.kind } as any)} />
    </ReactFlowProvider>,
  )
}

describe('ReviewNode click affordance', () => {
  // Locale-agnostic: the test i18n resolves to whichever bundle is default, so
  // we assert the hint element + its data attribute rather than a fixed string.
  test("reviewNav='awaiting' → hint line + data-review-nav='awaiting'", () => {
    const { container } = mountReview(reviewData({ reviewNav: 'awaiting' }))
    const hint = container.querySelector('.canvas-node__review-nav')
    expect(hint).toBeTruthy()
    expect((hint?.textContent ?? '').length).toBeGreaterThan(0)
    expect(container.querySelector('[data-review-nav="awaiting"]')).toBeTruthy()
  })

  test("reviewNav='decided' → hint line + data-review-nav='decided'", () => {
    const { container } = mountReview(reviewData({ reviewNav: 'decided' }))
    const hint = container.querySelector('.canvas-node__review-nav')
    expect(hint).toBeTruthy()
    expect((hint?.textContent ?? '').length).toBeGreaterThan(0)
    expect(container.querySelector('[data-review-nav="decided"]')).toBeTruthy()
  })

  test('no reviewNav → no hint line, no data-review-nav attribute (golden-lock)', () => {
    const { container } = mountReview(reviewData())
    expect(container.querySelector('.canvas-node__review-nav')).toBeNull()
    expect(container.querySelector('[data-review-nav]')).toBeNull()
  })
})

// --- group 3: toFlowNodes injection ----------------------------------------

describe('toFlowNodes reviewNav propagation (golden-lock)', () => {
  test('stamps data.reviewNav on a review node present in the map', () => {
    const flow = toFlowNodes(
      [{ id: 'rev', kind: 'review' }],
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { rev: 'decided' },
    )
    expect((flow[0]?.data as CanvasNodeData).reviewNav).toBe('decided')
  })

  test('does not stamp non-review nodes even if keyed', () => {
    const flow = toFlowNodes(
      [{ id: 'a1', kind: 'agent-single' }],
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { a1: 'decided' } as any,
    )
    expect((flow[0]?.data as CanvasNodeData).reviewNav).toBeUndefined()
  })

  test('omits reviewNav entirely when no map is supplied (editor canvas byte-for-byte)', () => {
    const flow = toFlowNodes([{ id: 'rev', kind: 'review' }], [])
    expect((flow[0]?.data as CanvasNodeData).reviewNav).toBeUndefined()
  })
})

// --- group 4/5: wiring + CSS + i18n source locks ---------------------------

const FRONTEND = path.dirname(new URL(import.meta.url).pathname)
const read = (rel: string) => fs.readFile(path.join(FRONTEND, '..', rel), 'utf8')

describe('tasks.detail review-node wiring', () => {
  test('review branch routes to /reviews and never opens the drawer', async () => {
    const src = await read('src/routes/tasks.detail.tsx')
    // The review branch is gated on reviewNodeIds and appears before the
    // drawer-mapping latestRunByNode.get.
    const branchIdx = src.indexOf('reviewNodeIds.has(sel.id)')
    const drawerMapIdx = src.indexOf('latestRunByNode.get(sel.id)')
    expect(branchIdx).toBeGreaterThan(-1)
    expect(drawerMapIdx).toBeGreaterThan(branchIdx)
  })

  test('clearSelection is called BEFORE navigate inside the review branch', async () => {
    const src = await read('src/routes/tasks.detail.tsx')
    expect(src).toMatch(
      /reviewNodeIds\.has\(sel\.id\)\)\s*\{\s*canvasRef\?\.current\?\.clearSelection\(\)\s*onSelectNodeRun\(null\)/,
    )
    const clearIdx = src.indexOf('canvasRef?.current?.clearSelection()')
    const navIdx = src.indexOf("to: '/reviews/$nodeRunId'")
    expect(clearIdx).toBeGreaterThan(-1)
    expect(navIdx).toBeGreaterThan(clearIdx)
  })

  test('navigate target carries search: {}', async () => {
    const src = await read('src/routes/tasks.detail.tsx')
    expect(src).toMatch(
      /to: '\/reviews\/\$nodeRunId',\s*params: \{ nodeRunId: nav\.nodeRunId \},\s*search: \{\},/,
    )
  })

  test('reviewNavs is threaded to WorkflowCanvas', async () => {
    const src = await read('src/routes/tasks.detail.tsx')
    expect(src).toMatch(/reviewNavs=\{reviewNavs\}/)
  })
})

describe('CSS + i18n', () => {
  test('styles.css gives a clickable review node a pointer cursor', async () => {
    const css = await read('src/styles.css')
    expect(css).toMatch(/\.canvas-node--review\[data-review-nav\]\s*\{\s*cursor:\s*pointer/)
  })

  test('both locales define reviewNode.navAwaiting / navDecided', async () => {
    for (const loc of ['zh-CN', 'en-US']) {
      const src = await read(`src/i18n/${loc}.ts`)
      expect(src).toMatch(/navAwaiting:/)
      expect(src).toMatch(/navDecided:/)
    }
  })
})
