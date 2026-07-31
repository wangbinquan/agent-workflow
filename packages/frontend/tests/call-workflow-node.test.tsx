// RFC-242 PR-3 — frontend registration of the call-workflow node kind.
// Locks in, per design §5.2 (frontend consumer surfaces) + §8:
//   1. palette: the new Calls section carries the call-workflow entry and a
//      fresh drop starts with an empty workflowName (Inspector fills it);
//   2. port derivation: computePorts / loopMemberCandidates thread the
//      optional child-workflow resolver into shared declaredPorts — with a
//      resolver the node mirrors the CHILD definition's ports, without one
//      it declares none (legacy 3-arg call sites stay byte-identical);
//   3. node title: workflowName is the node identity, kind label fallback;
//   4. Inspector: workflow selector (self excluded — self reference is the
//      trivial call cycle), child port preview, and the neutral
//      "reference not visible or missing" placeholder for unresolvable refs
//      (ACL-filtered list ⇒ invisible and deleted are indistinguishable).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Agent, Workflow, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import i18n from '../src/i18n'
import {
  buildPalette,
  makeNode,
  PALETTE_DESCRIPTORS,
  PALETTE_SECTIONS,
} from '../src/components/canvas/nodePalette'
import { computePorts, __testToFlowNodes } from '../src/components/canvas/WorkflowCanvas'
import { loopMemberCandidates } from '../src/components/canvas/wrapperCandidates'
import { nodeTitle } from '../src/components/canvas/nodeTitle'
import { NodeInspector, type InspectorChangeMeta } from '../src/components/canvas/NodeInspector'
import { setBaseUrl, setToken } from '../src/stores/auth'

// --- fixtures ---------------------------------------------------------------

const CHILD_DEF: WorkflowDefinition = {
  $schema_version: 1,
  inputs: [
    { kind: 'text', key: 'requirement', label: 'Requirement' },
    { kind: 'text', key: 'context', label: 'Context' },
  ],
  nodes: [
    {
      id: 'out1',
      kind: 'output',
      position: { x: 0, y: 0 },
      ports: [{ name: 'audit_report' }, { name: 'summary' }],
    } as unknown as WorkflowNode,
    {
      id: 'out2',
      kind: 'output',
      position: { x: 0, y: 0 },
      // duplicate `summary` — declaration dedups (first wins) for stable rendering
      ports: [{ name: 'summary' }, { name: 'notes' }],
    } as unknown as WorkflowNode,
  ],
  edges: [],
} as unknown as WorkflowDefinition

function workflowRow(id: string, name: string, definition: WorkflowDefinition): Workflow {
  return {
    id,
    name,
    description: '',
    definition,
    version: 1,
    schemaVersion: 4,
    createdAt: 0,
    updatedAt: 0,
  } as Workflow
}

const CHILD_WF = workflowRow('wf-child', 'child-wf', CHILD_DEF)
const OTHER_WF = workflowRow('wf-other', 'other-wf', {
  $schema_version: 1,
  inputs: [],
  nodes: [],
  edges: [],
} as unknown as WorkflowDefinition)
const SELF_WF = workflowRow('wf-self', 'self-wf', {
  $schema_version: 1,
  inputs: [],
  nodes: [],
  edges: [],
} as unknown as WorkflowDefinition)

const RESOLVER = (ref: string) => (ref === 'child-wf' || ref === 'wf-child' ? CHILD_DEF : null)

function callNode(extra: Record<string, unknown> = {}): WorkflowNode {
  return {
    id: 'call1',
    kind: 'call-workflow',
    position: { x: 0, y: 0 },
    workflowName: 'child-wf',
    workflowId: 'wf-child',
    ...extra,
  } as unknown as WorkflowNode
}

function defOf(nodes: WorkflowNode[], edges: WorkflowDefinition['edges'] = []): WorkflowDefinition {
  return { $schema_version: 1, inputs: [], nodes, edges } as unknown as WorkflowDefinition
}

// --- 1. palette -------------------------------------------------------------

describe('palette carries the call-workflow entry (Calls section)', () => {
  test('descriptor row: Calls section + fresh-node defaults', () => {
    expect(PALETTE_DESCRIPTORS['call-workflow'].section).toBe('calls')
    expect(PALETTE_SECTIONS.map((s) => s.key)).toContain('calls')
    const node = makeNode({ kind: 'call-workflow' }, { x: 10, y: 20 }) as unknown as Record<
      string,
      unknown
    >
    expect(node.kind).toBe('call-workflow')
    expect(node.id).toMatch(/^call_wf_/)
    // The reference is picked in the Inspector — a fresh drop is explicit
    // "unset", which the validator's call-ref rules block at launch.
    expect(node.workflowName).toBe('')
  })

  test('buildPalette renders the entry under Calls with the ⧉ glyph', () => {
    const identityT = (key: string) => key
    const sections = buildPalette([], identityT)
    const calls = sections.find((s) => s.key === 'calls')
    expect(calls).toBeDefined()
    // RFC-242 PR-4 — the Calls section now carries the workgroup twin too
    // (NODE_KIND declaration order fixes within-section order).
    expect(calls?.items.map((i) => i.item.kind)).toEqual(['call-workflow', 'call-workgroup'])
    expect(calls?.items[0]?.label).toBe('⧉ editor.paletteCallWorkflowLabel')
    expect(calls?.items[0]?.description).toBe('editor.paletteCallWorkflowDesc')
  })
})

// --- 2. port derivation through the resolver --------------------------------

describe('call-workflow port derivation (computePorts / candidates via resolver)', () => {
  const agentByName = new Map<string, Agent>()

  test('computePorts mirrors the child definition when the resolver resolves', () => {
    const node = callNode()
    const ports = computePorts(node, agentByName, defOf([node]), RESOLVER)
    expect(ports.inputs).toEqual(['requirement', 'context'])
    // outputs = union of the child's output-node ports, deduped, order kept
    expect(ports.outputs).toEqual(['audit_report', 'summary', 'notes'])
  })

  test('without a resolver (legacy 3-arg call sites) the node declares no ports', () => {
    const node = callNode()
    const ports = computePorts(node, agentByName, defOf([node]))
    expect(ports.inputs).toEqual([])
    expect(ports.outputs).toEqual([])
  })

  test('unresolvable reference degrades to edge-derived ports only', () => {
    const node = callNode({ workflowName: 'ghost', workflowId: undefined })
    const def = defOf([node], [
      {
        id: 'e1',
        source: { nodeId: 'x', portName: 'doc' },
        target: { nodeId: 'call1', portName: 'requirement' },
      },
    ] as unknown as WorkflowDefinition['edges'])
    const ports = computePorts(node, agentByName, def, RESOLVER)
    expect(ports.inputs).toEqual(['requirement'])
    expect(ports.outputs).toEqual([])
  })

  test('toFlowNodes threads the resolver + surfaces workflowName onto node data', () => {
    const node = callNode()
    const flow = __testToFlowNodes(
      [node],
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'editor',
      RESOLVER,
    )
    const data = flow[0]?.data as Record<string, unknown>
    expect(flow[0]?.type).toBe('call-workflow')
    expect(data.inputPorts).toEqual(['requirement', 'context'])
    expect(data.outputPorts).toEqual(['audit_report', 'summary', 'notes'])
    expect(data.workflowName).toBe('child-wf')
  })

  test('loopMemberCandidates exposes call-workflow child outputs for exit conditions', () => {
    const wrapper = {
      id: 'loop1',
      kind: 'wrapper-loop',
      position: { x: 0, y: 0 },
      nodeIds: ['call1'],
    } as unknown as WorkflowNode
    const member = callNode()
    const out = loopMemberCandidates(wrapper, defOf([wrapper, member]), [], RESOLVER)
    expect(out).toEqual([
      {
        nodeId: 'call1',
        title: 'child-wf',
        outputPorts: ['audit_report', 'summary', 'notes'],
      },
    ])
    // Without a resolver the member stays listed but contributes no ports —
    // legacy callers keep their exact pre-RFC-242 shape.
    expect(loopMemberCandidates(wrapper, defOf([wrapper, member]), [])[0]?.outputPorts).toEqual([])
  })
})

// --- 3. node title ----------------------------------------------------------

describe('call-workflow node title', () => {
  test('workflowName is the display title; kind label is the unset fallback', () => {
    expect(nodeTitle(callNode())).toBe('child-wf')
    expect(nodeTitle(callNode({ workflowName: '' }))).toBe(i18n.t('callWorkflowNode.label'))
    // Explicit user title still wins (shared rule 1).
    expect(nodeTitle(callNode({ title: 'my call' }))).toBe('my call')
  })
})

// --- 4. Inspector -----------------------------------------------------------

function wrap(node: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

function renderInspector(node: WorkflowNode) {
  const onChange = vi.fn()
  wrap(
    <NodeInspector
      definition={defOf([node])}
      selectedNodeId={node.id}
      agents={[]}
      workflowId="wf-self"
      onChange={(next: WorkflowDefinition, _meta: InspectorChangeMeta) => onChange(next)}
      onClose={() => {}}
    />,
  )
  return { onChange }
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    const body = url.includes('/api/workflows') ? [CHILD_WF, OTHER_WF, SELF_WF] : []
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
})

afterEach(() => {
  // Unmount before restoring mocks — the Select listbox portals to body.
  cleanup()
  vi.restoreAllMocks()
})

describe('CallWorkflowEdit inspector', () => {
  test('selector lists visible workflows, excludes the workflow being edited, and previews child ports', async () => {
    renderInspector(callNode())
    const trigger = await screen.findByTestId('call-workflow-ref-select')
    // Child ports preview renders once the shared ['workflows'] query lands.
    const preview = await screen.findByTestId('call-workflow-ports-preview')
    expect(preview.textContent).toContain('requirement')
    expect(preview.textContent).toContain('context')
    expect(preview.textContent).toContain('audit_report')
    expect(preview.textContent).toContain('summary')
    expect(preview.textContent).toContain('notes')

    fireEvent.click(trigger)
    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).queryByText('child-wf')).not.toBeNull()
    expect(within(listbox).queryByText('other-wf')).not.toBeNull()
    // Self reference = trivial call cycle — never offered.
    expect(within(listbox).queryByText('self-wf')).toBeNull()
  })

  test('picking a workflow writes workflowName + workflowId cache', async () => {
    const { onChange } = renderInspector(callNode())
    const trigger = await screen.findByTestId('call-workflow-ref-select')
    await screen.findByTestId('call-workflow-ports-preview')
    fireEvent.click(trigger)
    const listbox = await screen.findByRole('listbox')
    fireEvent.mouseDown(within(listbox).getByText('other-wf'))
    const next = onChange.mock.calls.at(-1)?.[0] as WorkflowDefinition
    const patched = next.nodes[0] as unknown as Record<string, unknown>
    expect(patched.workflowName).toBe('other-wf')
    expect(patched.workflowId).toBe('wf-other')
  })

  test('unresolvable reference shows the neutral same-shape placeholder', async () => {
    renderInspector(callNode({ workflowName: 'ghost', workflowId: undefined }))
    const placeholder = await screen.findByTestId('call-workflow-ref-unavailable')
    expect(placeholder.textContent).toBe(i18n.t('inspector.callWorkflowRefUnavailable'))
    expect(screen.queryByTestId('call-workflow-ports-preview')).toBeNull()
  })

  test('limits NumberInputs write and clear the optional limits object', async () => {
    const { onChange } = renderInspector(callNode({ limits: { maxTotalTokens: 500 } }))
    const duration = await screen.findByTestId('call-workflow-max-duration')
    fireEvent.change(duration, { target: { value: '60000' } })
    let patched = (onChange.mock.calls.at(-1)?.[0] as WorkflowDefinition)
      .nodes[0] as unknown as Record<string, unknown>
    expect(patched.limits).toEqual({ maxTotalTokens: 500, maxDurationMs: 60000 })
    // Clearing the only remaining limit drops the whole limits field.
    const single = callNode({ limits: { maxTotalTokens: 500 } })
    cleanup()
    const second = renderInspector(single)
    const tokens = await screen.findByTestId('call-workflow-max-tokens')
    fireEvent.change(tokens, { target: { value: '' } })
    patched = (second.onChange.mock.calls.at(-1)?.[0] as WorkflowDefinition)
      .nodes[0] as unknown as Record<string, unknown>
    expect(patched.limits).toBeUndefined()
  })
})
