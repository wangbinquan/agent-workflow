// RFC-122 — on-canvas per-(task, asking-node) clarify directive toggle
// ("继续反问 / 停止反问").
//
// Locks:
//   1. toFlowNodes stamps data.clarifyDirective ONLY on asking-agent nodes
//      (isClarifyAskingNode — a __clarify__ source edge), defaulting to
//      'continue', and stamps NOTHING when no directives map is passed
//      (golden-lock: a canvas with no directives is byte-for-byte unchanged).
//      The clarify / cross channel nodes and plain agents get nothing.
//   2. AgentNode renders the segmented toggle iff data.clarifyDirective is set,
//      with the current half active.
//   3. Clicking the inactive half calls onClarifyDirectiveToggle(nodeId, next)
//      and stops propagation; clicking the active half is a no-op.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { AgentNode } from '../src/components/canvas/nodes/AgentNode'
import type { CanvasNodeData } from '../src/components/canvas/nodes/types'
import { __testToFlowNodes as toFlowNodes } from '../src/components/canvas/WorkflowCanvas'
import type { WorkflowEdge } from '@agent-workflow/shared'
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
    surface: 'task',
    nodeId: 'a1',
    kind: 'agent-single',
    title: 'coder',
    inputPorts: [],
    outputPorts: [],
    ...over,
  }
}

// selfAgent has a self-clarify channel; clar is the channel node; plain is a
// plain agent. Only selfAgent is an asking node.
const NODES = [
  { id: 'selfAgent', kind: 'agent-single' as const },
  { id: 'clar', kind: 'clarify' as const },
  { id: 'plain', kind: 'agent-single' as const },
]
const EDGES: WorkflowEdge[] = [
  {
    id: 'e1',
    source: { nodeId: 'selfAgent', portName: '__clarify__' },
    target: { nodeId: 'clar', portName: 'questions' },
  },
]
function byId(flow: ReturnType<typeof toFlowNodes>, id: string): CanvasNodeData {
  return flow.find((n) => n.id === id)!.data as CanvasNodeData
}

describe('toFlowNodes clarify-directive propagation (golden-lock)', () => {
  test('stamps clarifyDirective only on asking nodes; default continue', () => {
    const onToggle = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flow = toFlowNodes(NODES as any, [], EDGES, undefined, undefined, undefined, {}, onToggle)
    expect(byId(flow, 'selfAgent').clarifyDirective).toBe('continue')
    expect(byId(flow, 'selfAgent').onClarifyDirectiveToggle).toBe(onToggle)
    // The channel node and the plain agent get nothing.
    expect(byId(flow, 'clar').clarifyDirective).toBeUndefined()
    expect(byId(flow, 'plain').clarifyDirective).toBeUndefined()
  })

  test('reflects the stored directive for the asking node', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flow = toFlowNodes(NODES as any, [], EDGES, undefined, undefined, undefined, {
      selfAgent: 'stop',
    })
    expect(byId(flow, 'selfAgent').clarifyDirective).toBe('stop')
  })

  test('omits clarifyDirective entirely when no directives map is supplied (byte-for-byte)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flow = toFlowNodes(NODES as any, [], EDGES)
    expect(byId(flow, 'selfAgent').clarifyDirective).toBeUndefined()
    expect(byId(flow, 'selfAgent').onClarifyDirectiveToggle).toBeUndefined()
  })
})

describe('ClarifyDirectiveToggle render', () => {
  test('AgentNode renders the toggle with the current half active', () => {
    render(
      <ReactFlowProvider>
        <AgentNode {...nodeProps(agentData({ clarifyDirective: 'continue' }))} />
      </ReactFlowProvider>,
    )
    const group = screen.getByTestId('canvas-clarify-directive-a1')
    expect(group).toBeTruthy()
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(2)
    const cont = radios.find((r) => r.getAttribute('data-directive') === 'continue')!
    const stop = radios.find((r) => r.getAttribute('data-directive') === 'stop')!
    expect(cont.getAttribute('aria-checked')).toBe('true')
    expect(stop.getAttribute('aria-checked')).toBe('false')
  })

  test('AgentNode renders NO toggle when clarifyDirective is undefined', () => {
    render(
      <ReactFlowProvider>
        <AgentNode {...nodeProps(agentData())} />
      </ReactFlowProvider>,
    )
    expect(screen.queryByTestId('canvas-clarify-directive-a1')).toBeNull()
  })
})

describe('ClarifyDirectiveToggle click', () => {
  test('clicking the inactive half POSTs the new directive; active half is a no-op', () => {
    const onToggle = vi.fn()
    render(
      <ReactFlowProvider>
        <AgentNode
          {...nodeProps(
            agentData({ clarifyDirective: 'continue', onClarifyDirectiveToggle: onToggle }),
          )}
        />
      </ReactFlowProvider>,
    )
    const radios = screen.getAllByRole('radio')
    const stop = radios.find((r) => r.getAttribute('data-directive') === 'stop')!
    const cont = radios.find((r) => r.getAttribute('data-directive') === 'continue')!
    fireEvent.click(stop)
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith('a1', 'stop')
    // Clicking the already-active half does nothing.
    fireEvent.click(cont)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  test('stops propagation so the click does NOT also select the node behind it', () => {
    const onToggle = vi.fn()
    const parentClick = vi.fn()
    render(
      <ReactFlowProvider>
        <div onClick={parentClick}>
          <AgentNode
            {...nodeProps(
              agentData({ clarifyDirective: 'continue', onClarifyDirectiveToggle: onToggle }),
            )}
          />
        </div>
      </ReactFlowProvider>,
    )
    const stop = screen
      .getAllByRole('radio')
      .find((r) => r.getAttribute('data-directive') === 'stop')!
    fireEvent.click(stop)
    expect(onToggle).toHaveBeenCalledWith('a1', 'stop')
    expect(parentClick).not.toHaveBeenCalled()
  })
})
