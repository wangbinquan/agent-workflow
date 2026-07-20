// RFC-106 T3 — the live preview INPUT port renders on the node while a
// connection is dragged onto it. ConnectDropHint injects `data.previewInputPort`
// (the deconflicted new port name) and PortHandles renders it as a real port row
// — identical to a released one — so the author sees exactly what will be wired.
//
// Locks: the preview port row renders with the name + a `--preview` marker, AND
// its handle exists as a connectable target (data-handleid === the new name), so
// the custom connection line can anchor to it. Existing input rows are unchanged.

import { afterEach, describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { AgentNode } from '../src/components/canvas/nodes/AgentNode'
import type { CanvasNodeData } from '../src/components/canvas/nodes/types'

afterEach(() => {
  document.body.innerHTML = ''
})

function renderAgent(data: Partial<CanvasNodeData> = {}) {
  const merged: CanvasNodeData = {
    surface: 'task',
    nodeId: 'a1',
    kind: 'agent-single',
    title: 'coder',
    inputPorts: ['requirement'],
    outputPorts: ['design'],
    ...data,
  }
  return render(
    <ReactFlowProvider>
      <AgentNode
        {...({
          data: merged,
          selected: false,
          id: merged.nodeId,
          type: 'agent-single',
        } as unknown as Parameters<typeof AgentNode>[0])}
      />
    </ReactFlowProvider>,
  )
}

describe('RFC-106 live preview input port', () => {
  test('without a drag: no preview port row', () => {
    const { container } = renderAgent()
    expect(container.querySelector('.canvas-node__port-row--preview')).toBeNull()
    // existing input handle still present
    expect(
      container.querySelector('.react-flow__handle[data-handleid="requirement"]'),
    ).not.toBeNull()
  })

  test('with previewInputPort: renders the new port row + label + connectable handle', () => {
    const { container, getByText } = renderAgent({ previewInputPort: 'design_2' })
    const row = container.querySelector('.canvas-node__port-row--preview')
    expect(row).not.toBeNull()
    // the new port name is shown to the author
    expect(getByText('design_2')).not.toBeNull()
    // and its handle exists with the new name as the drop target id
    expect(container.querySelector('.react-flow__handle[data-handleid="design_2"]')).not.toBeNull()
  })

  test('previewInputPort that duplicates an existing input is not double-rendered', () => {
    const { container } = renderAgent({ previewInputPort: 'requirement' })
    // PortHandles skips the preview when it collides with an existing port name.
    expect(container.querySelector('.canvas-node__port-row--preview')).toBeNull()
  })

  test('reuseInputPort highlights the existing port row (no new row added)', () => {
    const { container } = renderAgent({ reuseInputPort: 'requirement' })
    const row = container.querySelector('.canvas-node__port-row--reuse-target')
    expect(row).not.toBeNull()
    // it highlights the EXISTING port, not a new one
    expect(row?.textContent).toContain('requirement')
    expect(container.querySelector('.canvas-node__port-row--preview')).toBeNull()
  })
})
