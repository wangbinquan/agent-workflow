// NodeInspector edit-form tests: each node kind owns a small patch surface;
// these confirm that user edits flow through `onChange` as a fully-formed
// WorkflowDefinition with the right node updated.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Agent, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { NodeInspector, type InspectorChangeMeta } from '../src/components/canvas/NodeInspector'
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
  onChangeSpy: (def: WorkflowDefinition, meta: InspectorChangeMeta) => void
  onCloseSpy: () => void
}) {
  const [def, setDef] = useState<WorkflowDefinition>(makeDef([initial]))
  return (
    <NodeInspector
      definition={def}
      selectedNodeId={initial.id}
      agents={agents}
      onChange={(next, meta) => {
        setDef(next)
        onChangeSpy(next, meta)
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
  // Unmount via testing-library first — the Select listbox is portaled to
  // document.body, so wiping innerHTML before cleanup() races React's
  // removeChild and crashes happy-dom.
  cleanup()
  vi.restoreAllMocks()
})

// The inspector's pickers are the shared <Select> (RFC-036): role=combobox
// triggers + portaled role=listbox. Find a trigger by the text it displays,
// open it, and click an option by its label.
function comboboxShowing(text: RegExp): HTMLElement | undefined {
  return screen.getAllByRole('combobox').find((c) => text.test(c.textContent ?? ''))
}
function pickFromCombobox(trigger: HTMLElement, optionLabel: string | RegExp) {
  fireEvent.click(trigger)
  const listbox = screen.getByRole('listbox')
  fireEvent.mouseDown(within(listbox).getByText(optionLabel))
}

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

  test('true tabs keep every stable panel target while mounting content only for the active tab', () => {
    const node: WorkflowNode = {
      id: 'a1',
      kind: 'agent-single',
      agentName: 'coder',
      promptTemplate: 'Draft {{req}}',
    } as unknown as WorkflowNode
    setup(node)

    const editTab = screen.getByRole('tab', { name: /Edit/i })
    const previewTab = screen.getByRole('tab', { name: /Preview/i })
    expect(editTab.id).toBe('workflow-node-inspector-tab-edit')
    expect(editTab.getAttribute('aria-controls')).toBe('workflow-node-inspector-panel-edit')
    expect(previewTab.id).toBe('workflow-node-inspector-tab-preview')
    expect(previewTab.getAttribute('aria-controls')).toBe('workflow-node-inspector-panel-preview')
    expect(document.getElementById('workflow-node-inspector-panel-edit')?.hidden).toBe(false)
    expect(document.getElementById('workflow-node-inspector-panel-preview')?.hidden).toBe(true)

    let panels = screen.getAllByRole('tabpanel')
    expect(panels).toHaveLength(1)
    expect(panels[0]?.id).toBe('workflow-node-inspector-panel-edit')
    expect(panels[0]?.getAttribute('aria-labelledby')).toBe(editTab.id)
    expect(screen.getByLabelText(/Display name/i)).toBeTruthy()

    fireEvent.click(previewTab)
    panels = screen.getAllByRole('tabpanel')
    expect(panels).toHaveLength(1)
    expect(panels[0]?.id).toBe('workflow-node-inspector-panel-preview')
    expect(panels[0]?.getAttribute('aria-labelledby')).toBe(previewTab.id)
    expect(document.getElementById('workflow-node-inspector-panel-edit')?.hidden).toBe(true)
    expect(document.getElementById('workflow-node-inspector-panel-preview')?.hidden).toBe(false)
    expect(screen.queryByLabelText(/Display name/i)).toBeNull()
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
    fireEvent.blur(inputKeyEl)
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

  test('wrapper-git: inner ids list is read-only (chips, not inputs)', () => {
    setup({ id: 'wg', kind: 'wrapper-git', nodeIds: ['a', 'b'] })
    // Inner ids should render as plain chip text — not bound to any input
    // that would let the user retype them here. After the unified
    // display-name field landed the body does have one input (the new
    // node title), so we assert specifically that the inner ids surface
    // as text, not values inside an input/select.
    const editable = Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
        '.inspector__body input, .inspector__body select',
      ),
    )
    expect(editable.some((el) => el.value === 'a' || el.value === 'b')).toBe(false)
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
    pickFromCombobox(comboboxShowing(/port-empty/)!, 'port-equals')
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

  test('agent-single: selecting an agent patches canonical id and display name', () => {
    const { onChange } = setup({
      id: 'a1',
      kind: 'agent-single',
      agentName: '',
      promptTemplate: '',
    })
    // First combobox is the agent picker; the model-override dropdown
    // also renders, so we explicitly grab index 0.
    const trigger = screen.getAllByRole('combobox')[0]!
    pickFromCombobox(trigger, 'coder')
    const after = lastPatchedNode(onChange) as unknown as { agentId: string; agentName: string }
    expect(after.agentId).toBe('agent-coder')
    expect(after.agentName).toBe('coder')
    expect(onChange.mock.calls[0]?.[1]).toEqual({
      source: 'inspector',
      label: 'Agent',
      transaction: 'single',
    })
  })

  test('agent-single: clearing the picker cannot persist a name-only identity', () => {
    const { onChange } = setup({
      id: 'a1',
      kind: 'agent-single',
      agentId: 'agent-coder',
      agentName: 'coder',
      promptTemplate: '',
    })
    const trigger = screen.getAllByRole('combobox')[0]!
    pickFromCombobox(trigger, /pick an agent|选一个代理/i)
    expect(onChange).not.toHaveBeenCalled()
  })

  // When no override is set, the model dropdown shows the agent's own
  // default model — so the displayed value matches what'll actually run.
  // RFC-113 removed per-node model/variant/temperature OVERRIDES; RFC-115 then
  // removed the last two per-node overrides — retries + timeout — moving them to
  // global config (config.defaultNodeRetries / defaultPerNodeTimeoutMs, set in
  // Settings → Limits). The agent-single inspector now carries NO execution-param
  // override controls at all. A regression that re-adds any of them (an override
  // field OR a per-node retries/timeout input) turns this red.
  test('agent-single: no per-node execution-param override controls (model/variant/temperature/retries/timeout)', () => {
    setup({
      id: 'a1',
      kind: 'agent-single',
      agentName: 'coder',
      promptTemplate: '',
    })
    // RFC-113 removed runtime-param overrides:
    expect(screen.queryByText('Model override')).toBeNull()
    expect(screen.queryByText('Temperature override')).toBeNull()
    // RFC-115 removed the per-node execution policy (now global, in Settings):
    expect(screen.queryByText('Retries')).toBeNull()
    expect(screen.queryByText('Timeout (ms)')).toBeNull()
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

  // RFC-060 PR-E: agent-multi removed; the RFC-015 SourcePortField dropdowns
  // were deleted alongside it. wrapper-fanout uses real boundary-input edges
  // on the canvas instead of an inspector picker. PR-F's frontend polish
  // covers the new wrapper-fanout inspector.

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

  test('continuous text emits a stable node+field mergeKey and a no-op blur boundary', () => {
    const { onChange } = setup({ id: 'a1', kind: 'agent-single', agentName: 'coder' })
    const titleEl = screen.getByLabelText(/Display name/i) as HTMLInputElement

    fireEvent.change(titleEl, { target: { value: 'My' } })
    fireEvent.change(titleEl, { target: { value: 'My coder' } })
    fireEvent.blur(titleEl)

    expect(onChange).toHaveBeenCalledTimes(3)
    expect(onChange.mock.calls[0]?.[1]).toEqual({
      source: 'inspector',
      label: 'Display name',
      mergeKey: 'node:a1:title',
      transaction: 'update',
    })
    expect(onChange.mock.calls[1]?.[1]).toEqual(onChange.mock.calls[0]?.[1])
    expect(onChange.mock.calls[2]?.[1]).toEqual({
      source: 'inspector',
      label: 'Display name',
      mergeKey: 'node:a1:title',
      transaction: 'update',
      historyBoundary: 'blur',
    })
    expect(onChange.mock.calls[2]?.[0]).toEqual(onChange.mock.calls[1]?.[0])
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

  test('shows transition warnings when an agent change prunes a disappeared fan-out outlet', () => {
    const aggregator: Agent = {
      ...CODER,
      id: 'agent-aggregator',
      name: 'aggregator',
      role: 'aggregator',
      outputs: ['summary'],
      outputKinds: { summary: 'markdown' },
      outputWrapperPortNames: { summary: 'promoted' },
    }
    const normal: Agent = {
      ...CODER,
      id: 'agent-normal',
      name: 'normal',
      outputs: [],
    }
    const definition: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        {
          id: 'inner',
          kind: 'agent-single',
          agentId: 'agent-aggregator',
          agentName: 'aggregator',
        },
        { id: 'fanout', kind: 'wrapper-fanout', nodeIds: ['inner'], inputs: [] },
        {
          id: 'output',
          kind: 'output',
          ports: [{ name: 'report', bind: { nodeId: 'fanout', portName: 'promoted' } }],
        },
      ],
      edges: [
        {
          id: 'promoted-edge',
          source: { nodeId: 'fanout', portName: 'promoted' },
          target: { nodeId: 'output', portName: 'report' },
        },
      ],
    }
    const onChange = vi.fn()
    wrap(
      <NodeInspector
        definition={definition}
        selectedNodeId="inner"
        agents={[aggregator, normal]}
        onChange={onChange}
        onClose={() => {}}
      />,
    )

    const agentSelect = comboboxShowing(/aggregator/i)
    if (agentSelect === undefined) throw new Error('agent selector missing')
    pickFromCombobox(agentSelect, 'normal')

    expect(screen.getByText(/stale graph reference/i)).toBeTruthy()
    const next = onChange.mock.calls[0]?.[0] as WorkflowDefinition
    expect(next.edges).toEqual([])
    expect(
      (next.nodes.find((node) => node.id === 'output') as Record<string, unknown>).ports,
    ).toEqual([{ name: 'report', bind: { nodeId: '', portName: '' } }])
  })
})
