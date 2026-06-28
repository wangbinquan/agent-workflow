// RFC-120 D13 — on-canvas per-node pending-question badge.
//
// Locks three things:
//   1. toFlowNodes only stamps data.questionCount when a count is > 0, and
//      stamps NOTHING when no counts are passed (golden-lock: a canvas with no
//      counts is byte-for-byte unchanged — the existing canvas tests rely on it).
//   2. The "asking" node renderers (agent / clarify / cross-clarify) paint a
//      `canvas-qbadge-<id>` button iff questionCount > 0.
//   3. Clicking the badge calls data.onQuestionBadgeClick with the node id AND
//      stops propagation, so a badge click does NOT also select the node behind
//      it (xyflow's node onClick).

import { afterEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { AgentNode } from '../src/components/canvas/nodes/AgentNode'
import { ClarifyNode } from '../src/components/canvas/nodes/ClarifyNode'
import { CrossClarifyNode } from '../src/components/canvas/nodes/CrossClarifyNode'
import type { CanvasNodeData } from '../src/components/canvas/nodes/types'
import { __testToFlowNodes as toFlowNodes } from '../src/components/canvas/WorkflowCanvas'
import '../src/i18n'

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function nodeProps(data: Record<string, unknown>): any {
  return {
    id: data.nodeId,
    type: 'x',
    data,
    selected: false,
    dragging: false,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    zIndex: 0,
  }
}

function agentData(over: Partial<CanvasNodeData> = {}): CanvasNodeData {
  return {
    nodeId: 'a1',
    kind: 'agent-single',
    title: 'coder',
    inputPorts: [],
    outputPorts: [],
    ...over,
  }
}

describe('toFlowNodes question-count propagation (golden-lock)', () => {
  test('stamps data.questionCount when the count is > 0', () => {
    const flow = toFlowNodes([{ id: 'a1', kind: 'agent-single' }], [], [], undefined, { a1: 3 })
    expect((flow[0]?.data as CanvasNodeData).questionCount).toBe(3)
  })

  test('omits questionCount for nodes whose count is 0 or absent', () => {
    const flow = toFlowNodes(
      [
        { id: 'a1', kind: 'agent-single' },
        { id: 'a2', kind: 'agent-single' },
      ],
      [],
      [],
      undefined,
      { a1: 0 },
    )
    expect((flow[0]?.data as CanvasNodeData).questionCount).toBeUndefined()
    expect((flow[1]?.data as CanvasNodeData).questionCount).toBeUndefined()
  })

  test('omits questionCount entirely when no counts map is supplied (byte-for-byte)', () => {
    const flow = toFlowNodes([{ id: 'a1', kind: 'agent-single' }], [], [])
    const data = flow[0]?.data as CanvasNodeData
    expect(data.questionCount).toBeUndefined()
    expect(data.onQuestionBadgeClick).toBeUndefined()
  })
})

describe('node badge render', () => {
  test('AgentNode renders the badge with the count when questionCount > 0', () => {
    render(
      <ReactFlowProvider>
        <AgentNode {...nodeProps(agentData({ questionCount: 4 }))} />
      </ReactFlowProvider>,
    )
    const badge = screen.getByTestId('canvas-qbadge-a1')
    expect(badge.textContent).toBe('4')
    // aria-label interpolates the count regardless of locale (zh/en both use {{count}}).
    expect(badge.getAttribute('aria-label')).toContain('4')
  })

  test('AgentNode renders NO badge when questionCount is 0 / undefined', () => {
    const { rerender } = render(
      <ReactFlowProvider>
        <AgentNode {...nodeProps(agentData({ questionCount: 0 }))} />
      </ReactFlowProvider>,
    )
    expect(screen.queryByTestId('canvas-qbadge-a1')).toBeNull()
    rerender(
      <ReactFlowProvider>
        <AgentNode {...nodeProps(agentData())} />
      </ReactFlowProvider>,
    )
    expect(screen.queryByTestId('canvas-qbadge-a1')).toBeNull()
  })

  test('ClarifyNode and CrossClarifyNode (asking nodes) also paint the badge', () => {
    render(
      <ReactFlowProvider>
        <ClarifyNode
          {...nodeProps({
            nodeId: 'c1',
            kind: 'clarify',
            title: 'ask',
            inputPorts: [],
            outputPorts: [],
            questionCount: 2,
          })}
        />
        <CrossClarifyNode
          {...nodeProps({
            nodeId: 'x1',
            kind: 'clarify-cross-agent',
            title: 'cross-ask',
            inputPorts: [],
            outputPorts: [],
            questionCount: 1,
          })}
        />
      </ReactFlowProvider>,
    )
    expect(screen.getByTestId('canvas-qbadge-c1').textContent).toBe('2')
    expect(screen.getByTestId('canvas-qbadge-x1').textContent).toBe('1')
  })
})

describe('badge click', () => {
  test('calls onQuestionBadgeClick with the node id', () => {
    const onClick = vi.fn()
    render(
      <ReactFlowProvider>
        <AgentNode {...nodeProps(agentData({ questionCount: 1, onQuestionBadgeClick: onClick }))} />
      </ReactFlowProvider>,
    )
    fireEvent.click(screen.getByTestId('canvas-qbadge-a1'))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onClick).toHaveBeenCalledWith('a1')
  })

  test('stops propagation so the click does NOT also select the node behind it', () => {
    const onClick = vi.fn()
    const parentClick = vi.fn()
    render(
      <ReactFlowProvider>
        {/* The wrapper stands in for the xyflow node-click selection surface;
            stopPropagation must keep the badge click from bubbling to it. */}
        <div onClick={parentClick}>
          <AgentNode
            {...nodeProps(agentData({ questionCount: 1, onQuestionBadgeClick: onClick }))}
          />
        </div>
      </ReactFlowProvider>,
    )
    fireEvent.click(screen.getByTestId('canvas-qbadge-a1'))
    expect(onClick).toHaveBeenCalledWith('a1')
    expect(parentClick).not.toHaveBeenCalled()
  })
})
