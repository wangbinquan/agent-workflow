// RFC-242 PR-4 — frontend registration of the call-workgroup node kind, the
// workgroup twin of call-workflow (locked next door in
// call-workflow-node.test.tsx). Locks in, per design §6.3/§6.4:
//   1. palette: the Calls section carries the call-workgroup entry (⬡) and a
//      fresh drop starts with empty workgroupName + goalTemplate;
//   2. port derivation: inputs are pure edge-derived prompt vars (agent-single
//      shape — NOT mirrored from any child definition) and the output is the
//      FIXED `result` port from the shared PORT_DERIVERS table;
//   3. node title: workgroupName is the node identity, kind label fallback;
//   4. Inspector: workgroup selector (NO self-exclusion — workgroups are
//      closure leaves, self reference cannot exist), required goalTemplate
//      write-back, limits write/clear, fixed-result read-only line;
//   5. dropTarget: call-workgroup ACCEPTS minted named inputs (open set),
//      the exact opposite of call-workflow's closed child-mirrored set.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Agent, Workgroup, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import i18n from '../src/i18n'
import { buildPalette, makeNode, PALETTE_DESCRIPTORS } from '../src/components/canvas/nodePalette'
import { computePorts, __testToFlowNodes } from '../src/components/canvas/WorkflowCanvas'
import { findNewInputTarget } from '../src/components/canvas/dropTarget'
import { nodeTitle } from '../src/components/canvas/nodeTitle'
import { NodeInspector, type InspectorChangeMeta } from '../src/components/canvas/NodeInspector'
import { setBaseUrl, setToken } from '../src/stores/auth'

// --- fixtures ---------------------------------------------------------------

function workgroupRow(id: string, name: string): Workgroup {
  return {
    id,
    name,
    description: '',
    mode: 'free_collab',
    members: [],
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Workgroup
}

const WG_A = workgroupRow('wg-a', 'audit-squad')
const WG_B = workgroupRow('wg-b', 'fix-squad')

function callNode(extra: Record<string, unknown> = {}): WorkflowNode {
  return {
    id: 'callwg1',
    kind: 'call-workgroup',
    position: { x: 0, y: 0 },
    workgroupName: 'audit-squad',
    workgroupId: 'wg-a',
    goalTemplate: 'Audit {{diff}} please',
    ...extra,
  } as unknown as WorkflowNode
}

function defOf(nodes: WorkflowNode[], edges: WorkflowDefinition['edges'] = []): WorkflowDefinition {
  return { $schema_version: 1, inputs: [], nodes, edges } as unknown as WorkflowDefinition
}

// --- 1. palette -------------------------------------------------------------

describe('palette carries the call-workgroup entry (Calls section)', () => {
  test('descriptor row: Calls section + fresh-node defaults', () => {
    expect(PALETTE_DESCRIPTORS['call-workgroup'].section).toBe('calls')
    const node = makeNode({ kind: 'call-workgroup' }, { x: 10, y: 20 }) as unknown as Record<
      string,
      unknown
    >
    expect(node.kind).toBe('call-workgroup')
    expect(node.id).toMatch(/^call_wg_/)
    // Reference + goal are filled in the Inspector — a fresh drop is explicit
    // "unset", which the validator's call-workgroup rules block at launch.
    expect(node.workgroupName).toBe('')
    expect(node.goalTemplate).toBe('')
  })

  test('buildPalette renders the entry under Calls with the ⬡ glyph, after call-workflow', () => {
    const identityT = (key: string) => key
    const sections = buildPalette([], identityT)
    const calls = sections.find((s) => s.key === 'calls')
    expect(calls).toBeDefined()
    expect(calls?.items.map((i) => i.item.kind)).toEqual(['call-workflow', 'call-workgroup'])
    expect(calls?.items[1]?.label).toBe('⬡ editor.paletteCallWorkgroupLabel')
    expect(calls?.items[1]?.description).toBe('editor.paletteCallWorkgroupDesc')
  })
})

// --- 2. port derivation -----------------------------------------------------

describe('call-workgroup port derivation (edge-derived inputs + fixed result)', () => {
  const agentByName = new Map<string, Agent>()

  test('output is the fixed `result` port; no edges ⇒ no input ports', () => {
    const node = callNode()
    const ports = computePorts(node, agentByName, defOf([node]))
    expect(ports.inputs).toEqual([])
    expect(ports.outputs).toEqual(['result'])
  })

  test('inputs derive purely from inbound edges (agent-single precedent)', () => {
    const node = callNode()
    const def = defOf([node], [
      {
        id: 'e1',
        source: { nodeId: 'x', portName: 'doc' },
        target: { nodeId: 'callwg1', portName: 'diff' },
      },
      {
        id: 'e2',
        source: { nodeId: 'y', portName: 'notes' },
        target: { nodeId: 'callwg1', portName: 'context' },
      },
    ] as unknown as WorkflowDefinition['edges'])
    const ports = computePorts(node, agentByName, def)
    expect(ports.inputs).toEqual(['diff', 'context'])
    // The declared output stays fixed regardless of wiring or any resolver.
    expect(ports.outputs).toEqual(['result'])
  })

  test('toFlowNodes registers the renderer type + surfaces workgroupName onto node data', () => {
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
    )
    const data = flow[0]?.data as Record<string, unknown>
    expect(flow[0]?.type).toBe('call-workgroup')
    expect(data.inputPorts).toEqual([])
    expect(data.outputPorts).toEqual(['result'])
    expect(data.workgroupName).toBe('audit-squad')
  })
})

// --- 3. node title ----------------------------------------------------------

describe('call-workgroup node title', () => {
  test('workgroupName is the display title; kind label is the unset fallback', () => {
    expect(nodeTitle(callNode())).toBe('audit-squad')
    expect(nodeTitle(callNode({ workgroupName: '' }))).toBe(i18n.t('callWorkgroupNode.label'))
    // Explicit user title still wins (shared rule 1).
    expect(nodeTitle(callNode({ title: 'my squad call' }))).toBe('my squad call')
  })
})

// --- 4. dropTarget ----------------------------------------------------------

describe('drag-connect drop targeting (open input set, unlike call-workflow)', () => {
  test('call-workgroup accepts a minted named input; call-workflow still does not', () => {
    const wgNode = callNode()
    const wfNode = {
      id: 'callwf1',
      kind: 'call-workflow',
      position: { x: 0, y: 0 },
      workflowName: 'child-wf',
    } as unknown as WorkflowNode
    const src = {
      id: 'src',
      kind: 'agent-single',
      position: { x: 0, y: 0 },
      agentName: 'coder',
      agentId: 'a1',
    } as unknown as WorkflowNode
    const def = defOf([src, wgNode, wfNode])
    const boxes = [
      { id: 'callwg1', x: 0, y: 0, w: 100, h: 100 },
      { id: 'callwf1', x: 200, y: 0, w: 100, h: 100 },
    ]
    // Inputs are an OPEN edge-derived set (goalTemplate {{port}} vars), so a
    // drop mints a legal new input port — same behavior as agent-single.
    expect(findNewInputTarget(def, boxes, { x: 50, y: 50 }, 'src', 'result')).toEqual({
      nodeId: 'callwg1',
      portName: 'result',
    })
    // call-workflow keeps its CLOSED child-mirrored set: never a hit-test target.
    expect(findNewInputTarget(def, boxes, { x: 250, y: 50 }, 'src', 'result')).toBeNull()
  })

  test('minted input names deconflict against existing inbound edges', () => {
    const wgNode = callNode()
    const src = {
      id: 'src',
      kind: 'agent-single',
      position: { x: 0, y: 0 },
      agentName: 'coder',
      agentId: 'a1',
    } as unknown as WorkflowNode
    const def = defOf([src, wgNode], [
      {
        id: 'e1',
        source: { nodeId: 'other', portName: 'result' },
        target: { nodeId: 'callwg1', portName: 'result' },
      },
    ] as unknown as WorkflowDefinition['edges'])
    const boxes = [{ id: 'callwg1', x: 0, y: 0, w: 100, h: 100 }]
    expect(findNewInputTarget(def, boxes, { x: 50, y: 50 }, 'src', 'result')).toEqual({
      nodeId: 'callwg1',
      portName: 'result_2',
    })
  })
})

// --- 5. Inspector -----------------------------------------------------------

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
    const body = url.includes('/api/workgroups') ? [WG_A, WG_B] : []
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

describe('CallWorkgroupEdit inspector', () => {
  test('selector lists ALL visible workgroups (no self-exclusion) and shows the fixed-result line', async () => {
    renderInspector(callNode())
    const trigger = await screen.findByTestId('call-workgroup-ref-select')
    // Fixed output info line — there is no per-child port preview to render.
    const info = await screen.findByTestId('call-workgroup-result-info')
    expect(info.textContent).toBe(i18n.t('inspector.callWorkgroupResultInfo'))

    fireEvent.click(trigger)
    const listbox = await screen.findByRole('listbox')
    // Workgroups are closure leaves — self reference cannot exist, so the
    // list is NOT filtered (contrast CallWorkflowEdit's candidates).
    expect(within(listbox).queryByText('audit-squad')).not.toBeNull()
    expect(within(listbox).queryByText('fix-squad')).not.toBeNull()
  })

  test('picking a workgroup writes workgroupName + workgroupId cache', async () => {
    const { onChange } = renderInspector(callNode())
    const trigger = await screen.findByTestId('call-workgroup-ref-select')
    fireEvent.click(trigger)
    const listbox = await screen.findByRole('listbox')
    fireEvent.mouseDown(within(listbox).getByText('fix-squad'))
    const next = onChange.mock.calls.at(-1)?.[0] as WorkflowDefinition
    const patched = next.nodes[0] as unknown as Record<string, unknown>
    expect(patched.workgroupName).toBe('fix-squad')
    expect(patched.workgroupId).toBe('wg-b')
  })

  test('dangling reference stays visible via the missing-option pattern', async () => {
    renderInspector(callNode({ workgroupName: 'ghost-squad', workgroupId: undefined }))
    const trigger = await screen.findByTestId('call-workgroup-ref-select')
    // Await the fixed-result line so the ['workgroups'] query has settled and
    // the missing-option is not suppressed by the isLoading guard.
    await screen.findByTestId('call-workgroup-result-info')
    fireEvent.click(trigger)
    const listbox = await screen.findByRole('listbox')
    expect(
      within(listbox).queryByText(i18n.t('inspector.missingOption', { value: 'ghost-squad' })),
    ).not.toBeNull()
  })

  test('goalTemplate edits write back through the node patch', async () => {
    const { onChange } = renderInspector(callNode())
    const area = await screen.findByTestId('call-workgroup-goal-template')
    expect((area as HTMLTextAreaElement).value).toBe('Audit {{diff}} please')
    fireEvent.change(area, { target: { value: 'Fix {{report}} now' } })
    const next = onChange.mock.calls.at(-1)?.[0] as WorkflowDefinition
    const patched = next.nodes[0] as unknown as Record<string, unknown>
    expect(patched.goalTemplate).toBe('Fix {{report}} now')
  })

  test('limits NumberInputs write and clear the optional limits object', async () => {
    const { onChange } = renderInspector(callNode({ limits: { maxTotalTokens: 500 } }))
    const duration = await screen.findByTestId('call-workgroup-max-duration')
    fireEvent.change(duration, { target: { value: '60000' } })
    let patched = (onChange.mock.calls.at(-1)?.[0] as WorkflowDefinition)
      .nodes[0] as unknown as Record<string, unknown>
    expect(patched.limits).toEqual({ maxTotalTokens: 500, maxDurationMs: 60000 })
    // Clearing the only remaining limit drops the whole limits field.
    const single = callNode({ limits: { maxTotalTokens: 500 } })
    cleanup()
    const second = renderInspector(single)
    const tokens = await screen.findByTestId('call-workgroup-max-tokens')
    fireEvent.change(tokens, { target: { value: '' } })
    patched = (second.onChange.mock.calls.at(-1)?.[0] as WorkflowDefinition)
      .nodes[0] as unknown as Record<string, unknown>
    expect(patched.limits).toBeUndefined()
  })
})
