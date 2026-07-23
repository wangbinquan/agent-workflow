import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Agent, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { REVIEW_INPUT_PORT_NAME } from '@agent-workflow/shared'
import { ConnectionDialog } from '../src/components/workflow-editor/ConnectionDialog'
import { ManagedLiveRegionProvider } from '../src/components/ManagedLiveRegion'
import { createWorkflowSemanticContext } from '../src/lib/workflow-connection-plan'
import { applyWorkflowTransition } from '../src/lib/workflow-transition'
import i18n from '../src/i18n'

function agentNode(id: string, agentName = id): WorkflowNode {
  return {
    id,
    kind: 'agent-single',
    agentId: `a-${agentName}`,
    agentName,
    position: { x: 0, y: 0 },
  } as WorkflowNode
}

const definition: WorkflowDefinition = {
  $schema_version: 4,
  inputs: [],
  nodes: [
    agentNode('source'),
    agentNode('target'),
    {
      id: 'review',
      kind: 'review',
      inputSource: { nodeId: '', portName: '' },
      position: { x: 0, y: 0 },
    } as WorkflowNode,
  ],
  edges: [],
}

const agents = [
  {
    id: 'a-source',
    name: 'source',
    outputs: ['doc'],
    outputKinds: { doc: 'markdown' },
  },
  { id: 'a-target', name: 'target', outputs: ['out'], outputKinds: { out: 'string' } },
] as unknown as Agent[]

afterEach(() => cleanup())

function renderDialog(props: Partial<React.ComponentProps<typeof ConnectionDialog>> = {}) {
  type OnApply = React.ComponentProps<typeof ConnectionDialog>['onApply']
  const onApply = vi.fn(
    (_plan: Parameters<OnApply>[0], _targetNodeId: Parameters<OnApply>[1]) => true,
  )
  const result = render(
    <I18nextProvider i18n={i18n}>
      <ConnectionDialog
        open
        definition={definition}
        agents={agents}
        sourceNodeId="source"
        onApply={onApply}
        onClose={vi.fn()}
        {...props}
      />
    </I18nextProvider>,
  )
  return { ...result, onApply }
}

async function chooseTarget(getByTestId: ReturnType<typeof render>['getByTestId'], label: RegExp) {
  fireEvent.click(getByTestId('connection-target-node'))
  const option = await waitFor(() => {
    const found = document.querySelectorAll<HTMLElement>('[role="option"]')
    const match = [...found].find((element) => label.test(element.textContent ?? ''))
    expect(match).toBeDefined()
    return match!
  })
  fireEvent.mouseDown(option)
}

describe('ConnectionDialog', () => {
  test('delegates compatibility updates to the editor page live region', async () => {
    const { getByTestId } = render(
      <I18nextProvider i18n={i18n}>
        <ManagedLiveRegionProvider>
          <ConnectionDialog
            open
            definition={definition}
            agents={agents}
            sourceNodeId="source"
            onApply={() => true}
            onClose={() => undefined}
          />
        </ManagedLiveRegionProvider>
      </I18nextProvider>,
    )

    expect(document.querySelectorAll('[aria-live]')).toHaveLength(1)
    expect(getByTestId('connection-compatibility').getAttribute('role')).toBeNull()
    await waitFor(() => expect(getByTestId('managed-live-region').textContent).not.toBe(''))
  })

  test('moves initial focus to the first endpoint field', async () => {
    const { getByTestId } = renderDialog()
    await waitFor(() => expect(document.activeElement).toBe(getByTestId('connection-source-port')))
  })

  test('shows source, target, NEW/REUSE and a readable endpoint preview', () => {
    const { getByTestId, getByText } = renderDialog()
    expect(getByTestId('connection-source-port')).not.toBeNull()
    expect(getByTestId('connection-target-node')).not.toBeNull()
    expect(getByTestId('connection-mode-new')).not.toBeNull()
    expect(getByTestId('connection-mode-reuse')).not.toBeNull()
    expect(getByTestId('connection-preview').textContent).toMatch(/source\.doc.*target/)
    expect(getByText(/New input|新增输入/)).not.toBeNull()
  })

  test('review uses the fixed shared port and submits one planner result', async () => {
    const { getByTestId, onApply } = renderDialog()
    await chooseTarget(getByTestId, /review/)
    expect(getByTestId('connection-target-port').textContent).toContain(REVIEW_INPUT_PORT_NAME)
    expect(getByTestId('connection-mode-new')).toHaveProperty('disabled', true)
    fireEvent.click(getByTestId('connection-submit'))
    expect(onApply).toHaveBeenCalledTimes(1)
    const [plan, targetNodeId] = onApply.mock.calls[0]!
    expect(targetNodeId).toBe('review')
    expect(plan).toMatchObject({ ok: true, compatibility: 'compatible' })
    expect(plan.addEdges[0]?.target.portName).toBe(REVIEW_INPUT_PORT_NAME)
  })

  test('occupied REUSE names the edge that will be replaced', () => {
    const occupied: WorkflowDefinition = {
      ...definition,
      edges: [
        {
          id: 'old-edge',
          source: { nodeId: 'review', portName: 'approved_doc' },
          target: { nodeId: 'target', portName: 'existing' },
        },
      ],
    }
    const { getByTestId } = renderDialog({ definition: occupied })
    fireEvent.click(getByTestId('connection-mode-reuse'))
    expect(getByTestId('connection-replacement').textContent).toContain('old-edge')
  })

  test('edge reconnect replaces the selected edge in one fresh semantic plan', async () => {
    const reconnecting: WorkflowDefinition = {
      ...definition,
      edges: [
        {
          id: 'selected-edge',
          source: { nodeId: 'source', portName: 'doc' },
          target: { nodeId: 'target', portName: 'legacy' },
        },
      ],
    }
    const { getByTestId, onApply } = renderDialog({
      definition: reconnecting,
      sourceNodeId: 'source',
      sourcePortName: 'doc',
      replaceEdgeId: 'selected-edge',
      initialTargetNodeId: 'target',
      initialTargetPortName: 'legacy',
    })
    await waitFor(() => expect(getByTestId('connection-submit')).toHaveProperty('disabled', false))
    fireEvent.click(getByTestId('connection-submit'))
    const [plan] = onApply.mock.calls[0]!
    expect(plan.removeEdgeIds).toContain('selected-edge')
    expect(plan.addEdges).toEqual([
      expect.objectContaining({
        id: 'selected-edge',
        source: { nodeId: 'source', portName: 'doc' },
        target: { nodeId: 'target', portName: 'legacy' },
      }),
    ])
    const applied = applyWorkflowTransition(
      reconnecting,
      { kind: 'connection', plan },
      createWorkflowSemanticContext(agents),
    )
    expect(applied.warnings).toEqual([])
    expect(applied.next.edges).toEqual(plan.addEdges)
  })

  test('inventory changes recompute compatibility and invalidate the old submit plan', async () => {
    const { getByTestId, rerender } = renderDialog({ sourceNodeId: 'source' })
    await chooseTarget(getByTestId, /review/)
    expect(getByTestId('connection-submit')).toHaveProperty('disabled', false)
    rerender(
      <I18nextProvider i18n={i18n}>
        <ConnectionDialog
          open
          definition={definition}
          agents={[{ ...agents[0]!, outputKinds: { doc: 'string' } }, agents[1]!]}
          sourceNodeId="source"
          onApply={() => true}
          onClose={() => undefined}
        />
      </I18nextProvider>,
    )
    expect(getByTestId('connection-submit')).toHaveProperty('disabled', true)
    expect(getByTestId('connection-compatibility').textContent).toMatch(/Incompatible|不兼容/)
  })

  test('fan-out boundary names inner/outer endpoints and requires explicit kind and role', async () => {
    const fanoutDefinition: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        { ...agentNode('outer', 'outer'), agentId: 'outer-agent' } as WorkflowNode,
        {
          id: 'fanout',
          kind: 'wrapper-fanout',
          nodeIds: ['inner'],
          inputs: [],
          position: { x: 100, y: 0 },
        } as WorkflowNode,
        { ...agentNode('inner', 'inner'), agentId: 'inner-agent' } as WorkflowNode,
      ],
      edges: [],
    }
    const fanoutAgents = [
      {
        id: 'outer-agent',
        name: 'outer',
        outputs: ['items'],
        outputKinds: { items: 'list<string>' },
      },
      { id: 'inner-agent', name: 'inner', outputs: ['out'], outputKinds: { out: 'string' } },
    ] as unknown as Agent[]
    const { getByTestId, onApply } = renderDialog({
      definition: fanoutDefinition,
      agents: fanoutAgents,
      sourceNodeId: 'outer',
    })
    await chooseTarget(getByTestId, /inner/)
    expect(getByTestId('connection-fanout-boundary').textContent).toMatch(/outer.*fanout.*inner/i)
    expect((getByTestId('connection-fanout-kind') as HTMLInputElement).value).toBe('list<string>')
    expect(getByTestId('connection-fanout-role-shard').getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => expect(getByTestId('connection-submit')).toHaveProperty('disabled', false))
    fireEvent.click(getByTestId('connection-submit'))
    expect(onApply).toHaveBeenCalledTimes(1)
    const [plan] = onApply.mock.calls[0]!
    expect(plan.addEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ boundary: 'wrapper-input' }),
        expect.objectContaining({ target: { nodeId: 'fanout', portName: 'items' } }),
      ]),
    )
    expect(plan.nodePatches[0]).toMatchObject({
      kind: 'set-fanout-inputs',
      wrapperNodeId: 'fanout',
      inputs: [{ name: 'items', kind: 'list<string>', isShardSource: true }],
    })
  })
})
