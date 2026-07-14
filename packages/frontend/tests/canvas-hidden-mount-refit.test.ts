// Regression lock for the hidden-mount fitView repair (「编排确认门」DAG 预览
// 节点不可见, 2026-07-14).
//
// History: a WorkflowCanvas mounted inside a hidden task-detail tab pane
// (`.task-detail__pane[hidden]` → display:none) measures 0×0; xyflow v12
// resolves its queued init fitView against that degenerate viewport (zoom
// clamps to minZoom 0.2, observed transform `translate(-34px,-22.7px)
// scale(0.2)`) and never re-queues the fit when the pane unhides — the dw
// confirm-gate preview rendered as an empty canvas with the node clipped
// off-screen. The repair measures the wrapper SYNCHRONOUSLY on the first
// effect run (a ResizeObserver's first async delivery is already post-unhide
// — the tab flip happens in the same React cascade — so it can never see the
// hidden state), arms only on a degenerate mount, and redoes fitView once on
// the first real size. `resolveHiddenMountRefit` is the pure decision oracle
// the effect wires; these tests pin its state machine.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveHiddenMountRefit } from '../src/components/canvas/WorkflowCanvas'

describe('resolveHiddenMountRefit — arming (first observation, armed=null)', () => {
  test('degenerate mount (0×0) arms, never refits immediately', () => {
    expect(resolveHiddenMountRefit(null, 0, 0)).toEqual({ armed: true, refit: false })
  })

  test('half-degenerate mounts (one axis 0) also arm', () => {
    expect(resolveHiddenMountRefit(null, 800, 0)).toEqual({ armed: true, refit: false })
    expect(resolveHiddenMountRefit(null, 0, 600)).toEqual({ armed: true, refit: false })
  })

  test('a visible mount (real size) never arms — user pan/zoom must survive later resizes', () => {
    expect(resolveHiddenMountRefit(null, 1440, 520)).toEqual({ armed: false, refit: false })
  })
})

describe('resolveHiddenMountRefit — armed lifecycle', () => {
  test('stays armed while the pane remains hidden (still 0×0)', () => {
    expect(resolveHiddenMountRefit(true, 0, 0)).toEqual({ armed: true, refit: false })
  })

  test('first real size after a hidden mount refits exactly once and disarms', () => {
    expect(resolveHiddenMountRefit(true, 1440, 520)).toEqual({ armed: false, refit: true })
  })

  test('disarmed stays inert for any size (no refit loops on later resizes)', () => {
    expect(resolveHiddenMountRefit(false, 0, 0)).toEqual({ armed: false, refit: false })
    expect(resolveHiddenMountRefit(false, 1440, 520)).toEqual({ armed: false, refit: false })
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
    // The armed flag must survive effect re-runs (StrictMode / rf identity).
    expect(src).toContain('hiddenMountArmRef')
    // The refit itself.
    expect(src).toMatch(/resolveHiddenMountRefit\(\s*hiddenMountArmRef\.current/)
    expect(src).toContain('rf.fitView()')
  })
})
