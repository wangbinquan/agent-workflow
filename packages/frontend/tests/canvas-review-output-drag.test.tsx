// RFC-007 — integration coverage for the "field ↔ edge double-bookkeeping"
// the canvas now performs when the user wires a review / output node.
//
// We can't simulate xyflow's drag-and-drop in JSDOM, so the connect path
// itself is exercised by the pure-function suite (connection-sync.test.ts).
// What this file locks in is the user-facing surface area that DOES render
// in JSDOM:
//   - NodeInspector typing into inputSource (review) / port.bind (output)
//     produces the matching edge in `definition.edges`
//   - removing an output port via the Remove button drops the edge
//   - ReviewNode renders the new __review_input__ Handle so xyflow has
//     somewhere to land an inbound connection
//
// Reference: design/RFC-007-canvas-review-output-drag/design.md §8.2.

import { render, fireEvent, screen, cleanup, within } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { useState } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import type { Agent, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { EdgeInspector } from '../src/components/canvas/EdgeInspector'
import { NodeInspector } from '../src/components/canvas/NodeInspector'
import { ReviewNode } from '../src/components/canvas/nodes/ReviewNode'
import {
  healFieldEdgeConsistency,
  REVIEW_INPUT_HANDLE_ID,
} from '../src/components/canvas/connectionSync'
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
  outputs: ['design'],
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

function pickSelect(trigger: HTMLElement, label: string): void {
  fireEvent.click(trigger)
  fireEvent.mouseDown(within(screen.getByRole('listbox')).getByText(label))
}

function makeReviewDef(inputSource = { nodeId: '', portName: '' }): WorkflowDefinition {
  return {
    $schema_version: 2,
    inputs: [],
    nodes: [
      { id: 'a', kind: 'agent-single', agentName: 'stub' } as unknown as WorkflowNode,
      { id: 'r', kind: 'review', inputSource } as unknown as WorkflowNode,
    ],
    edges: [],
  }
}

function makeOutputDef(): WorkflowDefinition {
  return {
    $schema_version: 2,
    inputs: [],
    nodes: [
      { id: 'a', kind: 'agent-single', agentName: 'stub' } as unknown as WorkflowNode,
      {
        id: 'o',
        kind: 'output',
        ports: [
          { name: 'final_doc', bind: { nodeId: '', portName: '' } },
          { name: 'audit_report', bind: { nodeId: '', portName: '' } },
        ],
      } as unknown as WorkflowNode,
    ],
    edges: [],
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

describe('Review NodeInspector — RFC-007 form ↔ edge sync', () => {
  test('selecting inputSource.portName → adds matching edge to definition.edges', () => {
    const spy = vi.fn()
    render(
      <Host
        initialDef={makeReviewDef({ nodeId: 'a', portName: '' })}
        selectedNodeId="r"
        onChangeSpy={spy}
      />,
    )
    // RFC-199 migrated the editable node/port ids to searchable selectors.
    // Pick the declared port — both halves are now non-empty, so an edge
    // should materialize through the single transition path.
    pickSelect(screen.getByRole('combobox', { name: 'Source port' }), 'design')
    expect(spy).toHaveBeenCalled()
    const last = spy.mock.calls[spy.mock.calls.length - 1]![0] as WorkflowDefinition
    expect(last.edges).toHaveLength(1)
    const edge = last.edges[0]!
    expect(edge.source).toEqual({ nodeId: 'a', portName: 'design' })
    expect(edge.target).toEqual({ nodeId: 'r', portName: REVIEW_INPUT_HANDLE_ID })
    // The field itself is also updated (it's how we know the form path ran).
    const r = last.nodes.find((n) => n.id === 'r')! as unknown as {
      inputSource: { nodeId: string; portName: string }
    }
    expect(r.inputSource).toEqual({ nodeId: 'a', portName: 'design' })
  })

  test('clearing inputSource via the upstream <select> → drops the edge', () => {
    const spy = vi.fn()
    const def = makeReviewDef({ nodeId: 'a', portName: 'design' })
    // Seed an existing review-input edge to mirror the post-drag state.
    def.edges = [
      {
        id: 'e1',
        source: { nodeId: 'a', portName: 'design' },
        target: { nodeId: 'r', portName: REVIEW_INPUT_HANDLE_ID },
      },
    ]
    render(<Host initialDef={def} selectedNodeId="r" onChangeSpy={spy} />)
    // The upstream nodeId picker is the shared <Select>; clearing = picking
    // the leading "—" (empty) option from its portaled listbox.
    const upstream = screen.getByRole('combobox', { name: 'Source node' })
    pickSelect(upstream, '—')
    expect(spy).toHaveBeenCalled()
    const last = spy.mock.calls[spy.mock.calls.length - 1]![0] as WorkflowDefinition
    expect(last.edges).toHaveLength(0)
  })
})

describe('Output NodeInspector — RFC-007 form ↔ edge sync', () => {
  test('selecting a port.bind → adds matching edge', () => {
    const spy = vi.fn()
    render(<Host initialDef={makeOutputDef()} selectedNodeId="o" onChangeSpy={spy} />)
    // Each row now has searchable upstream-node and port selectors. Target
    // the first row (final_doc) and choose the agent's declared output.
    const upstreams = screen.getAllByRole('combobox', { name: 'upstream nodeId' })
    pickSelect(upstreams[0]!, 'stub (a)')
    const ports = screen.getAllByRole('combobox', { name: 'port' })
    pickSelect(ports[0]!, 'design')
    const last = spy.mock.calls[spy.mock.calls.length - 1]![0] as WorkflowDefinition
    expect(last.edges).toHaveLength(1)
    const edge = last.edges[0]!
    expect(edge.source).toEqual({ nodeId: 'a', portName: 'design' })
    expect(edge.target).toEqual({ nodeId: 'o', portName: 'final_doc' })
    // The other port stays empty — no second edge.
    expect(last.edges).toHaveLength(1)
  })

  test('removing a bound port → drops the corresponding edge', () => {
    const spy = vi.fn()
    const def = makeOutputDef()
    // Pre-bind the first port and seed the matching edge.
    ;(
      def.nodes[1] as unknown as {
        ports: Array<{ name: string; bind: { nodeId: string; portName: string } }>
      }
    ).ports[0]!.bind = { nodeId: 'a', portName: 'design' }
    def.edges = [
      {
        id: 'e1',
        source: { nodeId: 'a', portName: 'design' },
        target: { nodeId: 'o', portName: 'final_doc' },
      },
    ]
    render(<Host initialDef={def} selectedNodeId="o" onChangeSpy={spy} />)
    // Click the first Remove button (the per-port delete in the table).
    const removeButtons = screen.getAllByRole('button', { name: /remove|删除/i })
    fireEvent.click(removeButtons[0]!)
    const last = spy.mock.calls[spy.mock.calls.length - 1]![0] as WorkflowDefinition
    expect(last.edges).toHaveLength(0)
  })
})

describe('EdgeInspector — RFC-007 delete sync', () => {
  // Regression for "edge gets deleted then ~2s later reappears": before
  // this fix EdgeInspector.remove() bypassed WorkflowCanvas.commitChange,
  // so `review.inputSource` / `output.ports[].bind` stayed populated. The
  // auto-save round-trip then refetched the workflow, healLoadedDefinition
  // ran its bi-directional heal, saw "field has value but no matching
  // edge" and dutifully re-materialized the edge.
  test('deleting a review inbound edge also clears inputSource (no resurrection on heal)', () => {
    const def: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [],
      nodes: [
        { id: 'a', kind: 'agent-single', agentName: 'stub' } as unknown as WorkflowNode,
        {
          id: 'r',
          kind: 'review',
          inputSource: { nodeId: 'a', portName: 'design' },
        } as unknown as WorkflowNode,
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'a', portName: 'design' },
          target: { nodeId: 'r', portName: REVIEW_INPUT_HANDLE_ID },
        },
      ],
    }
    const spy = vi.fn()
    function Host() {
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
    render(<Host />)
    fireEvent.click(screen.getByRole('button', { name: /delete|删除/i }))
    expect(spy).toHaveBeenCalled()
    const afterDelete = spy.mock.calls[spy.mock.calls.length - 1]![0] as WorkflowDefinition
    expect(afterDelete.edges).toHaveLength(0)
    const r = afterDelete.nodes.find((n) => n.id === 'r')! as unknown as {
      inputSource: { nodeId: string; portName: string }
    }
    expect(r.inputSource).toEqual({ nodeId: '', portName: '' })
    // Run the same heal pass the post-save refetch would: the edge must
    // NOT come back because the field is already cleared.
    const healed = healFieldEdgeConsistency(afterDelete)
    expect(healed.edges).toHaveLength(0)
  })

  test('deleting an output inbound edge also clears that port.bind', () => {
    const def: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [],
      nodes: [
        { id: 'a', kind: 'agent-single', agentName: 'stub' } as unknown as WorkflowNode,
        {
          id: 'o',
          kind: 'output',
          ports: [
            { name: 'final_doc', bind: { nodeId: 'a', portName: 'design' } },
            { name: 'audit_report', bind: { nodeId: 'a', portName: 'audit' } },
          ],
        } as unknown as WorkflowNode,
      ],
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
    const spy = vi.fn()
    function Host() {
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
    render(<Host />)
    fireEvent.click(screen.getByRole('button', { name: /delete|删除/i }))
    const afterDelete = spy.mock.calls[spy.mock.calls.length - 1]![0] as WorkflowDefinition
    expect(afterDelete.edges).toHaveLength(1)
    const o = afterDelete.nodes.find((n) => n.id === 'o')! as unknown as {
      ports: Array<{ name: string; bind: { nodeId: string; portName: string } }>
    }
    // Only the deleted edge's port had bind cleared; the other survives.
    expect(o.ports[0]?.bind).toEqual({ nodeId: '', portName: '' })
    expect(o.ports[1]?.bind).toEqual({ nodeId: 'a', portName: 'audit' })
    const healed = healFieldEdgeConsistency(afterDelete)
    expect(healed.edges).toHaveLength(1) // no resurrection
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
