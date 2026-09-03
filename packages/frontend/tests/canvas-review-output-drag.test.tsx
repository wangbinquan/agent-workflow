// RFC-007 → RFC-354 (schema v6) — integration coverage for the review /
// output inspectors on top of the edge-only model.
//
// We can't simulate xyflow's drag-and-drop in JSDOM, so the connect path
// itself is exercised by the pure-function suite (connection-sync.test.ts).
// What this file locks in is the user-facing surface area that DOES render
// in JSDOM:
//   - the review inspector shows the source of the `__review_input__` edge
//     (or the "not wired" hint) and its Disconnect button drops that edge —
//     there is no second, form-side way to pick the source any more
//   - the output inspector lists one row per inbound edge and Remove drops
//     that edge (the port IS the edge)
//   - deleting a review / output edge in the EdgeInspector leaves no stale
//     node field behind and the load boundary does not resurrect the edge
//   - ReviewNode renders the `__review_input__` Handle so xyflow has
//     somewhere to land an inbound connection
//
// Reference: design/RFC-007-canvas-review-output-drag/design.md §8.2,
//            design/RFC-354-*/design.md (D10: every PortRef is an edge).

import { render, fireEvent, screen, cleanup } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { useState } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import type { Agent, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { EdgeInspector } from '../src/components/canvas/EdgeInspector'
import { NodeInspector } from '../src/components/canvas/NodeInspector'
import { ReviewNode } from '../src/components/canvas/nodes/ReviewNode'
import { REVIEW_INPUT_HANDLE_ID } from '../src/components/canvas/connectionSync'
import { healLoadedDefinition } from '../src/routes/workflows.edit'
import i18n from '../src/i18n'

afterEach(() => {
  // Unmount via testing-library first — the Select listbox is portaled to
  // document.body, so wiping innerHTML before cleanup() races React's
  // removeChild and crashes happy-dom.
  cleanup()
})

const STUB_AGENT: Agent = {
  id: 'agent-stub',
  name: 'stub',
  description: '',
  outputs: ['design', 'audit'],
  outputKinds: { design: 'markdown', audit: 'markdown' },
  syncOutputsOnIterate: true,
  permission: {},
  skills: [],
  dependsOn: [],
  mcp: [],
  plugins: [],
  frontmatterExtra: {},
  bodyMd: '',
  schemaVersion: 1,
  createdAt: 0,
  updatedAt: 0,
}

function agentNode(): WorkflowNode {
  return {
    id: 'a',
    kind: 'agent-single',
    agentId: STUB_AGENT.id,
    agentName: 'stub',
  } as unknown as WorkflowNode
}

function makeReviewDef(wired: boolean): WorkflowDefinition {
  return {
    $schema_version: 6,
    inputs: [],
    nodes: [agentNode(), { id: 'r', kind: 'review' } as unknown as WorkflowNode],
    edges: wired
      ? [
          {
            id: 'e1',
            source: { nodeId: 'a', portName: 'design' },
            target: { nodeId: 'r', portName: REVIEW_INPUT_HANDLE_ID },
          },
        ]
      : [],
  }
}

function makeOutputDef(): WorkflowDefinition {
  return {
    $schema_version: 6,
    inputs: [],
    nodes: [agentNode(), { id: 'o', kind: 'output' } as unknown as WorkflowNode],
    edges: [
      {
        id: 'e1',
        source: { nodeId: 'a', portName: 'design' },
        target: { nodeId: 'o', portName: 'final_doc' },
      },
      {
        id: 'e2',
        source: { nodeId: 'a', portName: 'audit' },
        target: { nodeId: 'o', portName: 'audit_report' },
      },
    ],
  }
}

function Host({
  initialDef,
  selectedNodeId,
  onChangeSpy,
}: {
  initialDef: WorkflowDefinition
  selectedNodeId: string
  onChangeSpy: (def: WorkflowDefinition) => void
}) {
  const [def, setDef] = useState(initialDef)
  return (
    <I18nextProvider i18n={i18n}>
      <NodeInspector
        definition={def}
        selectedNodeId={selectedNodeId}
        agents={[STUB_AGENT]}
        onChange={(next) => {
          setDef(next)
          onChangeSpy(next)
        }}
        onClose={() => {}}
      />
    </I18nextProvider>
  )
}

function nodeRecord(def: WorkflowDefinition, id: string): Record<string, unknown> {
  return def.nodes.find((n) => n.id === id) as unknown as Record<string, unknown>
}

describe('Review NodeInspector — RFC-354 edge-derived source', () => {
  test('unwired review shows the not-wired hint and offers no source picker', () => {
    render(<Host initialDef={makeReviewDef(false)} selectedNodeId="r" onChangeSpy={vi.fn()} />)
    expect(screen.getByTestId('review-source-unwired')).toBeTruthy()
    expect(screen.queryByTestId('review-source-summary')).toBeNull()
    expect(screen.queryByTestId('review-source-node')).toBeNull()
  })

  test('wired review shows the edge source (title · port · kind)', () => {
    render(<Host initialDef={makeReviewDef(true)} selectedNodeId="r" onChangeSpy={vi.fn()} />)
    const summary = screen.getByTestId('review-source-summary')
    expect(summary.textContent).toContain('stub')
    expect(summary.textContent).toContain('design')
    expect(summary.textContent).toContain('markdown')
  })

  test('Disconnect drops the __review_input__ edge and writes no node field', () => {
    const spy = vi.fn()
    render(<Host initialDef={makeReviewDef(true)} selectedNodeId="r" onChangeSpy={spy} />)
    fireEvent.click(screen.getByTestId('review-source-disconnect'))
    expect(spy).toHaveBeenCalled()
    const last = spy.mock.calls[spy.mock.calls.length - 1]![0] as WorkflowDefinition
    expect(last.edges).toHaveLength(0)
    expect('inputSource' in nodeRecord(last, 'r')).toBe(false)
    expect(screen.getByTestId('review-source-unwired')).toBeTruthy()
  })
})

describe('Output NodeInspector — RFC-354 ports are inbound edges', () => {
  test('lists one row per inbound edge, named by the edge target port', () => {
    render(<Host initialDef={makeOutputDef()} selectedNodeId="o" onChangeSpy={vi.fn()} />)
    const rows = screen.getByTestId('output-ports').querySelectorAll('li')
    expect(rows.length).toBe(2)
    expect(rows[0]!.textContent).toContain('final_doc')
    expect(rows[0]!.textContent).toContain('design')
    expect(rows[1]!.textContent).toContain('audit_report')
    // No port editor left: nothing to type a name or pick an upstream into.
    expect(screen.queryByRole('combobox', { name: 'upstream nodeId' })).toBeNull()
  })

  test('removing a port row → drops the corresponding edge only', () => {
    const spy = vi.fn()
    render(<Host initialDef={makeOutputDef()} selectedNodeId="o" onChangeSpy={spy} />)
    const removeButtons = screen.getAllByRole('button', { name: /remove|移除/i })
    fireEvent.click(removeButtons[0]!)
    const last = spy.mock.calls[spy.mock.calls.length - 1]![0] as WorkflowDefinition
    expect(last.edges.map((edge) => edge.id)).toEqual(['e2'])
    expect('ports' in nodeRecord(last, 'o')).toBe(false)
  })

  test('an output with no inbound edge shows the empty hint', () => {
    render(
      <Host
        initialDef={{ ...makeOutputDef(), edges: [] }}
        selectedNodeId="o"
        onChangeSpy={vi.fn()}
      />,
    )
    expect(screen.getByTestId('output-ports-empty')).toBeTruthy()
  })
})

describe('EdgeInspector — RFC-007 delete sync', () => {
  // Regression for "edge gets deleted then ~2s later reappears": before
  // this fix EdgeInspector.remove() bypassed WorkflowCanvas.commitChange,
  // so the v5 mirror stayed populated and the load-time heal re-materialized
  // the edge. RFC-354 removed the mirror altogether; the load boundary now
  // only upgrades the schema, so a deleted edge stays deleted.
  test('deleting a review inbound edge leaves no node field behind (no resurrection on load)', () => {
    const def = makeReviewDef(true)
    const spy = vi.fn()
    function EdgeHost() {
      const [d, setD] = useState(def)
      const edge = d.edges.find((e) => e.id === 'e1')
      if (edge === undefined) return null
      return (
        <I18nextProvider i18n={i18n}>
          <EdgeInspector
            edge={edge}
            definition={d}
            onChange={(next) => {
              setD(next)
              spy(next)
            }}
            onClose={() => {}}
          />
        </I18nextProvider>
      )
    }
    render(<EdgeHost />)
    fireEvent.click(screen.getByRole('button', { name: /delete|删除/i }))
    expect(spy).toHaveBeenCalled()
    const afterDelete = spy.mock.calls[spy.mock.calls.length - 1]![0] as WorkflowDefinition
    expect(afterDelete.edges).toHaveLength(0)
    expect('inputSource' in nodeRecord(afterDelete, 'r')).toBe(false)
    expect(healLoadedDefinition(afterDelete).edges).toHaveLength(0)
  })

  test('deleting an output inbound edge drops that port only', () => {
    const def = makeOutputDef()
    const spy = vi.fn()
    function EdgeHost() {
      const [d, setD] = useState(def)
      const edge = d.edges.find((e) => e.id === 'e1')
      if (edge === undefined) return null
      return (
        <I18nextProvider i18n={i18n}>
          <EdgeInspector
            edge={edge}
            definition={d}
            onChange={(next) => {
              setD(next)
              spy(next)
            }}
            onClose={() => {}}
          />
        </I18nextProvider>
      )
    }
    render(<EdgeHost />)
    fireEvent.click(screen.getByRole('button', { name: /delete|删除/i }))
    const afterDelete = spy.mock.calls[spy.mock.calls.length - 1]![0] as WorkflowDefinition
    expect(afterDelete.edges.map((edge) => edge.target.portName)).toEqual(['audit_report'])
    expect('ports' in nodeRecord(afterDelete, 'o')).toBe(false)
    expect(healLoadedDefinition(afterDelete).edges).toHaveLength(1) // no resurrection
  })
})

describe('ReviewNode — RFC-007 left target Handle', () => {
  test('renders a Handle with id = __review_input__', () => {
    // xyflow's NodeProps shape varies across versions; bypass strict typing
    // here to keep this test focused on the rendered DOM contract.
    const props = {
      id: 'r',
      type: 'review',
      data: {
        nodeId: 'r',
        kind: 'review' as const,
        title: 'review-target',
        inputPorts: [],
        outputPorts: ['approved_doc', 'approval_meta'],
      },
      selected: false,
      dragging: false,
      isConnectable: true,
      positionAbsoluteX: 0,
      positionAbsoluteY: 0,
      zIndex: 0,
    }
    render(
      <ReactFlowProvider>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <ReviewNode {...(props as any)} />
      </ReactFlowProvider>,
    )
    const handles = document.querySelectorAll('.react-flow__handle')
    const reviewInput = Array.from(handles).find(
      (h) => h.getAttribute('data-handleid') === REVIEW_INPUT_HANDLE_ID,
    )
    expect(reviewInput).toBeDefined()
    expect(reviewInput!.getAttribute('aria-label')).toBe('review-input')
  })

  test('card summary reads the edge-derived reviewSource slot', () => {
    const props = {
      id: 'r',
      type: 'review',
      data: {
        surface: 'task',
        nodeId: 'r',
        kind: 'review' as const,
        title: 'review-target',
        inputPorts: [],
        outputPorts: ['approved_doc', 'approval_meta'],
        reviewSource: { nodeId: 'writer', portName: 'draft' },
      },
      selected: false,
      dragging: false,
      isConnectable: true,
      positionAbsoluteX: 0,
      positionAbsoluteY: 0,
      zIndex: 0,
    }
    render(
      <ReactFlowProvider>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <ReviewNode {...(props as any)} />
      </ReactFlowProvider>,
    )
    const root = document.querySelector('.canvas-node--review') as HTMLElement
    expect(root.getAttribute('data-review-input-state')).toBe('configured')
    expect(root.textContent).toContain('writer')
    expect(root.textContent).toContain('draft')
  })

  // Regression: review node_run becomes `done` after approval, but the
  // ReviewNode root previously did not render the `data-status` attribute
  // that drives `.canvas-node[data-status='done']` → green border. So
  // approved review nodes stayed gray on the task-detail canvas. Mirrors
  // the same attribute on AgentNode / WrapperNodes.
  test('root carries data-status from data.status (so approved reviews go green)', () => {
    const props = {
      id: 'r',
      type: 'review',
      data: {
        nodeId: 'r',
        kind: 'review' as const,
        title: 'review-target',
        inputPorts: [],
        outputPorts: ['approved_doc', 'approval_meta'],
        status: 'done' as const,
      },
      selected: false,
      dragging: false,
      isConnectable: true,
      positionAbsoluteX: 0,
      positionAbsoluteY: 0,
      zIndex: 0,
    }
    render(
      <ReactFlowProvider>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <ReviewNode {...(props as any)} />
      </ReactFlowProvider>,
    )
    const root = document.querySelector('.canvas-node--review') as HTMLElement | null
    expect(root).not.toBeNull()
    expect(root!.getAttribute('data-status')).toBe('done')
  })

  test('root falls back to data-status="default" when no status is provided', () => {
    const props = {
      id: 'r',
      type: 'review',
      data: {
        nodeId: 'r',
        kind: 'review' as const,
        title: 'review-target',
        inputPorts: [],
        outputPorts: ['approved_doc', 'approval_meta'],
      },
      selected: false,
      dragging: false,
      isConnectable: true,
      positionAbsoluteX: 0,
      positionAbsoluteY: 0,
      zIndex: 0,
    }
    render(
      <ReactFlowProvider>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <ReviewNode {...(props as any)} />
      </ReactFlowProvider>,
    )
    const root = document.querySelector('.canvas-node--review') as HTMLElement | null
    expect(root).not.toBeNull()
    expect(root!.getAttribute('data-status')).toBe('default')
  })
})
