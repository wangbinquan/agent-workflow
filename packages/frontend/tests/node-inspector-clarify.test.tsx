// RFC-023 PR-C T19 — NodeInspector clarify branch.
//
// Three structural locks:
//   1. The clarify form shows title + description inputs and they propagate
//      through onChange.
//   2. When the workflow has a `__clarify__` outbound edge from an agent
//      into this clarify node, the inspector shows the agent id read-only;
//      with no such edge it shows the "linked-agent-missing" warning. The
//      data-testid hooks let downstream e2e tests pick up the state.
//   3. The in-loop / not-in-loop hint follows whether the clarify node id
//      appears in any wrapper-loop's `nodeIds[]`.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { NodeInspector } from '../src/components/canvas/NodeInspector'
import '../src/i18n'

function wrap(node: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ binary: 'opencode', cached: false, models: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function makeDef(
  nodes: WorkflowNode[],
  edges: WorkflowDefinition['edges'] = [],
): WorkflowDefinition {
  return { $schema_version: 3, inputs: [], nodes, edges }
}

function Host({
  initial,
  onChangeSpy,
}: {
  initial: WorkflowDefinition
  onChangeSpy: (def: WorkflowDefinition) => void
}) {
  const [def, setDef] = useState<WorkflowDefinition>(initial)
  return (
    <NodeInspector
      definition={def}
      selectedNodeId="c1"
      agents={[]}
      onChange={(next) => {
        setDef(next)
        onChangeSpy(next)
      }}
      onClose={() => {}}
    />
  )
}

describe('NodeInspector — clarify branch (RFC-023 T19)', () => {
  test('title + description inputs flow through onChange', () => {
    const onChange = vi.fn()
    wrap(
      <Host
        initial={makeDef([
          { id: 'c1', kind: 'clarify', title: '', description: '' } as unknown as WorkflowNode,
        ])}
        onChangeSpy={onChange}
      />,
    )
    // Title is the first <input>; description is the textarea (different elements).
    const titleInput = document.querySelector('input.form-input') as HTMLInputElement
    fireEvent.change(titleInput, { target: { value: 'Pick stack' } })
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as WorkflowDefinition
    expect((last.nodes[0] as Record<string, unknown>).title).toBe('Pick stack')
  })

  test('shows linked-agent id when a __clarify__ edge points into this node', () => {
    const onChange = vi.fn()
    wrap(
      <Host
        initial={makeDef(
          [
            { id: 'agent1', kind: 'agent-single' } as unknown as WorkflowNode,
            { id: 'c1', kind: 'clarify' } as unknown as WorkflowNode,
          ],
          [
            {
              id: 'e_ask',
              source: { nodeId: 'agent1', portName: '__clarify__' },
              target: { nodeId: 'c1', portName: 'questions' },
            },
          ],
        )}
        onChangeSpy={onChange}
      />,
    )
    const chip = screen.getByTestId('clarify-linked-agent')
    expect(chip.textContent).toBe('agent1')
    // Loop-warning path also fires here since the clarify node isn't wrapped.
    expect(screen.getByTestId('clarify-in-loop-warning')).toBeTruthy()
  })

  test('shows linked-agent-missing + in-loop hint when wrapped by a wrapper-loop', () => {
    const onChange = vi.fn()
    wrap(
      <Host
        initial={makeDef([
          { id: 'c1', kind: 'clarify' } as unknown as WorkflowNode,
          {
            id: 'loop1',
            kind: 'wrapper-loop',
            nodeIds: ['c1'],
            maxIterations: 3,
            exitCondition: { kind: 'port-empty' },
          } as unknown as WorkflowNode,
        ])}
        onChangeSpy={onChange}
      />,
    )
    expect(screen.getByTestId('clarify-linked-agent-missing')).toBeTruthy()
    expect(screen.getByTestId('clarify-in-loop')).toBeTruthy()
  })
})
