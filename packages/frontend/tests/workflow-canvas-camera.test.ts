import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  OVERVIEW_MAX_ZOOM,
  READABLE_FOCUS_ZOOM,
  READABLE_MIN_ZOOM,
  TOPOLOGY_MAX_ZOOM,
  canShowCanvasInlineActions,
  canvasEdgeFocusPoint,
  canvasFocusPointWithRightOcclusion,
  canvasNodeFocusPoint,
  chooseCanvasFocalNode,
  planInitialCanvasCamera,
  resolveCanvasZoomBand,
} from '../src/components/canvas/canvasCamera'

describe('RFC-250 canvas camera planner', () => {
  test('fits all only when the computed fit remains readable', () => {
    expect(
      planInitialCanvasCamera({
        allNodesFitZoom: READABLE_MIN_ZOOM,
        nodeIds: ['entry', 'later'],
        entryNodeIds: ['entry'],
      }),
    ).toMatchObject({ kind: 'fit-all', mode: 'readable-focus' })

    expect(
      planInitialCanvasCamera({
        allNodesFitZoom: READABLE_MIN_ZOOM - 0.001,
        nodeIds: ['entry', 'later'],
        entryNodeIds: ['entry'],
      }),
    ).toEqual({
      kind: 'focus-node',
      mode: 'readable-focus',
      nodeId: 'entry',
      zoom: READABLE_FOCUS_ZOOM,
    })
  })

  test('focus priority is recent selection, then entry, then stable first node', () => {
    expect(chooseCanvasFocalNode(['first', 'entry', 'recent'], ['entry'], 'recent')).toBe('recent')
    expect(chooseCanvasFocalNode(['first', 'entry'], ['missing', 'entry'], 'missing')).toBe('entry')
    expect(chooseCanvasFocalNode(['first', 'second'], [], undefined)).toBe('first')
    expect(chooseCanvasFocalNode([], [], undefined)).toBeNull()
  })

  test('zoom bands change only at the locked topology/readability boundaries', () => {
    expect(resolveCanvasZoomBand(TOPOLOGY_MAX_ZOOM - 0.001)).toBe('topology')
    expect(resolveCanvasZoomBand(TOPOLOGY_MAX_ZOOM)).toBe('overview')
    expect(resolveCanvasZoomBand(READABLE_MIN_ZOOM - 0.001)).toBe('overview')
    expect(resolveCanvasZoomBand(READABLE_MIN_ZOOM)).toBe('readable')
    expect(OVERVIEW_MAX_ZOOM).toBeLessThan(READABLE_MIN_ZOOM)
  })
})

describe('RFC-250 focus geometry and inline action targets', () => {
  test('normal nodes focus their center while wrappers focus the header', () => {
    expect(
      canvasNodeFocusPoint({ x: 10, y: 20, width: 200, height: 120, kind: 'agent-single' }),
    ).toEqual({ x: 110, y: 80 })
    expect(
      canvasNodeFocusPoint({ x: 10, y: 20, width: 600, height: 900, kind: 'wrapper-loop' }),
    ).toEqual({ x: 310, y: 56 })
  })

  test('edges focus the exact midpoint between endpoint focus points', () => {
    expect(canvasEdgeFocusPoint({ x: 20, y: 40 }, { x: 220, y: 140 })).toEqual({
      x: 120,
      y: 90,
    })
  })

  test('a compact right-side Inspector focuses inside the remaining visible canvas strip', () => {
    expect(
      canvasFocusPointWithRightOcclusion(
        { x: 100, y: 60 },
        1.15,
        { left: 240, right: 1140 },
        { left: 720, right: 1179 },
      ),
    ).toEqual({ x: 100 + 420 / (2 * 1.15), y: 60 })
    expect(
      canvasFocusPointWithRightOcclusion(
        { x: 100, y: 60 },
        1.15,
        { left: 240, right: 1140 },
        { left: 0, right: 1179 },
      ),
    ).toEqual({ x: 100, y: 60 })
  })

  test('inline controls leave the DOM before their screen-space targets become undersized', () => {
    expect(canShowCanvasInlineActions(24 / 26, false)).toBe(true)
    expect(canShowCanvasInlineActions(24 / 26 - 0.001, false)).toBe(false)
    expect(canShowCanvasInlineActions(1, true)).toBe(true)
    expect(canShowCanvasInlineActions(0.999, true)).toBe(false)
    expect(canShowCanvasInlineActions(OVERVIEW_MAX_ZOOM, false)).toBe(false)
  })
})

describe('WorkflowCanvas camera integration backstop', () => {
  const src = readFileSync(
    resolve(import.meta.dirname, '..', 'src', 'components', 'canvas', 'WorkflowCanvas.tsx'),
    'utf8',
  )
  const css = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf8')
  const route = readFileSync(
    resolve(import.meta.dirname, '..', 'src', 'routes', 'workflows.edit.tsx'),
    'utf8',
  )

  test('editable initial camera is authoritative-owner-keyed and ReactFlow fitView stays on read-only surfaces', () => {
    expect(src).toContain("workflowId ?? '__local-editor__'")
    expect(src).toContain('authoritativeLoadEpoch ?? 0')
    expect(src).toContain('initialCameraOwnerRef.current === owner')
    expect(src).toContain('fitView={!editableEditor}')
    expect(route).toContain('const confirmed = await controller.confirmLoadRemote()')
    expect(route).toContain('if (confirmed) setAuthoritativeLoadEpoch')
    expect(route).toContain('onLoadRemote={confirmAuthoritativeRemoteLoad}')
    expect(route).toContain('authoritativeLoadEpoch={authoritativeLoadEpoch}')
  })

  test('imperative issue jumps and overview clicks share readable-focus selection geometry', () => {
    expect(src).toMatch(/focusSelection:[\s\S]{0,900}focusSelectionAfterLayout\(nextSelection\)/)
    expect(src).toMatch(
      /activateOverviewSelection[\s\S]{0,1100}focusSelectionAfterLayout\(target\)/,
    )
    expect(src).toContain("cameraMode === 'overview'")
    expect(src).toContain('zoom: READABLE_FOCUS_ZOOM')
    expect(READABLE_FOCUS_ZOOM).toBeGreaterThanOrEqual(READABLE_MIN_ZOOM)
  })

  test('explicit node and edge selection waits for Inspector layout without becoming resize-owned', () => {
    const scheduler = src.match(
      /const focusSelectionAfterLayout = useCallback\([\s\S]+?const fallbackReadableNodeId/,
    )?.[0]
    expect(scheduler).toBeDefined()
    expect(scheduler).toMatch(
      /requestAnimationFrame\(\(\) => \{[\s\S]+requestAnimationFrame\(\(\) => \{[\s\S]+focusCanvasSelection\(target\)/,
    )
    expect(scheduler).not.toContain('ResizeObserver')
    expect(src).toContain('canvasFocusPointWithRightOcclusion(')
    expect(route).toContain('workflow-editor-inspector-surface-dialog')
    expect(src).toMatch(/onNodeClick={[\s\S]{0,1400}focusSelectionAfterLayout\(target\)/)
    expect(src).toMatch(/onEdgeClick={[\s\S]{0,1400}focusSelectionAfterLayout\(target\)/)
    expect(src).toMatch(
      /focusSelection: \(nextSelection\)[\s\S]{0,700}focusSelectionAfterLayout\(nextSelection\)/,
    )
    expect(src).toMatch(
      /onMoveStart={[\s\S]{0,240}cancelPendingSelectionFocus\(\)[\s\S]{0,180}settleCanvasRefit/,
    )
  })

  test('zoom ticks update React state only when a band or visibility threshold changes', () => {
    expect(src).toMatch(/nextBand !== zoomBandRef\.current[\s\S]{0,120}setZoomBand/)
    expect(src).toMatch(
      /nextInlineVisibility !== inlineActionsVisibleRef\.current[\s\S]{0,160}setInlineActionsVisible/,
    )
  })

  test('semantic zoom keeps node content visible and coarse-pointer actions have 44px boxes', () => {
    expect(css).not.toMatch(
      /data-zoom-band='topology'\]\s+\.canvas-node\s*>\s*:not\(\.canvas-node__validation\)/,
    )
    expect(css).not.toMatch(
      /data-zoom-band='overview'\][\s\S]{0,800}\.canvas-node__port-label[\s\S]{0,300}visibility:\s*hidden/,
    )
    expect(css).toMatch(
      /@media \(pointer: coarse\), \(max-width: 520px\)[\s\S]{0,220}\.workflow-edge-insert[\s\S]{0,100}width: 44px;[\s\S]{0,80}height: 44px/,
    )
    expect(css).toMatch(
      /@media \(pointer: coarse\), \(max-width: 520px\)[\s\S]{0,8000}\.canvas-node__add-inside[\s\S]{0,100}min-width: 44px;[\s\S]{0,80}min-height: 44px/,
    )
    expect(css).toMatch(
      /workflow-canvas__layout-panel \.btn,[\s\S]{0,160}workflow-canvas__node-actions \.btn[\s\S]{0,100}min-width: 44px;[\s\S]{0,80}min-height: 44px/,
    )
    expect(css).toMatch(
      /workflow-canvas\[data-surface='editor'\] \.react-flow__controls-button[\s\S]{0,100}width: 44px;[\s\S]{0,80}height: 44px/,
    )
  })

  test('low zoom projects selection and validation markers back to an 8px screen-space floor', () => {
    expect(src).toContain("'--workflow-canvas-inverse-zoom'")
    expect(css).toContain('--workflow-canvas-marker-scale')
    expect(css).toMatch(
      /\.canvas-node--selected::after[\s\S]{0,500}width: calc\(8px \* var\(--workflow-canvas-marker-scale\)\);[\s\S]{0,100}height: calc\(8px \* var\(--workflow-canvas-marker-scale\)\);/,
    )
    expect(css).toMatch(
      /\.canvas-node__validation[\s\S]{0,180}transform: scale\(var\(--workflow-canvas-marker-scale\)\)/,
    )
    expect(css).toMatch(
      /\.react-flow__edge\.selected[\s\S]{0,1000}stroke-width: calc\(8px \* var\(--workflow-canvas-marker-scale\)\)/,
    )
  })
})
