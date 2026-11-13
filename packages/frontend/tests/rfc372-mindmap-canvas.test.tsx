// RFC-372: exercise actual canvas handlers; a double click never zooms and pinch can continue as pan.
//
// RFC-490 (design §4.2, §5.1, §5.5) adds the wiring this file's second half covers:
// the canvas takes its column count from the workspace and hands it to the layout
// worker; it keeps its place when the question panel opens beside it and narrows it
// (the pure rule is in rfc490-mindmap-layout.test.ts, here it is the resize callback
// that applies it); and it exposes what it laid out as read-only attributes.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MindmapNodeSummary } from '../src/lib/clarify/mindmap/projection'
import { MindmapCanvas } from '../src/components/clarify/mindmap/MindmapCanvas'
import {
  MINDMAP_CARD_WIDTH,
  MINDMAP_COLUMN_GAP,
  MINDMAP_GROUP_HEIGHT,
  MINDMAP_LEVEL_GAP,
  MINDMAP_QUESTION_HEIGHT,
  layoutMindmap,
  type MindmapTopologyNode,
} from '../src/lib/clarify/mindmap/layout'
import {
  MINDMAP_PANEL_MARGIN,
  worldToScreen,
  type MindmapCamera,
} from '../src/lib/clarify/mindmap/geometry'
import { drawMindmap } from '../src/lib/clarify/mindmap/draw'
import type * as MindmapDrawing from '../src/lib/clarify/mindmap/draw'

vi.mock('../src/lib/clarify/mindmap/draw', async (original) => ({
  ...(await original<typeof MindmapDrawing>()),
  drawMindmap: vi.fn(() => ({
    hits: [{ id: 'child', left: 40, right: 80, top: 40, bottom: 80 }],
    visible: 2,
  })),
}))
const counts = {
  done: 0,
  needs_detail: 1,
  needs_confirmation: 0,
}
const nodes: MindmapNodeSummary[] = ['root', 'child'].map((id, index) => ({
  id,
  parentId: index ? 'root' : null,
  order: index,
  kind: 'group',
  title: id,
  status: 'needs_detail',
  counts,
}))
// RFC-490: a root with three question cards, which fit one row at three columns.
const cards: MindmapNodeSummary[] = [
  nodes[0]!,
  ...['left', 'middle', 'right'].map(
    (id, index): MindmapNodeSummary => ({
      id,
      parentId: 'root',
      order: index + 1,
      kind: 'question',
      title: id,
      status: 'needs_detail',
      counts,
    }),
  ),
]
const topology = (items: readonly MindmapNodeSummary[]): MindmapTopologyNode[] =>
  items.map(({ id, parentId, order, kind }) => ({ id, parentId, order, kind }))
interface LayoutRequest {
  revision: string | number
  rootId: string
  nodes: MindmapTopologyNode[]
  columns?: number
}
const changed = vi.fn(),
  selected = vi.fn()
/** Everything the canvas asked the layout worker for, in order. */
const posted: LayoutRequest[] = []
/** Reports a new canvas size, as the browser's ResizeObserver would. */
let resizeCanvas: (width: number, height: number) => void = () => {}
interface HarnessProps {
  columns?: number
  panelOpen?: boolean
  /** An explicit "show me this node" request, as search or "next pending" sends. */
  reveal?: { id: string; sequence: number } | null
  selectedId?: string
  items?: MindmapNodeSummary[]
  /** Only read on mount: the camera is the harness's own state afterwards. */
  initial?: MindmapCamera
}
function Harness({
  columns = 3,
  panelOpen,
  reveal = null,
  selectedId = 'root',
  items = nodes,
  initial = { x: 400, y: 300, zoom: 0.8 },
}: HarnessProps) {
  const [camera, setCamera] = useState<MindmapCamera>(initial)
  return (
    <MindmapCanvas
      rootId="root"
      topologyRevision={1}
      columns={columns}
      panelOpen={panelOpen}
      nodes={items}
      selectedId={selectedId}
      camera={camera}
      onCameraChange={(value) => {
        changed(value)
        setCamera(value)
      }}
      onSelect={selected}
      onFocusView={() => {}}
      highlightPending={false}
      revealRequest={reveal}
      onRevealHandled={() => {}}
    />
  )
}
beforeEach(() => {
  changed.mockClear()
  selected.mockClear()
  vi.mocked(drawMindmap).mockClear()
  posted.length = 0
  resizeCanvas = () => {}
  vi.stubGlobal(
    'Worker',
    class {
      onmessage: ((event: { data: unknown }) => void) | null = null
      postMessage(value: LayoutRequest) {
        posted.push(value)
        queueMicrotask(() =>
          this.onmessage?.({
            data: {
              revision: value.revision,
              // Like the real worker: the column count comes with the request.
              layout: layoutMindmap(value.nodes, value.rootId, value.columns),
            },
          }),
        )
      }
      terminate() {}
    },
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(
        private callback: (
          entries: Array<{ contentRect: { width: number; height: number } }>,
        ) => void,
      ) {}
      observe() {
        resizeCanvas = (width, height) => this.callback([{ contentRect: { width, height } }])
        resizeCanvas(800, 600)
      }
      disconnect() {}
    },
  )
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const context = new Proxy({}, { get: () => () => {} }) as CanvasRenderingContext2D
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
/** Mounts the canvas and waits until its first layout is on screen. */
async function mount(props: HarnessProps = {}) {
  const view = render(<Harness {...props} />)
  await waitFor(() => expect(screen.getByRole('button', { name: /Fit all|适应全图/ })).toBeTruthy())
  const surface = screen.getByRole('img') as HTMLCanvasElement
  Object.defineProperties(surface, {
    setPointerCapture: { value: vi.fn() },
    hasPointerCapture: { value: () => true },
    releasePointerCapture: { value: vi.fn() },
  })
  // Worker delivery and drawing complete before the event sequence starts.
  await waitFor(() => expect(screen.queryByText(/Loading|加载中/)).toBeNull())
  const root = view.container.querySelector<HTMLElement>('.mindmap-canvas')!
  await waitFor(() => expect(root.hasAttribute('data-world-width')).toBe(true))
  changed.mockClear()
  return { view, surface, root }
}
const canvas = async () => (await mount()).surface

describe('RFC-372 canvas event behavior', () => {
  // RFC-372 review follow-up O7: touch devices see touch instructions and a narrow
  // canvas keeps its nodes visible instead of covering them with the minimap.
  it('renders pointer and touch help variants; CSS shows one per input type and hides the narrow minimap', async () => {
    await canvas()
    const help = document.getElementById('mindmap-canvas-help')!
    const pointer = help.querySelector('.mindmap-canvas__help-pointer')
    const touch = help.querySelector('.mindmap-canvas__help-touch')
    expect(pointer?.textContent).toMatch(/Ctrl\/⌘/)
    expect(touch?.textContent).toMatch(/Pinch|双指/)
    const css = readFileSync(
      resolve(import.meta.dirname, '..', 'src/components/clarify/mindmap/mindmap.css'),
      'utf8',
    ).replace(/\s+/g, ' ')
    expect(css).toContain('.mindmap-canvas__help-touch { display: none; }')
    expect(css).toMatch(
      /@media \(pointer: coarse\) \{ \.mindmap-canvas__help-pointer \{ display: none; \} \.mindmap-canvas__help-touch \{ display: inline; \} \}/,
    )
    expect(css).toMatch(
      /@container mindmap-stage \(max-width: 480px\) \{ \.mindmap-canvas__minimap \{ display: none; \} \}/,
    )
  })
  it('selects on a click without changing the camera; double click has no zoom behavior', async () => {
    const surface = await canvas()
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 60, clientY: 60 })
    fireEvent.pointerUp(surface, { pointerId: 1, button: 0, clientX: 60, clientY: 60 })
    fireEvent.doubleClick(surface, { clientX: 60, clientY: 60 })
    expect(selected).toHaveBeenCalledWith('child')
    expect(changed).not.toHaveBeenCalled()
  })
  it('does not turn a drag on a node into a selection', async () => {
    const surface = await canvas()
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 60, clientY: 60 })
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 130, clientY: 130 })
    fireEvent.pointerUp(surface, { pointerId: 1, button: 0, clientX: 130, clientY: 130 })
    expect(selected).not.toHaveBeenCalled()
  })
  it('continues panning with the remaining finger after a pinch without selecting anything', async () => {
    const surface = await canvas()
    fireEvent.pointerDown(surface, {
      pointerId: 1,
      pointerType: 'touch',
      button: 0,
      clientX: 100,
      clientY: 100,
    })
    fireEvent.pointerDown(surface, {
      pointerId: 2,
      pointerType: 'touch',
      button: 0,
      clientX: 200,
      clientY: 100,
    })
    fireEvent.pointerMove(surface, {
      pointerId: 2,
      pointerType: 'touch',
      clientX: 300,
      clientY: 100,
    })
    const pinched = changed.mock.lastCall?.[0] as MindmapCamera
    expect(pinched.zoom).toBeGreaterThan(0.8)
    fireEvent.pointerUp(surface, {
      pointerId: 2,
      pointerType: 'touch',
      button: 0,
      clientX: 300,
      clientY: 100,
    })
    fireEvent.lostPointerCapture(surface, { pointerId: 2 })
    fireEvent.pointerMove(surface, {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 120,
      clientY: 130,
    })
    const panned = changed.mock.lastCall?.[0] as MindmapCamera
    expect(panned).toEqual({ x: pinched.x + 20, y: pinched.y + 30, zoom: pinched.zoom })
    fireEvent.pointerUp(surface, {
      pointerId: 1,
      pointerType: 'touch',
      button: 0,
      clientX: 120,
      clientY: 130,
    })
    expect(selected).not.toHaveBeenCalled()
  })
})

describe('RFC-490 canvas columns and observable layout (design §5.1, §5.5)', () => {
  const VIEW: MindmapCamera = { x: 400, y: 60, zoom: 0.85 }

  it('hands the column count to the layout worker and asks again only when it changes', async () => {
    const { view, root } = await mount({ items: cards, selectedId: 'middle', initial: VIEW })
    expect(posted).toEqual([{ revision: 1, rootId: 'root', nodes: topology(cards), columns: 3 }])
    // Answering and confirming change what a card says, never where it is (RFC-372 L14).
    const answered = cards.map((node) => ({ ...node, status: 'done' as const }))
    view.rerender(<Harness items={answered} selectedId="middle" />)
    expect(posted).toHaveLength(1)
    expect(changed).not.toHaveBeenCalled()
    // A narrower stage means fewer columns: one more request, for the same topology.
    view.rerender(<Harness items={answered} selectedId="middle" columns={1} />)
    expect(posted).toHaveLength(2)
    expect(posted[1]).toEqual({ revision: 1, rootId: 'root', nodes: topology(cards), columns: 1 })
    expect(root.getAttribute('data-columns')).toBe('1')
    const before = layoutMindmap(topology(cards), 'root', 3)
    const after = layoutMindmap(topology(cards), 'root', 1)
    const width = (layout: typeof after) => Math.round(layout.bounds.right - layout.bounds.left)
    expect(width(after)).toBeLessThan(width(before))
    await waitFor(() => expect(root.getAttribute('data-world-width')).toBe(String(width(after))))
    // The map rearranged around the selected card: it is where it was on screen.
    expect(changed).toHaveBeenCalledTimes(1)
    const moved = changed.mock.lastCall![0] as MindmapCamera
    const was = worldToScreen(before.nodes.find((node) => node.id === 'middle')!, VIEW)
    const now = worldToScreen(after.nodes.find((node) => node.id === 'middle')!, moved)
    expect(now.x).toBeCloseTo(was.x, 6)
    expect(now.y).toBeCloseTo(was.y, 6)
    expect(moved.zoom).toBe(VIEW.zoom)
  })

  it('the layout worker lays the map out with the column count it was sent', async () => {
    // The worker module talks to `self`; a stand-in receives what it posts.
    const worker = {
      onmessage: null as ((event: { data: LayoutRequest }) => void) | null,
      postMessage: vi.fn(),
    }
    vi.stubGlobal('self', worker)
    await import('../src/lib/clarify/mindmap/layout.worker')
    expect(worker.onmessage).toBeTypeOf('function')
    const request = { revision: 7, rootId: 'root', nodes: topology(cards) }
    for (const columns of [3, 1]) {
      worker.onmessage!({ data: { ...request, columns } })
      expect(worker.postMessage).toHaveBeenLastCalledWith({
        revision: 7,
        layout: layoutMindmap(topology(cards), 'root', columns),
      })
    }
    // One column wraps the three cards into three rows; three columns need no rail.
    const [wide, narrow] = worker.postMessage.mock.calls.map(
      (call) => (call[0] as { layout: ReturnType<typeof layoutMindmap> }).layout,
    )
    expect(wide!.blocks).toEqual([])
    expect(narrow!.blocks[0]!.rows).toHaveLength(3)
    // A request from before the column count existed lays out with the default.
    worker.onmessage!({ data: request })
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      revision: 7,
      layout: layoutMindmap(topology(cards), 'root'),
    })
    // A topology that cannot be laid out is reported, not thrown.
    worker.onmessage!({ data: { ...request, revision: 8, rootId: 'missing', columns: 3 } })
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      revision: 8,
      error: 'mindmap-topology-invalid',
    })
  })

  it('exposes its columns, the laid-out size and the camera as read-only attributes', async () => {
    const view = render(
      <Harness
        items={cards}
        selectedId="middle"
        initial={{ x: 303.66, y: 59.94, zoom: 0.84961 }}
      />,
    )
    const root = view.container.querySelector<HTMLElement>('.mindmap-canvas')!
    expect(root.getAttribute('data-columns')).toBe('3')
    // One decimal for the offsets, three for the zoom.
    expect(root.getAttribute('data-camera')).toBe('303.7,59.9,0.85')
    // Nothing is laid out yet, so there is no size to report.
    expect(root.hasAttribute('data-world-width')).toBe(false)
    expect(root.hasAttribute('data-world-height')).toBe(false)
    await waitFor(() => expect(root.hasAttribute('data-world-width')).toBe(true))
    // Three cards in one row under the root.
    expect(root.getAttribute('data-world-width')).toBe(
      String(3 * MINDMAP_CARD_WIDTH + 2 * MINDMAP_COLUMN_GAP),
    )
    expect(root.getAttribute('data-world-height')).toBe(
      String(MINDMAP_GROUP_HEIGHT + MINDMAP_LEVEL_GAP + MINDMAP_QUESTION_HEIGHT),
    )
    // The camera attribute follows the camera.
    fireEvent.keyDown(screen.getByRole('img'), { key: 'ArrowLeft' })
    expect(root.getAttribute('data-camera')).toBe('363.7,59.9,0.85')
  })

  it('draws with the labels for skipped answers and for categories without questions', async () => {
    await mount({ items: cards, initial: VIEW })
    await waitFor(() => expect(drawMindmap).toHaveBeenCalled())
    const labels = vi.mocked(drawMindmap).mock.lastCall![0].labels!
    expect(labels.decision).toEqual({
      decided: 'Decided',
      provisional: 'Provisional',
      deferred: 'Decide later',
      'not-applicable': 'Not applicable',
      unmarked: 'Unmarked',
    })
    expect(labels.empty).toBe('No questions yet')
  })

  it('names a category without questions as such on hover, not as confirmed', async () => {
    // The mocked drawing reports "child" under the pointer at (60, 60).
    const empty = nodes.map((node) =>
      node.id === 'child'
        ? { ...node, status: 'done' as const, counts: { ...counts, needs_detail: 0 }, empty: true }
        : node,
    )
    const { surface } = await mount({ items: empty })
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 60, clientY: 60 })
    expect(surface.title).toMatch(/^child · (No questions yet|尚无问题)$/)
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 300, clientY: 300 })
    expect(surface.title).toBe('')
  })

  it('keeps the minimap container query on the canvas cell, which the panel narrows', () => {
    const css = readFileSync(
      resolve(import.meta.dirname, '..', 'src/components/clarify/mindmap/mindmap.css'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '')
    /** Bodies of the rules whose selector list contains `selector`. */
    const rules = (selector: string) =>
      [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter((match) =>
          match[1]!
            .split(',')
            .map((part) => part.trim())
            .includes(selector),
        )
        .map((match) => match[2]!)
    // The cell the canvas sits in is the container: its width is the canvas's width.
    expect(rules('.mindmap-workspace__map').join('\n')).toMatch(
      /container:\s*mindmap-stage\s*\/\s*inline-size/,
    )
    // The stage also holds the panel, so a query on it would miss a narrowed canvas.
    expect(rules('.mindmap-workspace__stage').length).toBeGreaterThan(0)
    expect(rules('.mindmap-workspace__stage').join('\n')).not.toMatch(/container/)
  })
})

describe('RFC-490 the question panel narrows the canvas without moving the map (design §4.2)', () => {
  const VIEW: MindmapCamera = { x: 400, y: 60, zoom: 0.85 }
  // The canvas is 800 wide. At VIEW the three cards span 71.9..272.5 (left),
  // 299.7..500.3 (middle) and 527.5..728.1 (right); the panel leaves 420.
  const NARROW = 420
  const card = (id: string) =>
    layoutMindmap(topology(cards), 'root', 3).nodes.find((node) => node.id === id)!
  const rightEdge = (id: string, camera: MindmapCamera) =>
    (card(id).x + card(id).width / 2) * camera.zoom + camera.x

  it('leaves the camera alone when the picked card still fits beside the panel', async () => {
    const { view, root } = await mount({ items: cards, selectedId: 'left', initial: VIEW })
    expect(rightEdge('left', VIEW)).toBeLessThan(NARROW - MINDMAP_PANEL_MARGIN)
    view.rerender(<Harness items={cards} selectedId="left" panelOpen />)
    act(() => resizeCanvas(NARROW, 600))
    expect(changed).not.toHaveBeenCalled()
    // Picking another card with the panel open does not pan either, not even one
    // the panel has just covered.
    expect(rightEdge('right', VIEW)).toBeGreaterThan(NARROW)
    view.rerender(<Harness items={cards} selectedId="right" panelOpen />)
    expect(changed).not.toHaveBeenCalled()
    // Closing gives the width back. Nothing was moved, so nothing is taken back.
    view.rerender(<Harness items={cards} selectedId="right" />)
    act(() => resizeCanvas(800, 600))
    expect(changed).not.toHaveBeenCalled()
    expect(root.getAttribute('data-camera')).toBe('400,60,0.85')
  })

  it('pans just far enough when the panel would cover the picked card, and takes it back on close', async () => {
    const { view, root } = await mount({ items: cards, selectedId: 'middle', initial: VIEW })
    expect(rightEdge('middle', VIEW)).toBeGreaterThan(NARROW - MINDMAP_PANEL_MARGIN)
    view.rerender(<Harness items={cards} selectedId="middle" panelOpen />)
    act(() => resizeCanvas(NARROW, 600))
    expect(changed).toHaveBeenCalledTimes(1)
    const nudged = changed.mock.lastCall![0] as MindmapCamera
    // A horizontal pan only, and no further than the margin beside the panel.
    expect(nudged.zoom).toBe(VIEW.zoom)
    expect(nudged.y).toBe(VIEW.y)
    expect(nudged.x).toBeLessThan(VIEW.x)
    expect(rightEdge('middle', nudged)).toBeCloseTo(NARROW - MINDMAP_PANEL_MARGIN, 6)
    // Closing puts the map back exactly where it was.
    view.rerender(<Harness items={cards} selectedId="middle" />)
    act(() => resizeCanvas(800, 600))
    expect(changed).toHaveBeenCalledTimes(2)
    expect(changed.mock.lastCall![0]).toEqual(VIEW)
    expect(root.getAttribute('data-camera')).toBe('400,60,0.85')
  })

  it('a node located in the same turn the panel opens ends up beside the panel, not under it', async () => {
    // "Next pending" from the toolbar selects, locates and opens at once. The locate
    // centres the card in the still-wide canvas; the panel then takes that half.
    const FAR: MindmapCamera = { x: -900, y: 60, zoom: 0.85 }
    const { view } = await mount({ items: cards, selectedId: 'left', initial: FAR })
    expect(rightEdge('right', FAR)).toBeLessThan(0)
    view.rerender(
      <Harness items={cards} selectedId="right" panelOpen reveal={{ id: 'right', sequence: 1 }} />,
    )
    act(() => resizeCanvas(NARROW, 600))
    const settled = changed.mock.lastCall![0] as MindmapCamera
    const left = (card('right').x - card('right').width / 2) * settled.zoom + settled.x
    expect(left).toBeGreaterThanOrEqual(0)
    expect(rightEdge('right', settled)).toBeLessThanOrEqual(NARROW - MINDMAP_PANEL_MARGIN + 1e-6)
  })

  it('returns to the view from before the panel after nodes were located while it was open', async () => {
    // "Confirm and next" locates the next card in the narrow canvas. Closing must not
    // leave the map where that put it, off to one side of the full canvas.
    const { view, root } = await mount({ items: cards, selectedId: 'left', initial: VIEW })
    view.rerender(<Harness items={cards} selectedId="left" panelOpen />)
    act(() => resizeCanvas(NARROW, 600))
    view.rerender(
      <Harness items={cards} selectedId="right" panelOpen reveal={{ id: 'right', sequence: 2 }} />,
    )
    const located = changed.mock.lastCall![0] as MindmapCamera
    expect(located.x).not.toBe(VIEW.x)
    view.rerender(<Harness items={cards} selectedId="right" />)
    act(() => resizeCanvas(800, 600))
    // "right" is in view at full width from where the map was, so that is where it is.
    expect(changed.mock.lastCall![0]).toEqual(VIEW)
    expect(root.getAttribute('data-camera')).toBe('400,60,0.85')
  })

  it('keeps the position the reader chose while the panel was open', async () => {
    const { view, surface } = await mount({ items: cards, selectedId: 'middle', initial: VIEW })
    view.rerender(<Harness items={cards} selectedId="middle" panelOpen />)
    act(() => resizeCanvas(NARROW, 600))
    const nudged = changed.mock.lastCall![0] as MindmapCamera
    // They pan the map themselves; that position is theirs to keep.
    fireEvent.keyDown(surface, { key: 'ArrowDown' })
    expect(changed.mock.lastCall![0]).toEqual({ ...nudged, y: nudged.y - 60 })
    changed.mockClear()
    view.rerender(<Harness items={cards} selectedId="middle" />)
    act(() => resizeCanvas(800, 600))
    expect(changed).not.toHaveBeenCalled()
  })

  it('keeps the visible centre on every other resize, whether the panel is open or not', async () => {
    const { view } = await mount({ items: cards, selectedId: 'left', initial: VIEW })
    // The window (or the outline) resized the canvas: the RFC-372 rule.
    act(() => resizeCanvas(600, 500))
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed.mock.lastCall![0]).toEqual({ x: 300, y: 10, zoom: VIEW.zoom })
    // The panel opening is the one resize that does not recentre …
    view.rerender(<Harness items={cards} selectedId="left" panelOpen />)
    act(() => resizeCanvas(360, 500))
    expect(changed).toHaveBeenCalledTimes(1)
    // … and once it is open, later resizes recentre again.
    act(() => resizeCanvas(400, 520))
    expect(changed).toHaveBeenCalledTimes(2)
    expect(changed.mock.lastCall![0]).toEqual({ x: 320, y: 20, zoom: VIEW.zoom })
  })

  it('never moves the camera for a selection alone', async () => {
    const { view } = await mount({ items: cards, selectedId: 'left', initial: VIEW })
    for (const id of ['right', 'root', 'middle']) {
      view.rerender(<Harness items={cards} selectedId={id} />)
      expect(changed).not.toHaveBeenCalled()
    }
    // Nor does it lay the map out again.
    expect(posted).toHaveLength(1)
  })
})
