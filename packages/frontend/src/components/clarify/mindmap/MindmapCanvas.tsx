import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { MindmapNodeSummary } from '@/lib/clarify/mindmap/projection'
import { NoticeBanner } from '@/components/NoticeBanner'
import { LoadingState } from '@/components/LoadingState'
import {
  fitMindmap,
  readableMindmapCamera,
  moveMindmapGesture,
  panelResizeCamera,
  preserveMindmapAnchor,
  resizeMindmapCamera,
  revealMindmapPoint,
  screenToWorld,
  zoomMindmapAt,
  type MindmapCamera,
  type MindmapPanelSession,
  type MindmapPointerGesture,
  type MindmapViewport,
} from '@/lib/clarify/mindmap/geometry'
import { indexMindmapLayout, type MindmapLayout } from '@/lib/clarify/mindmap/layout'
import {
  drawMindmap,
  hitMindmap,
  type MindmapHit,
  type MindmapPalette,
} from '@/lib/clarify/mindmap/draw'

interface Props {
  rootId: string
  topologyRevision: string | number
  nodes: readonly MindmapNodeSummary[]
  selectedId: string | null
  camera: MindmapCamera | null
  onCameraChange: (camera: MindmapCamera) => void
  onSelect: (id: string) => void
  onFocusView: () => void
  highlightPending: boolean
  /** Only explicit search/navigation requests reveal a node; ordinary selection never pans. */
  revealRequest: { id: string; sequence: number } | null
  onRevealHandled: () => void
  /** RFC-490: cards per row at the readable scale; a change lays the map out again. */
  columns: number
  /** RFC-490: the question panel is open beside the canvas (design §4.2). */
  panelOpen?: boolean
}

export function MindmapCanvas(props: Props) {
  const { t } = useTranslation()
  const surface = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const minimap = useRef<HTMLCanvasElement>(null)
  const latest = useRef(props)
  latest.current = props
  const [layout, setLayout] = useState<MindmapLayout | null>(null)
  const [layoutError, setLayoutError] = useState(false)
  const [viewport, setViewport] = useState<MindmapViewport>({ width: 0, height: 0 })
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport
  const hits = useRef<MindmapHit[]>([])
  const gesture = useRef<MindmapPointerGesture | null>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const space = useRef(false)
  const cameraRef = useRef(props.camera)
  cameraRef.current = props.camera
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const panelAtResize = useRef(props.panelOpen === true)
  const panelSession = useRef<MindmapPanelSession | null>(null)
  const [dragging, setDragging] = useState(false)
  const [themeVersion, setThemeVersion] = useState(0)
  const topologyKey = `${props.rootId}:${props.topologyRevision}:${props.columns}`
  const nodes = useMemo(() => new Map(props.nodes.map((node) => [node.id, node])), [props.nodes])
  const positions = useMemo(
    () => new Map(layout?.nodes.map((node) => [node.id, node]) ?? []),
    [layout],
  )
  const positionsRef = useRef(positions)
  positionsRef.current = positions
  const spatial = useMemo(() => (layout ? indexMindmapLayout(layout) : null), [layout])

  useEffect(() => {
    let worker: Worker | undefined
    let alive = true
    setLayoutError(false)
    try {
      worker = new Worker(
        new URL('../../../lib/clarify/mindmap/layout.worker.ts', import.meta.url),
        { type: 'module' },
      )
      worker.onmessage = (
        event: MessageEvent<{ revision: string | number; layout?: MindmapLayout; error?: string }>,
      ) => {
        if (!alive || event.data.revision !== latest.current.topologyRevision) return
        if (!event.data.layout || event.data.error) {
          setLayoutError(true)
          return
        }
        const next = event.data.layout
        const id = latest.current.selectedId
        const previous = layoutRef.current
        if (cameraRef.current && previous) {
          latest.current.onCameraChange(
            preserveMindmapAnchor(
              cameraRef.current,
              previous.nodes.find((node) => node.id === id),
              next.nodes.find((node) => node.id === id),
            ),
          )
        }
        setLayout(next)
      }
      worker.onerror = () => {
        if (alive) setLayoutError(true)
      }
      worker.postMessage({
        revision: props.topologyRevision,
        rootId: props.rootId,
        nodes: props.nodes.map(({ id, parentId, order, kind }) => ({ id, parentId, order, kind })),
        columns: props.columns,
      })
    } catch {
      setLayoutError(true)
    }
    return () => {
      alive = false
      worker?.terminate()
    }
    // Content/status changes must not run layout or reset the viewport.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topologyKey])

  useEffect(() => {
    const element = surface.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect || !rect.width || !rect.height) return
      const next = { width: rect.width, height: rect.height }
      const previous = viewportRef.current
      const camera = cameraRef.current
      const panel = latest.current.panelOpen === true
      if (camera && previous.width) {
        if (panel !== panelAtResize.current && next.width !== previous.width) {
          // The panel took (or gave back) room on the right; the map keeps its place.
          const id = latest.current.selectedId
          const result = panelResizeCamera({
            camera,
            previous,
            next,
            opening: panel,
            node: id ? positionsRef.current.get(id) : undefined,
            session: panelSession.current,
          })
          panelSession.current = result.session
          if (result.camera !== camera) {
            cameraRef.current = result.camera
            latest.current.onCameraChange(result.camera)
          }
        } else latest.current.onCameraChange(resizeMindmapCamera(camera, previous, next))
      }
      panelAtResize.current = panel
      // An explicit reveal in the same turn must already see the new width.
      viewportRef.current = next
      setViewport(next)
    })
    observer.observe(element)
    const theme = new MutationObserver(() => setThemeVersion((version) => version + 1))
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'style'],
    })
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setThemeVersion((version) => version + 1)
    media.addEventListener('change', update)
    return () => {
      observer.disconnect()
      theme.disconnect()
      media.removeEventListener('change', update)
    }
  }, [])
  useEffect(() => {
    if (layout && viewport.width && !cameraRef.current)
      latest.current.onCameraChange(readableMindmapCamera(layout.bounds, viewport))
  }, [layout, viewport])
  useEffect(() => {
    const request = props.revealRequest
    const position = request ? positions.get(request.id) : undefined
    if (position && cameraRef.current) {
      // Kept in the ref at once: a panel that opens in the same turn resizes the canvas
      // before the next render, and its camera rule must start from this position.
      cameraRef.current = revealMindmapPoint(cameraRef.current, position, viewportRef.current)
      if (panelSession.current) panelSession.current.located = true
      latest.current.onCameraChange(cameraRef.current)
      latest.current.onRevealHandled()
    }
  }, [props.revealRequest, positions])

  /** Every move the reader makes themselves: pan, zoom, fit, the minimap, the keys. */
  const setCamera = (value: MindmapCamera) => {
    cameraRef.current = value
    if (panelSession.current) panelSession.current.manual = true
    latest.current.onCameraChange(value)
  }
  const minimumZoom = () =>
    layoutRef.current ? fitMindmap(layoutRef.current.bounds, viewportRef.current).zoom / 4 : 0.01
  const zoom = (factor: number) => {
    const current = cameraRef.current
    if (current)
      setCamera(
        zoomMindmapAt(
          current,
          { x: viewport.width / 2, y: viewport.height / 2 },
          factor,
          minimumZoom(),
        ),
      )
  }
  const fit = () => {
    if (layout) setCamera(fitMindmap(layout.bounds, viewport))
  }

  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      if (!cameraRef.current) return
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      if (event.ctrlKey || event.metaKey) {
        setCamera(
          zoomMindmapAt(
            cameraRef.current,
            { x: event.clientX - rect.left, y: event.clientY - rect.top },
            Math.exp(-event.deltaY * 0.008),
            minimumZoom(),
          ),
        )
      } else {
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1
        setCamera({
          ...cameraRef.current,
          x: cameraRef.current.x - event.deltaX * unit,
          y: cameraRef.current.y - event.deltaY * unit,
        })
      }
    }
    // Wheel ownership is confined to the actual canvas, never the page/editor.
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
    // Camera and viewport are read through refs to avoid listener churn while dragging.
  }, [])

  useEffect(() => {
    if (!layout || !spatial || !props.camera || !canvas.current || !viewport.width) return
    const frame = requestAnimationFrame(() => {
      const element = canvas.current!
      const ctx = element.getContext('2d')
      if (!ctx) {
        setLayoutError(true)
        return
      }
      const dpr = window.devicePixelRatio || 1
      element.width = Math.round(viewport.width * dpr)
      element.height = Math.round(viewport.height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const style = getComputedStyle(surface.current!)
      const token = (name: string, fallback: string) =>
        style.getPropertyValue(name).trim() || fallback
      const palette: MindmapPalette = {
        background: token('--bg', '#fafbfc'),
        surface: token('--panel', '#fff'),
        text: token('--text', '#172033'),
        muted: token('--muted', '#64748b'),
        border: token('--border', '#dce2ea'),
        accent: token('--accent', '#3b82f6'),
        status: {
          done: token('--success', '#21875e'),
          needs_detail: token('--warn-fg', '#bb7b10'),
          needs_confirmation: token('--accent', '#3b82f6'),
        },
      }
      hits.current = drawMindmap({
        ctx,
        viewport,
        camera: props.camera!,
        layout,
        index: spatial,
        positions,
        nodes,
        selectedId: props.selectedId,
        highlightPending: props.highlightPending,
        palette,
        labels: {
          status: {
            done: t('mindmap.status.done'),
            needs_detail: t('mindmap.status.needs_detail'),
            needs_confirmation: t('mindmap.status.needs_confirmation'),
          },
          pending: (count) => t('mindmap.pendingChildren', { count }),
          confirmed: t('mindmap.confirmed'),
          decision: {
            decided: t('mindmap.decision.decided'),
            provisional: t('mindmap.decision.provisional'),
            deferred: t('mindmap.decision.deferred'),
            'not-applicable': t('mindmap.decision.not-applicable'),
            unmarked: t('mindmap.decision.unmarked'),
          },
          empty: t('mindmap.emptyCategory'),
        },
      }).hits
      const mini = minimap.current
      if (!mini) return
      const miniCtx = mini.getContext('2d')
      if (!miniCtx) return
      mini.width = 150 * dpr
      mini.height = 92 * dpr
      miniCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
      miniCtx.clearRect(0, 0, 150, 92)
      const { left, right, top, bottom } = layout.bounds
      const scale = Math.min(134 / (right - left), 76 / (bottom - top))
      const x = 75 - ((left + right) * scale) / 2,
        y = 46 - ((top + bottom) * scale) / 2
      for (const point of layout.nodes) {
        const summary = nodes.get(point.id)
        miniCtx.fillStyle = summary?.empty
          ? palette.muted
          : palette.status[summary?.status ?? 'needs_detail']
        miniCtx.fillRect(x + point.x * scale, y + point.y * scale, 2, 2)
      }
      const a = screenToWorld({ x: 0, y: 0 }, props.camera!)
      miniCtx.strokeStyle = palette.accent
      miniCtx.lineWidth = 1.5
      miniCtx.strokeRect(
        x + a.x * scale,
        y + a.y * scale,
        (viewport.width / props.camera!.zoom) * scale,
        (viewport.height / props.camera!.zoom) * scale,
      )
    })
    return () => cancelAnimationFrame(frame)
  }, [
    layout,
    spatial,
    positions,
    props.camera,
    nodes,
    viewport,
    props.selectedId,
    props.highlightPending,
    themeVersion,
    t,
  ])

  const pointOf = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }
  const rounded = (value: number, digits: number) => Math.round(value * digits) / digits
  return (
    // The data attributes are read-only observations for in-browser checks (design §5.5).
    <div
      className="mindmap-canvas"
      ref={surface}
      data-columns={props.columns}
      data-world-width={layout ? Math.round(layout.bounds.right - layout.bounds.left) : undefined}
      data-world-height={layout ? Math.round(layout.bounds.bottom - layout.bounds.top) : undefined}
      data-camera={
        props.camera
          ? `${rounded(props.camera.x, 10)},${rounded(props.camera.y, 10)},${rounded(props.camera.zoom, 1000)}`
          : undefined
      }
    >
      {layoutError && (
        <div className="mindmap-canvas__notice">
          <NoticeBanner tone="warning">
            {t('mindmap.layoutError')}{' '}
            <button type="button" className="btn btn--sm" onClick={props.onFocusView}>
              {t('mindmap.focus')}
            </button>
          </NoticeBanner>
        </div>
      )}
      {!layout && !layoutError && (
        <div className="mindmap-canvas__notice">
          <LoadingState />
        </div>
      )}
      <canvas
        ref={canvas}
        className={dragging ? 'mindmap-canvas__surface is-dragging' : 'mindmap-canvas__surface'}
        tabIndex={0}
        role="img"
        aria-label={t('mindmap.canvasLabel')}
        aria-describedby="mindmap-canvas-help"
        onDoubleClick={(event) => event.preventDefault()}
        onContextMenu={(event) => {
          if (dragging) event.preventDefault()
        }}
        onBlur={() => {
          space.current = false
        }}
        onKeyDown={(event) => {
          if (event.key === ' ') {
            space.current = true
            event.preventDefault()
          } else if (event.key === '+' || event.key === '=') {
            event.preventDefault()
            zoom(1.25)
          } else if (event.key === '-') {
            event.preventDefault()
            zoom(0.8)
          } else if (event.key === '0') {
            event.preventDefault()
            fit()
          } else if (event.key.startsWith('Arrow') && cameraRef.current) {
            event.preventDefault()
            const x = event.key === 'ArrowLeft' ? 60 : event.key === 'ArrowRight' ? -60 : 0
            const y = event.key === 'ArrowUp' ? 60 : event.key === 'ArrowDown' ? -60 : 0
            setCamera({
              ...cameraRef.current,
              x: cameraRef.current.x + x,
              y: cameraRef.current.y + y,
            })
          }
        }}
        onKeyUp={(event) => {
          if (event.key === ' ') space.current = false
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 && event.button !== 1) return
          event.currentTarget.focus({ preventScroll: true })
          event.currentTarget.setPointerCapture(event.pointerId)
          const point = pointOf(event)
          pointers.current.set(event.pointerId, point)
          const nodeId = hitMindmap(hits.current, point.x, point.y)
          gesture.current = {
            pointerId: event.pointerId,
            origin: point,
            last: point,
            nodeId,
            pan: event.button === 1 || space.current || !nodeId || event.pointerType === 'touch',
            dragged: pointers.current.size > 1,
          }
        }}
        onPointerMove={(event) => {
          if (!pointers.current.size) {
            const point = pointOf(event)
            const id = hitMindmap(hits.current, point.x, point.y)
            const hovered = id ? nodes.get(id) : undefined
            event.currentTarget.title = hovered
              ? `${hovered.title} · ${
                  hovered.empty ? t('mindmap.emptyCategory') : t(`mindmap.status.${hovered.status}`)
                }`
              : ''
            event.currentTarget.style.cursor = id ? 'pointer' : 'grab'
          }
          if (!pointers.current.has(event.pointerId) || !cameraRef.current) return
          const point = pointOf(event)
          if (pointers.current.size === 2) {
            const before = [...pointers.current.values()]
            pointers.current.set(event.pointerId, point)
            const after = [...pointers.current.values()]
            const center = {
              x: (before[0]!.x + before[1]!.x) / 2,
              y: (before[0]!.y + before[1]!.y) / 2,
            }
            const nextCenter = {
              x: (after[0]!.x + after[1]!.x) / 2,
              y: (after[0]!.y + after[1]!.y) / 2,
            }
            const distance = Math.hypot(before[0]!.x - before[1]!.x, before[0]!.y - before[1]!.y)
            const nextDistance = Math.hypot(after[0]!.x - after[1]!.x, after[0]!.y - after[1]!.y)
            const next = zoomMindmapAt(
              cameraRef.current,
              center,
              nextDistance / Math.max(1, distance),
              minimumZoom(),
            )
            setCamera({
              ...next,
              x: next.x + nextCenter.x - center.x,
              y: next.y + nextCenter.y - center.y,
            })
            if (gesture.current) gesture.current.dragged = true
            setDragging(true)
            return
          }
          pointers.current.set(event.pointerId, point)
          if (!gesture.current || gesture.current.pointerId !== event.pointerId) return
          const next = moveMindmapGesture(gesture.current, point)
          gesture.current = next.gesture
          if (next.gesture.dragged) setDragging(true)
          if (next.delta.x || next.delta.y)
            setCamera({
              ...cameraRef.current,
              x: cameraRef.current.x + next.delta.x,
              y: cameraRef.current.y + next.delta.y,
            })
        }}
        onPointerUp={(event) => {
          const current = gesture.current
          pointers.current.delete(event.pointerId)
          if (
            current?.pointerId === event.pointerId &&
            !current.dragged &&
            current.nodeId &&
            event.button === 0 &&
            !space.current
          )
            props.onSelect(current.nodeId)
          const remaining = [...pointers.current.entries()][0]
          gesture.current = remaining
            ? {
                pointerId: remaining[0],
                origin: remaining[1],
                last: remaining[1],
                nodeId: null,
                pan: true,
                dragged: true,
              }
            : null
          setDragging(!!remaining)
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onPointerCancel={(event) => {
          pointers.current.delete(event.pointerId)
          gesture.current = null
          setDragging(false)
        }}
        onLostPointerCapture={(event) => {
          pointers.current.delete(event.pointerId)
          if (gesture.current?.pointerId === event.pointerId) gesture.current = null
          if (!pointers.current.size) setDragging(false)
        }}
      />
      <div className="mindmap-canvas__controls">
        <button
          type="button"
          className="btn btn--sm"
          aria-label={t('mindmap.zoomOut')}
          onClick={() => zoom(0.8)}
        >
          −
        </button>
        <output aria-label={t('mindmap.zoom')}>
          {props.camera ? `${Math.round(props.camera.zoom * 1000) / 10}%` : '—'}
        </output>
        <button
          type="button"
          className="btn btn--sm"
          aria-label={t('mindmap.zoomIn')}
          onClick={() => zoom(1.25)}
        >
          +
        </button>
        <button type="button" className="btn btn--sm" onClick={fit}>
          {t('mindmap.fit')}
        </button>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => {
            if (layout) setCamera(readableMindmapCamera(layout.bounds, viewport))
          }}
        >
          {t('mindmap.readable')}
        </button>
      </div>
      <button
        type="button"
        className="mindmap-canvas__minimap"
        aria-label={t('mindmap.minimap')}
        onClick={(event) => {
          if (!layout || !cameraRef.current) return
          const rect = event.currentTarget.getBoundingClientRect()
          const { left, right, top, bottom } = layout.bounds
          const scale = Math.min(134 / (right - left), 76 / (bottom - top))
          const x =
            event.detail === 0
              ? (left + right) / 2
              : (((event.clientX - rect.left) * 150) / rect.width - 75) / scale + (left + right) / 2
          const y =
            event.detail === 0
              ? (top + bottom) / 2
              : (((event.clientY - rect.top) * 92) / rect.height - 46) / scale + (top + bottom) / 2
          setCamera({
            ...cameraRef.current,
            x: viewport.width / 2 - x * cameraRef.current.zoom,
            y: viewport.height / 2 - y * cameraRef.current.zoom,
          })
        }}
      >
        <canvas ref={minimap} aria-hidden="true" />
      </button>
      {/* One variant is shown per input type; a hidden variant is not announced. */}
      <p id="mindmap-canvas-help" className="mindmap-canvas__help">
        <span className="mindmap-canvas__help-pointer">{t('mindmap.canvasHelp')}</span>
        <span className="mindmap-canvas__help-touch">{t('mindmap.canvasHelpTouch')}</span>
      </p>
    </div>
  )
}
