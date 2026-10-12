import { describe, expect, it } from 'vitest'
import {
  fitMindmap,
  moveMindmapGesture,
  preserveMindmapAnchor,
  resizeMindmapCamera,
  revealMindmapPoint,
  screenToWorld,
  worldToScreen,
  zoomMindmapAt,
} from '@/lib/clarify/mindmap/geometry'
import { indexMindmapLayout, layoutMindmap } from '@/lib/clarify/mindmap/layout'
import { drawMindmap } from '@/lib/clarify/mindmap/draw'
import type { MindmapNodeSummary } from '@/lib/clarify/mindmap/projection'
describe('RFC-372 canvas geometry', () => {
  it('keeps every label on a small overview when neighboring labels fit without overlapping', () => {
    const nodes: MindmapNodeSummary[] = [
      'root',
      'category',
      'database',
      'languages',
      'consistency',
    ].map((id, i) => ({
      id,
      parentId: i === 0 ? null : i === 1 ? 'root' : i === 4 ? 'database' : 'category',
      order: i,
      title: `Question about ${id}`,
      kind: 'group',
      status: 'needs_detail',
      counts: { done: 0, needs_confirmation: 0, needs_detail: 1 },
    }))
    const labels: string[] = []
    const ctx = new Proxy(
      {},
      {
        get: (_target, name) =>
          name === 'measureText'
            ? (text: string) => ({ width: text.length * 6 })
            : name === 'fillText'
              ? (text: string) => labels.push(text)
              : () => {},
      },
    ) as CanvasRenderingContext2D
    const layout = layoutMindmap(nodes, 'root')
    const viewport = { width: 800, height: 600 }
    drawMindmap({
      ctx,
      viewport,
      camera: fitMindmap(layout.bounds, viewport),
      layout,
      index: indexMindmapLayout(layout),
      positions: new Map(layout.nodes.map((n) => [n.id, n])),
      nodes: new Map(nodes.map((n) => [n.id, n])),
      selectedId: 'root',
      highlightPending: false,
      palette: {
        background: '',
        surface: '',
        text: '',
        muted: '',
        border: '',
        accent: '',
        status: { done: '', needs_confirmation: '', needs_detail: '' },
      },
    })
    expect(labels).toHaveLength(nodes.length)
  })
  it('zooms at the pointer without moving its world point, including the zoom limits', () => {
    const camera = { x: 120, y: -70, zoom: 0.4 },
      pointer = { x: 371, y: 289 }
    const world = screenToWorld(pointer, camera)
    for (const factor of [0.01, 0.8, 1.2, 100]) {
      const next = zoomMindmapAt(camera, pointer, factor, 0.02)
      expect(next.zoom).toBeGreaterThanOrEqual(0.02)
      expect(next.zoom).toBeLessThanOrEqual(2.5)
      expect(worldToScreen(world, next).x).toBeCloseTo(pointer.x)
      expect(worldToScreen(world, next).y).toBeCloseTo(pointer.y)
    }
  })
  it('reveals offscreen search results by panning only and leaves visible results alone', () => {
    const camera = { x: 300, y: 200, zoom: 0.7 },
      viewport = { width: 800, height: 600 }
    expect(revealMindmapPoint(camera, { x: 0, y: 0 }, viewport)).toBe(camera)
    const next = revealMindmapPoint(camera, { x: 10000, y: -2000 }, viewport)
    expect(next.zoom).toBe(camera.zoom)
    expect(worldToScreen({ x: 10000, y: -2000 }, next)).toEqual({ x: 400, y: 300 })
  })
  it('distinguishes click jitter from drag and never reverts a drag to a click', () => {
    const start = {
      pointerId: 1,
      origin: { x: 10, y: 10 },
      last: { x: 10, y: 10 },
      nodeId: null,
      pan: true,
      dragged: false,
    }
    const jitter = moveMindmapGesture(start, { x: 12, y: 12 })
    expect(jitter.gesture.dragged).toBe(false)
    expect(jitter.delta).toEqual({ x: 0, y: 0 })
    const dragged = moveMindmapGesture(jitter.gesture, { x: 42, y: 40 })
    expect(dragged.gesture.dragged).toBe(true)
    expect(dragged.delta).toEqual({ x: 30, y: 28 })
    expect(moveMindmapGesture(dragged.gesture, { x: 10, y: 10 }).gesture.dragged).toBe(true)
    expect(
      moveMindmapGesture({ ...start, nodeId: 'node', pan: false }, { x: 40, y: 40 }).delta,
    ).toEqual({ x: 0, y: 0 })
  })
  it('preserves the visible world center on resize and the selected anchor on structural updates', () => {
    const camera = { x: 20, y: 30, zoom: 0.6 }
    const oldCenter = screenToWorld({ x: 400, y: 300 }, camera)
    const resized = resizeMindmapCamera(
      camera,
      { width: 800, height: 600 },
      { width: 400, height: 500 },
    )
    expect(screenToWorld({ x: 200, y: 250 }, resized)).toEqual(oldCenter)
    const anchored = preserveMindmapAnchor(camera, { x: 200, y: 300 }, { x: 800, y: 900 })
    expect(worldToScreen({ x: 800, y: 900 }, anchored)).toEqual(
      worldToScreen({ x: 200, y: 300 }, camera),
    )
  })
  it('lays out 5000 nodes and a depth-100 path without dropping nodes or recursive traversal', () => {
    const nodes = [{ id: 'root', parentId: null as string | null, order: 0 }]
    for (let index = 1; index < 5000; index++)
      nodes.push({
        id: `n${index}`,
        parentId: index <= 100 ? (index === 1 ? 'root' : `n${index - 1}`) : 'root',
        order: index,
      })
    const layout = layoutMindmap(nodes, 'root')
    expect(layout.nodes).toHaveLength(5000)
    expect(layout.nodes.find((item) => item.id === 'n100')?.depth).toBe(100)
    expect(layout.nodes.every((item) => Number.isFinite(item.x) && Number.isFinite(item.y))).toBe(
      true,
    )
    const index = indexMindmapLayout(layout)
    expect(index.query(layout.bounds)).toHaveLength(5000)
    const fitted = fitMindmap(layout.bounds, { width: 1000, height: 600 })
    expect(fitted.zoom).toBeGreaterThan(0)
    expect(() =>
      layoutMindmap(
        [
          { id: 'root', parentId: null, order: 0 },
          { id: 'orphan', parentId: 'missing', order: 0 },
        ],
        'root',
      ),
    ).toThrow()
  })
})
