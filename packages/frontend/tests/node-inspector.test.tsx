// NodeInspector edit-form tests: each node kind owns a small patch surface;
// these confirm that user edits flow through `onChange` as a fully-formed
// WorkflowDefinition with the right node updated.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Agent, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { NodeInspector } from '../src/components/canvas/NodeInspector'
import { setBaseUrl, setToken } from '../src/stores/auth'

function wrap(node: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

beforeEach(() => {
  // ModelSelect (rendered for agent-single / agent-multi) hits
  // /api/runtime/models — stub out fetch so the inspector renders the
  // dropdown without going to the network in unit tests.
  setBaseUrl('http://daemon.test')
  setToken('tok')
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ binary: 'opencode', cached: false, models: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
})

const CODER: Agent = {
  id: 'agent-coder',
  name: 'coder',
  description: '',
  outputs: ['code'],
  readonly: false,
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
  model: 'anthropic/sonnet',
}

function makeDef(nodes: WorkflowNode[]): WorkflowDefinition {
  return { $schema_version: 1, inputs: [], nodes, edges: [] }
}

// Stateful harness — mirrors what the editor route does so that subsequent
// edits in the inspector see prior state (sourcePort field needs this).
function Host({
  initial,
  agents,
  onChangeSpy,
  onCloseSpy,
}: {
  initial: WorkflowNode
  agents: Agent[]
  onChangeSpy: (def: WorkflowDefinition) => void
  onCloseSpy: () => void
}) {
  const [def, setDef] = useState<WorkflowDefinition>(makeDef([initial]))
  return (
    <NodeInspector
      definition={def}
      selectedNodeId={initial.id}
      agents={agents}
      onChange={(next) => {
        setDef(next)
        onChangeSpy(next)
      }}
      onClose={onCloseSpy}
    />
  )
}

function setup(node: WorkflowNode, agents: Agent[] = [CODER]) {
  const onChange = vi.fn()
  const onClose = vi.fn()
  wrap(<Host initial={node} agents={agents} onChangeSpy={onChange} onCloseSpy={onClose} />)
  return { onChange, onClose }
}

function lastPatchedNode(onChange: ReturnType<typeof vi.fn>): WorkflowNode {
  const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as WorkflowDefinition
  return lastCall.nodes[0]!
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('NodeInspector', () => {
  test('renders nothing when no node is selected', () => {
    const { container } = render(
      <NodeInspector
        definition={makeDef([])}
        selectedNodeId={null}
        agents={[]}
        onChange={() => {}}
        onClose={() => {}}
      />,
    )
    expect(container.querySelector('.inspector')).toBeNull()
  })

  test('renders nothing when selected node id is unknown', () => {
    const { container } = render(
      <NodeInspector
        definition={makeDef([])}
        selectedNodeId="ghost"
        agents={[]}
        onChange={() => {}}
        onClose={() => {}}
      />,
    )
    expect(container.querySelector('.inspector')).toBeNull()
  })

  // RFC-015 follow-up: PreviewPane only renders prompt-template assembly
  // for agent-single / agent-multi. Other kinds (input / output / wrappers /
  // review) used to get a disabled "Preview" tab + a muted "preview only for
  // agents" message. Hide the tab entirely for those kinds so the surface
  // doesn't advertise functionality that isn't available.
  test('Preview tab hidden for non-agent kinds (input)', () => {
    render(
      <NodeInspector
        definition={makeDef([{ id: 'i1', kind: 'input', inputKey: 'req' }])}
        selectedNodeId="i1"
        agents={[]}
        onChange={() => {}}
        onClose={() => {}}
      />,
    )
    // Only Edit tab is in the DOM — Preview button gone.
    const tabs = document.querySelectorAll('.tabs--inspector .tabs__tab')
    expect(tabs.length).toBe(1)
    expect(tabs[0]?.textContent).toMatch(/Edit/i)
  })

  test('Preview tab visible for agent-single', () => {
    const node: WorkflowNode = {
      id: 'a1',
      kind: 'agent-single',
      agentName: 'coder',
    } as unknown as WorkflowNode
    setup(node)
    const tabs = document.querySelectorAll('.tabs--inspector .tabs__tab')
    expect(tabs.length).toBe(2)
    expect(tabs[1]?.textContent).toMatch(/Preview/i)
  })

  test('Close button calls onClose', () => {
    const onClose = vi.fn()
    render(
      <NodeInspector
        definition={makeDef([{ id: 'i1', kind: 'input', inputKey: 'req' }])}
        selectedNodeId="i1"
        agents={[]}
        onChange={() => {}}
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('input node: editing the Input key patches inputKey', () => {
    const { onChange } = setup({ id: 'i1', kind: 'input', inputKey: 'req' })
    // RFC-004: the inspector now renders 5 inputs (key / kind / label /
    // required / description). The key is the first text input and shows
    // value 'req' before the label field (label defaults to the key, so
    // both have the same displayed value).
    const inputKeyEl = screen.getAllByDisplayValue('req')[0] as HTMLInputElement
    fireEvent.change(inputKeyEl, { target: { value: 'spec' } })
    const next = lastPatchedNode(onChange) as unknown as { inputKey: string }
    expect(next.inputKey).toBe('spec')
  })

  test('output node: + Add port appends an empty binding', () => {
    const { onChange } = setup({
      id: 'o1',
      kind: 'output',
      ports: [{ name: 'final', bind: { nodeId: 'a1', portName: 'code' } }],
    })
    fireEvent.click(screen.getByText('+ Add port'))
    const next = lastPatchedNode(onChange) as unknown as {
      ports: Array<{ name: string; bind: { nodeId: string; portName: string } }>
    }
    expect(next.ports).toHaveLength(2)
    expect(next.ports[1]).toEqual({ name: 'port_2', bind: { nodeId: '', portName: '' } })
  })

  test('output node: Remove drops the matching row', () => {
    const { onChange } = setup({
      id: 'o1',
      kind: 'output',
      ports: [
        { name: 'a', bind: { nodeId: 'x', portName: 'p' } },
        { name: 'b', bind: { nodeId: 'y', portName: 'q' } },
      ],
    })
    // There are two Remove buttons (one per row); click the first.
    fireEvent.click(screen.getAllByText('Remove')[0]!)
    const next = lastPatchedNode(onChange) as unknown as {
      ports: Array<{ name: string }>
    }
    expect(next.ports.map((p) => p.name)).toEqual(['b'])
  })

  test('wrapper-git: inner ids list is read-only (no form inputs)', () => {
    setup({ id: 'wg', kind: 'wrapper-git', nodeIds: ['a', 'b'] })
    // No editable form inputs in the body — just inner-id chips.
    const inputs = document.querySelectorAll('.inspector__body input, .inspector__body select')
    expect(inputs.length).toBe(0)
    expect(screen.getByText('a')).toBeTruthy()
    expect(screen.getByText('b')).toBeTruthy()
  })

  test('wrapper-loop: changing exitCondition kind keeps prior fields and switches the visible inputs', () => {
    const { onChange } = setup({
      id: 'wl',
      kind: 'wrapper-loop',
      nodeIds: ['a'],
      maxIterations: 3,
      exitCondition: { kind: 'port-empty', nodeId: 'a', portName: 'p' },
      outputBindings: [],
    })
    fireEvent.change(screen.getByDisplayValue('port-empty'), { target: { value: 'port-equals' } })
    const after = lastPatchedNode(onChange) as unknown as {
      exitCondition: { kind: string; nodeId: string; portName: string }
    }
    expect(after.exitCondition.kind).toBe('port-equals')
    expect(after.exitCondition.nodeId).toBe('a')
    expect(after.exitCondition.portName).toBe('p')
  })

  test('wrapper-loop: + Add binding appends an empty output binding', () => {
    const { onChange } = setup({
      id: 'wl',
      kind: 'wrapper-loop',
      nodeIds: ['a'],
      maxIterations: 3,
      exitCondition: { kind: 'port-empty' },
      outputBindings: [],
    })
    fireEvent.click(screen.getByText('+ Add binding'))
    const after = lastPatchedNode(onChange) as unknown as {
      outputBindings: Array<{ name: string; bind: { nodeId: string; portName: string } }>
    }
    expect(after.outputBindings).toEqual([{ name: 'out_1', bind: { nodeId: '', portName: '' } }])
  })

  test('agent-single: selecting an agent patches agentName', () => {
    const { onChange } = setup({
      id: 'a1',
      kind: 'agent-single',
      agentName: '',
      promptTemplate: '',
    })
    // First combobox is the agent picker; the model-override dropdown
    // also renders, so we explicitly grab index 0.
    const select = (screen.getAllByRole('combobox') as HTMLSelectElement[])[0]!
    fireEvent.change(select, { target: { value: 'coder' } })
    const after = lastPatchedNode(onChange) as unknown as { agentName: string }
    expect(after.agentName).toBe('coder')
  })

  // When no override is set, the model dropdown shows the agent's own
  // default model — so the displayed value matches what'll actually run.
  test('agent-single: model dropdown defaults to the agent model when no override is set', async () => {
    vi.restoreAllMocks()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          binary: 'opencode',
          cached: false,
          models: [{ id: 'anthropic/sonnet', provider: 'anthropic', modelID: 'sonnet' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    setup({
      id: 'a1',
      kind: 'agent-single',
      agentName: 'coder',
      promptTemplate: '',
    })
    const modelOption = await screen.findByRole('option', { name: /sonnet/i })
    const modelSelect = modelOption.closest('select') as HTMLSelectElement
    expect(modelSelect.value).toBe('anthropic/sonnet')
  })

  // Locks in the swap from a free-text model field to a ModelSelect dropdown
  // for the workflow node's model override (mirrors the AgentForm dropdown).
  test('agent-single: model override renders as a dropdown listing fetched models', async () => {
    vi.restoreAllMocks()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          binary: 'opencode',
          cached: false,
          models: [{ id: 'anthropic/sonnet', provider: 'anthropic', modelID: 'sonnet' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    const { onChange } = setup({
      id: 'a1',
      kind: 'agent-single',
      agentName: 'coder',
      promptTemplate: '',
    })
    const modelOption = await screen.findByRole('option', { name: /sonnet/i })
    const modelSelect = modelOption.closest('select') as HTMLSelectElement
    fireEvent.change(modelSelect, { target: { value: 'anthropic/sonnet' } })
    const after = lastPatchedNode(onChange) as unknown as {
      overrides: { model?: string }
    }
    expect(after.overrides.model).toBe('anthropic/sonnet')
  })

  test('agent-single: editing the prompt template patches promptTemplate', () => {
    const { onChange } = setup({
      id: 'a1',
      kind: 'agent-single',
      agentName: 'coder',
      promptTemplate: 'old',
    })
    const ta = screen.getByDisplayValue('old') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'fix {{req}}' } })
    const after = lastPatchedNode(onChange) as unknown as { promptTemplate: string }
    expect(after.promptTemplate).toBe('fix {{req}}')
  })

  test('agent-multi: sourcePort dropdowns let user pick an upstream node + its output port', () => {
    // The SourcePortField needs siblings to offer as options — render a
    // workflow with a wrapper-git ahead of the agent-multi.
    const onChange = vi.fn()
    function MultiHost() {
      const [def, setDef] = useState<WorkflowDefinition>({
        $schema_version: 1,
        inputs: [],
        nodes: [
          { id: 'wg', kind: 'wrapper-git', nodeIds: [] } as WorkflowNode,
          {
            id: 'm1',
            kind: 'agent-multi',
            agentName: 'coder',
            sourcePort: { nodeId: '', portName: '' },
            promptTemplate: '',
          } as WorkflowNode,
        ],
        edges: [],
      })
      return (
        <NodeInspector
          definition={def}
          selectedNodeId="m1"
          agents={[CODER]}
          onChange={(next) => {
            setDef(next)
            onChange(next)
          }}
          onClose={() => {}}
        />
      )
    }
    wrap(<MultiHost />)
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[]
    // selects[0] = agent picker, selects[1] = node id, selects[2] = port name
    expect(selects.length).toBeGreaterThanOrEqual(3)
    const nodeSel = selects[1]!
    const portSel = selects[2]!
    // Port dropdown is disabled until a node is picked.
    expect(portSel.disabled).toBe(true)
    fireEvent.change(nodeSel, { target: { value: 'wg' } })
    fireEvent.change(portSel, { target: { value: 'git_diff' } })
    const after = (
      onChange.mock.calls[onChange.mock.calls.length - 1]![0] as WorkflowDefinition
    ).nodes.find((n) => n.id === 'm1') as unknown as {
      sourcePort: { nodeId: string; portName: string }
    }
    expect(after.sourcePort).toEqual({ nodeId: 'wg', portName: 'git_diff' })
  })

  test('agent-multi: changing node clears a now-invalid port name', () => {
    // wg exposes `git_diff`; coder agent (used by `a1`) exposes `code`.
    // Starting state points at wg.git_diff; switching to a1 must drop
    // the carried-over port because a1 doesn't expose `git_diff`.
    const onChange = vi.fn()
    function MultiHost() {
      const [def, setDef] = useState<WorkflowDefinition>({
        $schema_version: 1,
        inputs: [],
        nodes: [
          { id: 'wg', kind: 'wrapper-git', nodeIds: [] } as WorkflowNode,
          { id: 'a1', kind: 'agent-single', agentName: 'coder' } as WorkflowNode,
          {
            id: 'm1',
            kind: 'agent-multi',
            agentName: 'coder',
            sourcePort: { nodeId: 'wg', portName: 'git_diff' },
            promptTemplate: '',
          } as WorkflowNode,
        ],
        edges: [],
      })
      return (
        <NodeInspector
          definition={def}
          selectedNodeId="m1"
          agents={[CODER]}
          onChange={(next) => {
            setDef(next)
            onChange(next)
          }}
          onClose={() => {}}
        />
      )
    }
    wrap(<MultiHost />)
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[]
    fireEvent.change(selects[1]!, { target: { value: 'a1' } })
    const after = (onChange.mock.calls[0]![0] as WorkflowDefinition).nodes.find(
      (n) => n.id === 'm1',
    ) as unknown as {
      sourcePort: { nodeId: string; portName: string }
    }
    expect(after.sourcePort).toEqual({ nodeId: 'a1', portName: '' })
  })

  test('agent-multi: a stale sourcePort.nodeId is still shown as a "(missing)" option so the user can see the bad value', () => {
    function MultiHost() {
      const [def] = useState<WorkflowDefinition>({
        $schema_version: 1,
        inputs: [],
        nodes: [
          {
            id: 'm1',
            kind: 'agent-multi',
            agentName: 'coder',
            sourcePort: { nodeId: 'diff', portName: '' },
            promptTemplate: '',
          } as WorkflowNode,
        ],
        edges: [],
      })
      return (
        <NodeInspector
          definition={def}
          selectedNodeId="m1"
          agents={[CODER]}
          onChange={() => {}}
          onClose={() => {}}
        />
      )
    }
    wrap(<MultiHost />)
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[]
    const nodeSel = selects[1]!
    expect(nodeSel.value).toBe('diff')
    // The orphan option carries the saved id and a stable marker class:
    // we just match on visible text via the option list.
    const optionLabels = Array.from(nodeSel.options).map((o) => o.textContent ?? '')
    expect(optionLabels.some((l) => l.includes('diff'))).toBe(true)
  })

  test('Preview tab is omitted for non-agent kinds and present for agents', () => {
    const { unmount } = wrap(
      <NodeInspector
        definition={makeDef([{ id: 'i1', kind: 'input', inputKey: 'req' }])}
        selectedNodeId="i1"
        agents={[]}
        onChange={() => {}}
        onClose={() => {}}
      />,
    )
    // Pre-RFC-015 follow-up the tab was rendered with `disabled`. Now it's
    // removed entirely so the surface doesn't advertise unavailable
    // functionality. Look up by class because the button label is i18n'd.
    let tabs = document.querySelectorAll('.tabs--inspector .tabs__tab')
    expect(tabs.length).toBe(1)
    unmount()
    wrap(
      <NodeInspector
        definition={makeDef([{ id: 'a1', kind: 'agent-single', agentName: 'coder' }])}
        selectedNodeId="a1"
        agents={[CODER]}
        onChange={() => {}}
        onClose={() => {}}
      />,
    )
    tabs = document.querySelectorAll('.tabs--inspector .tabs__tab')
    expect(tabs.length).toBe(2)
  })

  // Display-name field — locks in the unified `title` editor surfaced for
  // every node kind. Earlier behaviour: agent / input / output / wrapper
  // nodes had no editable display name; only review / clarify carried a
  // kind-specific title field. The new field writes to `node.title` and
  // blanking it strips the key so the canvas falls back to the previous
  // derivation (agentName / inputKey / id).
  test('display name field: agent-single writes node.title', () => {
    const { onChange } = setup({ id: 'a1', kind: 'agent-single', agentName: 'coder' })
    const titleEl = screen.getByLabelText(/Display name/i) as HTMLInputElement
    fireEvent.change(titleEl, { target: { value: 'My coder' } })
    const next = lastPatchedNode(onChange) as unknown as { title?: string }
    expect(next.title).toBe('My coder')
  })

  test('display name field: blanking strips node.title entirely', () => {
    const { onChange } = setup({
      id: 'a1',
      kind: 'agent-single',
      agentName: 'coder',
      title: 'My coder',
    } as unknown as WorkflowNode)
    const titleEl = screen.getByLabelText(/Display name/i) as HTMLInputElement
    fireEvent.change(titleEl, { target: { value: '' } })
    const next = lastPatchedNode(onChange) as unknown as Record<string, unknown>
    expect('title' in next).toBe(false)
  })

  test('display name field: rendered for input / wrapper / output kinds too', () => {
    // Input
    const { unmount: u1 } = wrap(
      <Host
        initial={{ id: 'i1', kind: 'input', inputKey: 'req' } as unknown as WorkflowNode}
        agents={[]}
        onChangeSpy={() => {}}
        onCloseSpy={() => {}}
      />,
    )
    expect(screen.queryByLabelText(/Display name/i)).not.toBeNull()
    u1()

    // Wrapper-git
    const { unmount: u2 } = wrap(
      <Host
        initial={{ id: 'w1', kind: 'wrapper-git', nodeIds: [] } as unknown as WorkflowNode}
        agents={[]}
        onChangeSpy={() => {}}
        onCloseSpy={() => {}}
      />,
    )
    expect(screen.queryByLabelText(/Display name/i)).not.toBeNull()
    u2()

    // Output
    wrap(
      <Host
        initial={{ id: 'o1', kind: 'output', ports: [] } as unknown as WorkflowNode}
        agents={[]}
        onChangeSpy={() => {}}
        onCloseSpy={() => {}}
      />,
    )
    expect(screen.queryByLabelText(/Display name/i)).not.toBeNull()
  })
})
