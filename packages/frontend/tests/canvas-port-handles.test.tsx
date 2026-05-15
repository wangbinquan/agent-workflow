// PortHandles — RFC-003 catch-all rendering & precedence + RFC-006
// inline-row layout (labels live inside node body, never overlap
// header / title / id; long names truncate with title fallback).
//
// xyflow's Handle requires a ReactFlowProvider in context. We wrap the
// component under test in <ReactFlowProvider> so xyflow's hooks can run
// without complaining; we don't assert on its internal state.

import { afterEach, describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { PortHandles } from '../src/components/canvas/nodes/PortHandles'
import { INBOUND_HANDLE_ID } from '../src/components/canvas/nodes/types'

afterEach(() => {
  document.body.innerHTML = ''
})

function renderHandles(ui: React.ReactNode) {
  return render(<ReactFlowProvider>{ui}</ReactFlowProvider>)
}

describe('PortHandles', () => {
  test('side=left, no ports, no catchAll → renders nothing', () => {
    const { container } = renderHandles(<PortHandles side="left" ports={[]} />)
    expect(container.querySelectorAll('.canvas-node__handle').length).toBe(0)
  })

  test('side=left, no ports + catchAll → 1 invisible target handle', () => {
    const { container } = renderHandles(
      <PortHandles side="left" ports={[]} catchAll={{ id: INBOUND_HANDLE_ID }} />,
    )
    const handles = container.querySelectorAll('.canvas-node__handle')
    expect(handles.length).toBe(1)
    expect(handles[0]?.classList.contains('canvas-node__handle--catchall')).toBe(true)
    expect(handles[0]?.getAttribute('data-handleid')).toBe(INBOUND_HANDLE_ID)
  })

  test('side=left, ports + catchAll → catch-all rendered BEFORE named handles', () => {
    const { container } = renderHandles(
      <PortHandles side="left" ports={['a', 'b']} catchAll={{ id: INBOUND_HANDLE_ID }} />,
    )
    const handles = Array.from(container.querySelectorAll('.canvas-node__handle'))
    expect(handles.length).toBe(3)
    expect(handles[0]?.classList.contains('canvas-node__handle--catchall')).toBe(true)
    // Named handles do NOT carry the catchall class — they win on z-index
    // (asserted via styles.css; not testable here but the class separation
    // is the structural guarantee).
    expect(handles[1]?.classList.contains('canvas-node__handle--catchall')).toBe(false)
    expect(handles[2]?.classList.contains('canvas-node__handle--catchall')).toBe(false)
    // Named handle ids are the port names.
    expect(handles[1]?.getAttribute('data-handleid')).toBe('a')
    expect(handles[2]?.getAttribute('data-handleid')).toBe('b')
  })

  test('side=right + catchAll → catch-all is ignored (right side has no inbound)', () => {
    const { container } = renderHandles(
      <PortHandles side="right" ports={['a']} catchAll={{ id: INBOUND_HANDLE_ID }} />,
    )
    const handles = container.querySelectorAll('.canvas-node__handle')
    expect(handles.length).toBe(1)
    expect(handles[0]?.classList.contains('canvas-node__handle--catchall')).toBe(false)
  })
})

// RFC-006: the visual fix that made labels stop overlapping node header.
// These assertions lock in the new DOM contract — labels MUST live
// inside the node body, port rows MUST exist, catch-all MUST be a
// sibling of (not inside) the row container. A future refactor that
// reintroduces the absolute-strip-of-chips layout will fail these.
describe('PortHandles — RFC-006 inline rows', () => {
  test('label DOM lives inside node body, not on an absolutely-positioned strip', () => {
    const { container } = renderHandles(
      <div className="canvas-node">
        <PortHandles side="left" ports={['diff']} />
        <PortHandles side="right" ports={['result']} />
      </div>,
    )
    const labels = container.querySelectorAll('.canvas-node__port-label')
    expect(labels.length).toBe(2)
    for (const label of Array.from(labels)) {
      expect(label.closest('.canvas-node')).toBeTruthy()
      expect(label.closest('.canvas-node__port-row')).toBeTruthy()
      expect(label.closest('.canvas-node__port-rows')).toBeTruthy()
      // Old absolute-strip class is gone — labels no longer descend from it.
      expect(label.closest('.canvas-node__ports')).toBeNull()
    }
  })

  test('label rendered AFTER header in document order (no z-index overlap path)', () => {
    const { container } = renderHandles(
      <div className="canvas-node">
        <div className="canvas-node__header">
          <span className="canvas-node__title">Agent</span>
        </div>
        <PortHandles side="right" ports={['out']} />
      </div>,
    )
    const header = container.querySelector('.canvas-node__header')!
    const label = container.querySelector('.canvas-node__port-label')!
    // DOCUMENT_POSITION_FOLLOWING = 4 — label comes after header in DOM.
    expect(header.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test('long port name carries title attribute equal to original name (tooltip fallback)', () => {
    const longName = 'design_doc_markdown_summary'
    const { container } = renderHandles(<PortHandles side="right" ports={[longName]} />)
    const label = container.querySelector('.canvas-node__port-label')!
    expect(label.getAttribute('title')).toBe(longName)
    expect(label.textContent).toBe(longName)
  })

  test('catch-all wrapped in .canvas-node__inbound-catchall outside port-rows', () => {
    const { container } = renderHandles(
      <PortHandles side="left" ports={['a']} catchAll={{ id: INBOUND_HANDLE_ID }} />,
    )
    const wrapper = container.querySelector('.canvas-node__inbound-catchall')
    expect(wrapper).toBeTruthy()
    expect(wrapper!.querySelector('.canvas-node__handle--catchall')).toBeTruthy()
    // The catch-all wrapper is NOT inside the rows container.
    expect(wrapper!.closest('.canvas-node__port-rows')).toBeNull()
    // The rows container does NOT include the catch-all.
    const rows = container.querySelector('.canvas-node__port-rows')!
    expect(rows.querySelector('.canvas-node__handle--catchall')).toBeNull()
  })

  test('side="left" port rows carry --left modifier classes', () => {
    const { container } = renderHandles(<PortHandles side="left" ports={['in']} />)
    expect(container.querySelector('.canvas-node__port-rows--left')).toBeTruthy()
    expect(container.querySelector('.canvas-node__port-row--left')).toBeTruthy()
    expect(container.querySelector('.canvas-node__port-rows--right')).toBeNull()
  })

  test('side="right" port rows carry --right modifier classes', () => {
    const { container } = renderHandles(<PortHandles side="right" ports={['out']} />)
    expect(container.querySelector('.canvas-node__port-rows--right')).toBeTruthy()
    expect(container.querySelector('.canvas-node__port-row--right')).toBeTruthy()
    expect(container.querySelector('.canvas-node__port-rows--left')).toBeNull()
  })

  test('one row per port — N ports produce N rows (height scales with count in real browsers)', () => {
    // JSDOM does not run layout, so we can't measure offsetHeight here.
    // Row count is the structural proxy that drives visible height growth.
    const oneRow = renderHandles(<PortHandles side="right" ports={['a']} />)
    expect(oneRow.container.querySelectorAll('.canvas-node__port-row').length).toBe(1)
    oneRow.unmount()
    const sixRows = renderHandles(
      <PortHandles side="right" ports={['a', 'b', 'c', 'd', 'e', 'f']} />,
    )
    expect(sixRows.container.querySelectorAll('.canvas-node__port-row').length).toBe(6)
  })
})
