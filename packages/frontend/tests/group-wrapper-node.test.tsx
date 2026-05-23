// RFC-016 §3.1 / T5: GroupWrapperNode is the unified replacement for the
// old GitWrapperNode + LoopWrapperNode placeholder cards. These tests lock
// the structural contract: branching on data.kind picks the icon / label
// / pill, loop wrappers keep the RFC-003 catch-all but lose named left
// input ports, empty wrappers show the drop-here hint.

import { afterEach, describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { GroupWrapperNode, type WrapperNodeData } from '../src/components/canvas/nodes/WrapperNodes'
import { INBOUND_HANDLE_ID } from '../src/components/canvas/nodes/types'
import '../src/i18n'
import { setLanguage } from '../src/i18n'

afterEach(() => {
  document.body.innerHTML = ''
})

function renderNode(data: WrapperNodeData, selected = false) {
  // Cast to any so we don't need to mock the entire NodeProps surface.
  return render(
    <ReactFlowProvider>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <GroupWrapperNode {...({ data, selected, id: data.nodeId, type: data.kind } as any)} />
    </ReactFlowProvider>,
  )
}

function gitData(overrides: Partial<WrapperNodeData> = {}): WrapperNodeData {
  return {
    nodeId: 'w1',
    kind: 'wrapper-git',
    title: 'w1',
    inputPorts: [],
    outputPorts: ['out'],
    innerCount: 2,
    ...overrides,
  }
}
function loopData(overrides: Partial<WrapperNodeData> = {}): WrapperNodeData {
  return {
    nodeId: 'loop1',
    kind: 'wrapper-loop',
    title: 'loop1',
    inputPorts: [],
    outputPorts: ['result'],
    innerCount: 3,
    maxIterations: 5,
    exitConditionKind: 'port-equals',
    ...overrides,
  }
}
function fanoutData(overrides: Partial<WrapperNodeData> = {}): WrapperNodeData {
  return {
    nodeId: 'fan1',
    kind: 'wrapper-fanout',
    title: 'fan1',
    inputPorts: [],
    outputPorts: [],
    innerCount: 1,
    ...overrides,
  }
}

describe('GroupWrapperNode', () => {
  test('git wrapper carries the wrapper-group--git modifier class', () => {
    const { container } = renderNode(gitData())
    const root = container.querySelector('.canvas-node--wrapper-group')
    expect(root).not.toBeNull()
    expect(root?.classList.contains('canvas-node--wrapper-group--git')).toBe(true)
  })

  test('loop wrapper carries the wrapper-group--loop modifier class', () => {
    const { container } = renderNode(loopData())
    const root = container.querySelector('.canvas-node--wrapper-group')
    expect(root?.classList.contains('canvas-node--wrapper-group--loop')).toBe(true)
  })

  test('git pill renders the "snapshot" string', () => {
    const { container } = renderNode(gitData())
    const pill = container.querySelector('.wrapper-header-pill')
    expect(pill?.textContent).toContain('snapshot')
  })

  // 2026-05-24: loop pill harmonized with the git/fanout pills — now a short
  // kind label ("loop") instead of the cryptic "× 7 · port-empty" parameter
  // dump. The detailed maxIterations + exit condition info still surfaces in
  // the Inspector. If a regression re-introduces the parameter-dump format,
  // these assertions flip red.
  test('loop pill renders a plain kind label, not a parameter dump', () => {
    const { container } = renderNode(
      loopData({ maxIterations: 7, exitConditionKind: 'port-empty' }),
    )
    const pill = container.querySelector('.wrapper-header-pill')
    expect(pill?.textContent).toContain('loop')
    expect(pill?.textContent ?? '').not.toContain('× 7')
    expect(pill?.textContent ?? '').not.toContain('port-empty')
  })

  test('loop wrapper keeps the catch-all inbound handle (RFC-003)', () => {
    const { container } = renderNode(loopData())
    const catchAll = container.querySelector('.canvas-node__handle--catchall')
    expect(catchAll).not.toBeNull()
    expect(catchAll?.getAttribute('data-handleid')).toBe(INBOUND_HANDLE_ID)
  })

  test('loop wrapper no longer renders named left input ports', () => {
    // Even when inputPorts contains entries (legacy data), the new node
    // only renders the catch-all on the left. Named-left handles would
    // have shown up as additional `.canvas-node__handle` elements with
    // a non-catchall class.
    const { container } = renderNode(loopData({ inputPorts: ['orphan_a', 'orphan_b'] }))
    const named = container.querySelectorAll(
      '.canvas-node__handle:not(.canvas-node__handle--catchall)',
    )
    // Right-side `outputPorts` handles are the only named ones expected.
    expect(named.length).toBe(1)
    expect(named[0]?.getAttribute('data-handleid')).toBe('result')
  })

  test('empty wrapper (innerCount=0) shows the "Drop nodes here" hint', () => {
    const { container } = renderNode(gitData({ innerCount: 0 }))
    expect(container.textContent ?? '').toContain('Drop nodes here')
  })

  test('non-empty wrapper does NOT show the drop-here hint', () => {
    const { container } = renderNode(gitData({ innerCount: 2 }))
    expect((container.textContent ?? '').includes('Drop nodes here')).toBe(false)
  })

  // Locks in the i18n bug fix from 2026-05-24: wrapper-fanout used to silently
  // fall through to the git label/icon because the kind branch only knew
  // about 'git' and 'loop'. The three assertions below pin the fanout chip
  // chrome (icon + label + pill) so a future regression that re-collapses
  // wrapper-fanout into git would flip them red immediately.
  describe('wrapper-fanout (RFC-060)', () => {
    test('fanout wrapper renders the fanout label, not the git label', () => {
      setLanguage('en-US')
      const { container } = renderNode(fanoutData())
      const kindChip = container.querySelector('.canvas-node__kind')
      expect(kindChip?.textContent).toContain('Fanout Wrapper')
      expect(kindChip?.textContent ?? '').not.toContain('Git Wrapper')
    })
    test('fanout pill renders the localized "fanout" badge', () => {
      setLanguage('en-US')
      const { container } = renderNode(fanoutData())
      const pill = container.querySelector('.wrapper-header-pill')
      expect(pill?.textContent).toContain('fanout')
      // Must NOT collapse into the git "snapshot" pill.
      expect(pill?.textContent ?? '').not.toContain('snapshot')
      expect(pill?.classList.contains('wrapper-header-pill--fanout')).toBe(true)
    })
    test('fanout wrapper shows the Chinese label under zh-CN', () => {
      setLanguage('zh-CN')
      try {
        const { container } = renderNode(fanoutData())
        const kindChip = container.querySelector('.canvas-node__kind')
        expect(kindChip?.textContent).toContain('分片包装器')
        const pill = container.querySelector('.wrapper-header-pill')
        expect(pill?.textContent).toContain('分片')
      } finally {
        setLanguage('en-US')
      }
    })

    // 2026-05-24: locks the "output port styling matches git's once an
    // aggregator is wired" contract the user asked for. Without an
    // aggregator the wrapper exposes the implicit `__done__` signal
    // outlet — that one keeps the dashed/dimmed signal chrome (existing
    // signal-port-visual.test.ts source-locks the branch). The moment the
    // author drops in an aggregator agent, deriveWrapperFanoutOutputs
    // surfaces the agent's renamed outputs instead of `__done__`, and the
    // bottom-port renderer must render them as plain data handles — the
    // same way wrapper-git renders `git_diff`. Otherwise the wrapper's
    // outputs would visually diverge from git's, which is the bug the
    // user just reported about pre-aggregator state.
    // 2026-05-24 — fanout now renders outputs on the RIGHT edge (via the
    // shared `.canvas-node__port-row--right` path) instead of the bottom-
    // centered strip the other wrapper kinds use. The signal-port chrome
    // for `__done__` still applies; query the right-side port row.
    test('fanout output: __done__ gets signal chrome (no-aggregator case)', () => {
      const { container } = renderNode(fanoutData({ outputPorts: ['__done__'] }))
      const port = container.querySelector(
        '.canvas-node__port-rows--wrapper-fanout .canvas-node__port-row',
      )
      expect(port?.classList.contains('canvas-node__port-row--signal')).toBe(true)
      const handle = port?.querySelector('.canvas-node__handle')
      expect(handle?.classList.contains('canvas-node__handle--signal')).toBe(true)
    })
    test('fanout output: aggregator-derived port renders as plain data handle (matches git_diff)', () => {
      const { container } = renderNode(fanoutData({ outputPorts: ['summary'] }))
      const port = container.querySelector(
        '.canvas-node__port-rows--wrapper-fanout .canvas-node__port-row',
      )
      expect(port).not.toBeNull()
      // No --signal modifier when the port is a real data output — that's
      // what unifies the visual with wrapper-git's `git_diff` (both render
      // as plain data handles, just on different edges).
      expect(port?.classList.contains('canvas-node__port-row--signal')).toBe(false)
      const handle = port?.querySelector('.canvas-node__handle')
      expect(handle?.classList.contains('canvas-node__handle--signal')).toBe(false)
    })
    test('fanout wrapper places outputs on the RIGHT, not the bottom strip', () => {
      const { container } = renderNode(fanoutData({ outputPorts: ['summary'] }))
      expect(container.querySelector('.canvas-node__bottom-ports')).toBeNull()
      expect(container.querySelector('.canvas-node__port-rows--right')).not.toBeNull()
    })

    // 2026-05-24 — fanout wrappers need left-side input Handles so users
    // can drag-connect upstream nodes into the shardSource (+ optional
    // broadcast inputs). Without these the wrapper has outputs only and
    // is unreachable from upstream on the canvas.
    test('fanout wrapper renders a target handle for each declared input port', () => {
      const { container } = renderNode(fanoutData({ inputPorts: ['docs'] }))
      const leftHandles = container.querySelectorAll(
        '.canvas-node__port-rows--left .canvas-node__handle',
      )
      expect(leftHandles.length).toBe(1)
      expect(leftHandles[0]?.getAttribute('data-handleid')).toBe('docs')
    })
    test('fanout wrapper also exposes the catch-all left strip for tolerant drops', () => {
      const { container } = renderNode(fanoutData({ inputPorts: ['docs'] }))
      const catchAll = container.querySelector('.canvas-node__handle--catchall')
      expect(catchAll).not.toBeNull()
      expect(catchAll?.getAttribute('data-handleid')).toBe(INBOUND_HANDLE_ID)
    })
  })
})
