import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { NodeInspector } from '../src/components/canvas/NodeInspector'

function Host({ onChangeSpy }: { onChangeSpy: (def: WorkflowDefinition) => void }) {
  const [definition, setDefinition] = useState<WorkflowDefinition>({
    $schema_version: 6,
    inputs: [],
    nodes: [
      { id: 'source', kind: 'agent-single', agentName: 'writer' } as unknown as WorkflowNode,
      {
        id: 'review',
        kind: 'review',
        rerunnableOnReject: ['source'],
        rerunnableOnIterate: [],
      } as unknown as WorkflowNode,
    ],
    // RFC-354: the review input is its `__review_input__` edge.
    edges: [
      {
        id: 'review-in',
        source: { nodeId: 'source', portName: 'document' },
        target: { nodeId: 'review', portName: '__review_input__' },
      },
    ],
  })
  return (
    <NodeInspector
      definition={definition}
      selectedNodeId="review"
      agents={[]}
      onChange={(next) => {
        setDefinition(next)
        onChangeSpy(next)
      }}
      onClose={() => {}}
    />
  )
}

describe('review inspector list editors', () => {
  test('rerunnable node ids commit from the searchable workflow-node selector', () => {
    const spy = vi.fn()
    render(<Host onChangeSpy={spy} />)

    const input = screen.getByTestId('review-rerun-iterate')
    fireEvent.focus(input)
    fireEvent.mouseDown(screen.getByRole('option', { name: 'writer (source)' }))

    const next = spy.mock.calls.at(-1)?.[0] as WorkflowDefinition
    const review = next.nodes.find((node) => node.id === 'review') as unknown as Record<
      string,
      unknown
    >
    expect(review.rerunnableOnIterate).toEqual(['source'])
    expect(screen.getAllByText('writer (source)').length).toBeGreaterThan(0)
  })
})
