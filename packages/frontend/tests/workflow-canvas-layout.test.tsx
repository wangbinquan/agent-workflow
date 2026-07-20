import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import type { ReactFlowInstance } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const xyflowHarness = vi.hoisted(() => ({ fitView: vi.fn(async () => true) }))

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<
    Record<string, unknown> & { useReactFlow: () => ReactFlowInstance }
  >()
  return {
    ...actual,
    useReactFlow: () => ({ ...actual.useReactFlow(), fitView: xyflowHarness.fitView }),
  }
})

import { WorkflowCanvas } from '../src/components/canvas/WorkflowCanvas'
import i18n from '../src/i18n'

function agentNode(id: string, x: number): WorkflowNode {
  return {
    id,
    kind: 'agent-single',
    agentName: id,
    position: { x, y: 80 },
  } as WorkflowNode
}

const definition: WorkflowDefinition = {
  $schema_version: 4,
  inputs: [],
  nodes: [agentNode('a', 600), agentNode('b', 0)],
  edges: [
    {
      id: 'a-to-b',
      source: { nodeId: 'a', portName: 'out' },
      target: { nodeId: 'b', portName: 'input' },
    },
  ],
}

beforeEach(() => {
  xyflowHarness.fitView.mockClear()
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callback(0)
    return 1
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RFC-199 canvas auto-layout adapter', () => {
  test('whole-graph layout is one semantic history transaction, preserves graph data, and fits view', async () => {
    const onChange = vi.fn()
    const { getByTestId } = render(
      <I18nextProvider i18n={i18n}>
        <WorkflowCanvas surface="editor" definition={definition} onChange={onChange} />
      </I18nextProvider>,
    )

    expect(getByTestId('workflow-layout-selection')).toHaveProperty('disabled', true)
    fireEvent.click(getByTestId('workflow-layout-all'))

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))
    const [next, meta] = onChange.mock.calls[0] as [
      WorkflowDefinition,
      { label: string; selectionBefore: null; selectionAfter: null },
    ]
    expect(next.edges).toEqual(definition.edges)
    expect(next.nodes.map(({ id, kind, agentName }) => ({ id, kind, agentName }))).toEqual(
      definition.nodes.map(({ id, kind, agentName }) => ({ id, kind, agentName })),
    )
    expect(next.nodes.find((node) => node.id === 'a')!.position!.x).toBeLessThan(
      next.nodes.find((node) => node.id === 'b')!.position!.x,
    )
    expect(meta.label).toMatch(/Auto-layout workflow|自动整理工作流/)
    expect(meta.selectionBefore).toBeNull()
    expect(meta.selectionAfter).toBeNull()
    expect(xyflowHarness.fitView).toHaveBeenCalledTimes(1)
  })

  test('read-only consumers do not expose layout mutation controls', () => {
    const { queryByTestId } = render(
      <I18nextProvider i18n={i18n}>
        <WorkflowCanvas surface="task" definition={definition} readOnly />
      </I18nextProvider>,
    )
    expect(queryByTestId('workflow-layout-all')).toBeNull()
    expect(queryByTestId('workflow-layout-selection')).toBeNull()
  })
})
