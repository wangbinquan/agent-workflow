// RFC-023 PR-C T17 — ClarifyNode visual contract.
//
// Two structural locks:
//   1. status-overlay class follows data.statusOverlay one-to-one for the
//      four documented states (pending / awaiting_human / answered /
//      failed); the data-status attribute mirrors it.
//   2. The node carries exactly one left target Handle (`questions`) and
//      one right source Handle (`answers`), both with the hard-coded port
//      names from shared/schemas/workflow.ts. The handle ids are part of
//      the connectionSync contract — if they drift, reverse-drag breaks.

import { afterEach, describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { CLARIFY_INPUT_PORT_NAME, CLARIFY_OUTPUT_PORT_NAME } from '@agent-workflow/shared'
import { ClarifyNode, type ClarifyNodeData } from '../src/components/canvas/nodes/ClarifyNode'

afterEach(() => {
  document.body.innerHTML = ''
})

function renderNode(data: Partial<ClarifyNodeData> = {}) {
  const merged: ClarifyNodeData = {
    surface: 'task',
    nodeId: 'c1',
    kind: 'clarify',
    title: 'Pick the database',
    inputPorts: [],
    outputPorts: [],
    ...data,
  }
  return render(
    <ReactFlowProvider>
      <ClarifyNode
        {...({
          data: merged,
          selected: false,
          id: merged.nodeId,
          type: 'clarify',
        } as unknown as Parameters<typeof ClarifyNode>[0])}
      />
    </ReactFlowProvider>,
  )
}

describe('ClarifyNode visual', () => {
  test('status-overlay drives both modifier class + data-status attribute for all four states', () => {
    for (const status of ['pending', 'awaiting_human', 'answered', 'failed'] as const) {
      const { container, unmount } = renderNode({ statusOverlay: status })
      const root = container.querySelector('.canvas-node--clarify')
      expect(root).not.toBeNull()
      expect(root?.classList.contains(`canvas-node--clarify-${status}`)).toBe(true)
      expect(root?.getAttribute('data-status')).toBe(status)
      unmount()
    }
  })

  test('renders one input handle (questions) + one output handle (answers) with stable ids', () => {
    const { container } = renderNode({ description: 'Need to pick DB' })
    const handles = container.querySelectorAll('[data-handleid]')
    const ids = Array.from(handles).map((h) => h.getAttribute('data-handleid'))
    expect(ids).toContain(CLARIFY_INPUT_PORT_NAME)
    expect(ids).toContain(CLARIFY_OUTPUT_PORT_NAME)
    // Sanity: no rogue extra ports leaked from PortHandles.
    expect(handles.length).toBe(2)
    // Description renders when non-empty.
    expect(container.textContent).toContain('Need to pick DB')
  })
})
