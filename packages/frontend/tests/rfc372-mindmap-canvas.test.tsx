// RFC-372: exercise actual canvas handlers; a double click never zooms and pinch can continue as pan.
import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MindmapNodeSummary } from '../src/lib/clarify/mindmap/projection'
import { MindmapCanvas } from '../src/components/clarify/mindmap/MindmapCanvas'
import { layoutMindmap, type MindmapTopologyNode } from '../src/lib/clarify/mindmap/layout'
import type { MindmapCamera } from '../src/lib/clarify/mindmap/geometry'
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
const changed = vi.fn(),
  selected = vi.fn()
function Harness() {
  const [camera, setCamera] = useState<MindmapCamera>({ x: 400, y: 300, zoom: 0.8 })
  return (
    <MindmapCanvas
      rootId="root"
      topologyRevision={1}
      nodes={nodes}
      selectedId="root"
      camera={camera}
      onCameraChange={(value) => {
        changed(value)
        setCamera(value)
      }}
      onSelect={selected}
      onFocusView={() => {}}
      highlightPending={false}
      revealRequest={null}
      onRevealHandled={() => {}}
    />
  )
}
beforeEach(() => {
  changed.mockClear()
  selected.mockClear()
  vi.stubGlobal(
    'Worker',
    class {
      onmessage: ((event: { data: unknown }) => void) | null = null
      postMessage(value: { revision: number; nodes: MindmapTopologyNode[]; rootId: string }) {
        queueMicrotask(() =>
          this.onmessage?.({
            data: { revision: value.revision, layout: layoutMindmap(value.nodes, value.rootId) },
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
        this.callback([{ contentRect: { width: 800, height: 600 } }])
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
async function canvas() {
  render(<Harness />)
  await waitFor(() => expect(screen.getByRole('button', { name: /Fit all|适应全图/ })).toBeTruthy())
  const surface = screen.getByRole('img') as HTMLCanvasElement
  Object.defineProperties(surface, {
    setPointerCapture: { value: vi.fn() },
    hasPointerCapture: { value: () => true },
    releasePointerCapture: { value: vi.fn() },
  })
  // Worker delivery and drawing complete before the event sequence starts.
  await waitFor(() => expect(screen.queryByText(/Loading|加载中/)).toBeNull())
  changed.mockClear()
  return surface
}
describe('RFC-372 canvas event behavior', () => {
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
