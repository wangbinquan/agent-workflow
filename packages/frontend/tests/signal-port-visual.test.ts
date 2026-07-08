// RFC-060 PR-F F.T2 — signal-port visual distinction.
//
// Locks the canvas-side rendering contract: wrapper-fanout outlets whose
// port name is the implicit `__done__` signal carry the `--signal`
// modifier class on both the bottom-port wrapper and the handle, so the
// dashed-handle / dimmed-label styling lands at render time.
//
// The actual CSS rules live in styles.css (`.canvas-node__handle--signal`,
// `.canvas-node__bottom-port--signal`). This file pins the source-text
// contract (CSS classes exist + WrapperNodes emits them) without booting a
// real React tree — same source-lock strategy as scheduler-fanout-sharding
// + scheduler-wrapper-fanout-routing.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const REPO = resolve(import.meta.dirname, '..', '..', '..')

const wrapperNodesSrc = readFileSync(
  resolve(REPO, 'packages/frontend/src/components/canvas/nodes/WrapperNodes.tsx'),
  'utf-8',
)
const stylesCss = readFileSync(resolve(REPO, 'packages/frontend/src/styles.css'), 'utf-8')

describe('RFC-060 F.T2 — wrapper-fanout signal-port visual contract', () => {
  test('WrapperNodes branches on the shared FANOUT_DONE_PORT_NAME to apply --signal modifier', () => {
    // flag-audit W0：'__done__' 裸字面量改为 shared 常量（单源）；契约不变。
    expect(wrapperNodesSrc).toContain('const isSignal = p === FANOUT_DONE_PORT_NAME')
    expect(wrapperNodesSrc).toContain('canvas-node__bottom-port--signal')
    expect(wrapperNodesSrc).toContain('canvas-node__handle--signal')
  })

  test('data-signal data attribute exposes the variant for test selectors', () => {
    expect(wrapperNodesSrc).toContain("data-signal={isSignal ? 'true' : undefined}")
  })

  test('styles.css declares dashed-handle + dimmed-label rules for --signal', () => {
    expect(stylesCss).toContain('.canvas-node__handle--signal')
    expect(stylesCss).toContain('.canvas-node__bottom-port--signal')
    // dashed + muted-border ring (mirrors the shard-source styling family)
    expect(stylesCss).toMatch(/\.canvas-node__handle--signal[^}]*border[^}]*dashed/s)
  })

  test('computePorts emits derived wrapper-fanout outputs (via the shared declaration table)', () => {
    // RFC-146: the per-kind switch left WorkflowCanvas — computePorts reads
    // the shared declaredPorts table, whose wrapper-fanout row derives
    // outlets via deriveWrapperFanoutOutputs. Anchor both hops so neither
    // silently regresses to a local fork.
    const canvasSrc = readFileSync(
      resolve(REPO, 'packages/frontend/src/components/canvas/WorkflowCanvas.tsx'),
      'utf-8',
    )
    expect(canvasSrc).toContain('declaredPorts(node, definition, agentByName)')
    const tableSrc = readFileSync(resolve(REPO, 'packages/shared/src/nodePorts.ts'), 'utf-8')
    expect(tableSrc).toMatch(/'wrapper-fanout':[\s\S]*?deriveWrapperFanoutOutputs\(defn, node\.id/)
  })
})
