// Regression lock for the automatic-refit state machine in WorkflowCanvas.
//
// History, part 1 — HIDDEN MOUNT (「编排确认门」DAG 预览节点不可见, 2026-07-14).
// A WorkflowCanvas mounted inside a hidden task-detail tab pane
// (`.task-detail__pane[hidden]` → display:none) measures 0×0; xyflow v12
// resolves its queued init fitView against that degenerate viewport (zoom
// clamps to minZoom 0.2, observed transform `translate(-34px,-22.7px)
// scale(0.2)`) and never re-queues the fit when the pane unhides — the dw
// confirm-gate preview rendered as an empty canvas with the node clipped
// off-screen. The repair measures the wrapper SYNCHRONOUSLY on the first
// effect run (a ResizeObserver's first async delivery is already post-unhide
// — the tab flip happens in the same React cascade — so it can never see the
// hidden state) and redoes fitView once on the first real size.
//
// History, part 2 — LAYOUT STILL SETTLING (2026-08-01). The original oracle
// treated "mounted at a real size" as proof the init fitView was correct, and
// never refit such a canvas again. It is not proof: the init fit measures the
// viewport at that instant, and anything that reflows the surrounding layout
// a beat later (web font swap, a chip that stops wrapping, a late image)
// leaves the viewport fitted to a stale box with no correction path. Observed
// on CI: the 390px task-detail canvas rendered 37px off-centre — container,
// minimap and node sizes all byte-identical, only the xyflow viewport
// translated — after an UNRELATED `.chip { white-space: nowrap }` shifted the
// pre-settle layout. So a real-size mount now WATCHES for one size change.
//
// The pan/zoom guarantee the old rule bought is preserved by closing the
// window instead of never watching: `settled` is terminal, and the caller
// settles on the user's first pan/zoom (non-null xyflow move event) and on a
// CANVAS_SETTLE_WINDOW_MS timeout.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  CANVAS_SETTLE_WINDOW_MS,
  INITIAL_CANVAS_REFIT,
  resolveCanvasRefit,
  settleCanvasRefit,
  type CanvasRefitState,
} from '../src/components/canvas/WorkflowCanvas'

const at = (phase: CanvasRefitState['phase'], size: CanvasRefitState['size'] = null) => ({
  phase,
  size,
})

describe('resolveCanvasRefit — first observation', () => {
  test('degenerate mount (0×0) waits for a real size, never refits immediately', () => {
    expect(resolveCanvasRefit(INITIAL_CANVAS_REFIT, 0, 0)).toEqual({
      state: at('awaiting-size'),
      refit: false,
    })
  })

  test('half-degenerate mounts (one axis 0) also wait', () => {
    expect(resolveCanvasRefit(INITIAL_CANVAS_REFIT, 800, 0).state).toEqual(at('awaiting-size'))
    expect(resolveCanvasRefit(INITIAL_CANVAS_REFIT, 0, 600).state).toEqual(at('awaiting-size'))
  })

  test('a real-size mount records the baseline and watches — it does NOT refit yet', () => {
    expect(resolveCanvasRefit(INITIAL_CANVAS_REFIT, 1440, 520)).toEqual({
      state: at('watching-settle', { width: 1440, height: 520 }),
      refit: false,
    })
  })
})

describe('resolveCanvasRefit — hidden-mount path', () => {
  test('keeps waiting while the pane remains hidden (still 0×0)', () => {
    expect(resolveCanvasRefit(at('awaiting-size'), 0, 0)).toEqual({
      state: at('awaiting-size'),
      refit: false,
    })
  })

  test('first real size after a hidden mount refits exactly once and settles', () => {
    expect(resolveCanvasRefit(at('awaiting-size'), 1440, 520)).toEqual({
      state: at('settled'),
      refit: true,
    })
  })
})

describe('resolveCanvasRefit — settling path (the 37px off-centre repair)', () => {
  const watching = at('watching-settle', { width: 390, height: 480 })

  test('an identical re-measure is not a settle event (no refit churn)', () => {
    expect(resolveCanvasRefit(watching, 390, 480)).toEqual({ state: watching, refit: false })
  })

  test('the first size change while watching refits once, then settles', () => {
    const first = resolveCanvasRefit(watching, 390, 554)
    expect(first).toEqual({ state: at('settled'), refit: true })
    // And the window is closed: a second change must NOT refit again.
    expect(resolveCanvasRefit(first.state, 390, 600)).toEqual({
      state: at('settled'),
      refit: false,
    })
  })

  test('either axis changing counts', () => {
    expect(resolveCanvasRefit(watching, 420, 480).refit).toBe(true)
    expect(resolveCanvasRefit(watching, 390, 481).refit).toBe(true)
  })

  test('a mid-watch hide (0×0) keeps the baseline instead of burning the refit', () => {
    expect(resolveCanvasRefit(watching, 0, 0)).toEqual({ state: watching, refit: false })
  })
})

describe('settle is terminal — the user pan/zoom guarantee', () => {
  test('settled stays inert for every size (no refit loops on later resizes)', () => {
    expect(resolveCanvasRefit(at('settled'), 0, 0)).toEqual({ state: at('settled'), refit: false })
    expect(resolveCanvasRefit(at('settled'), 1440, 520)).toEqual({
      state: at('settled'),
      refit: false,
    })
  })

  test('settleCanvasRefit closes the window from any phase', () => {
    expect(settleCanvasRefit(INITIAL_CANVAS_REFIT)).toEqual(at('settled'))
    expect(settleCanvasRefit(at('awaiting-size'))).toEqual(at('settled'))
    expect(settleCanvasRefit(at('watching-settle', { width: 1, height: 2 }))).toEqual(at('settled'))
  })

  test('settling an already-settled state is identity (no needless re-render churn)', () => {
    const s = at('settled')
    expect(settleCanvasRefit(s)).toBe(s)
  })

  test('a user resize AFTER settling cannot move the viewport', () => {
    // The whole point of the window: whatever the user does later, the
    // machine can no longer emit refit.
    let state = settleCanvasRefit(at('watching-settle', { width: 390, height: 480 }))
    for (const [w, h] of [
      [800, 600],
      [1200, 900],
      [390, 480],
    ]) {
      const next = resolveCanvasRefit(state, w!, h!)
      expect(next.refit).toBe(false)
      state = next.state
    }
  })
})

describe('WorkflowCanvas wires the oracle (source-level backstop)', () => {
  const src = readFileSync(
    resolve(__dirname, '..', 'src', 'components', 'canvas', 'WorkflowCanvas.tsx'),
    'utf8',
  )

  test('the effect measures synchronously, observes resize, and refits via rf.fitView()', () => {
    // Sync first measure (the part a ResizeObserver cannot provide).
    expect(src).toContain('el.getBoundingClientRect()')
    // The state must survive effect re-runs (StrictMode / rf identity).
    expect(src).toContain('refitRef')
    expect(src).toMatch(/resolveCanvasRefit\(\s*refitRef\.current/)
    expect(src).toContain('rf.fitView()')
  })

  test('the settle window is closed by BOTH a timeout and the first user move', () => {
    // Timeout arm.
    expect(src).toMatch(/setTimeout\([\s\S]{0,120}settleCanvasRefit/)
    expect(src).toContain('CANVAS_SETTLE_WINDOW_MS')
    // User-interaction arm. The null check is load-bearing: xyflow passes a
    // null event for PROGRAMMATIC moves, and our own fitView animates through
    // onMoveStart — without it the refit would settle itself instantly and
    // the repair above would silently do nothing.
    expect(src).toMatch(/onMoveStart=\{\(event\) =>[\s\S]{0,160}event !== null/)
    expect(src).toMatch(/event !== null[\s\S]{0,80}settleCanvasRefit/)
  })

  test('the window is long enough for a font swap but not user-visible', () => {
    expect(CANVAS_SETTLE_WINDOW_MS).toBeGreaterThanOrEqual(500)
    expect(CANVAS_SETTLE_WINDOW_MS).toBeLessThanOrEqual(3000)
  })
})
