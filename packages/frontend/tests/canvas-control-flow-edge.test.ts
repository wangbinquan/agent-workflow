// Locks in the grey-dashed rendering of CONTROL-FLOW edges on the workflow
// canvas (the 2026-06-26 "control-flow lines render as grey dashed" change).
//
// A control-flow edge is one whose SOURCE port is a no-data kind (RFC-060
// `signal`): an agent output declared `signal`, or a wrapper-fanout's implicit
// `__done__` outlet. These get the `canvas-edge--control` className so
// styles.css draws them grey + dashed — the same visual language as the signal
// PORT chrome (`.canvas-node__handle--signal`). Data edges MUST stay untagged.
//
// The `toFlowEdges` cases also pin the back-compat contract: with no edge-id
// set passed, control-flow tagging is a pure no-op (so the pre-existing
// `toFlowEdges(DEF.edges)` call sites in canvas.test.ts round-trip unchanged).

import { describe, expect, test } from 'vitest'
import type { Agent, WorkflowDefinition } from '@agent-workflow/shared'
import { __testToFlowEdges as toFlowEdges } from '../src/components/canvas/WorkflowCanvas'
import {
  buildControlFlowEdgeIds,
  CONTROL_FLOW_EDGE_CLASS,
  isControlFlowEdge,
  isControlFlowKind,
  sourcePortKind,
} from '../src/components/canvas/controlFlowEdge'

// `signaler` declares one `signal` output (`done`) + one default-string output
// (`report`); `consumer` just receives. Mirrors the fixture style in
// canvas.test.ts.
const SIGNALER: Agent = {
  id: 'a',
  name: 'signaler',
  description: '',
  outputs: ['done', 'report'],
  outputKinds: { done: 'signal' },
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
const CONSUMER: Agent = { ...SIGNALER, id: 'b', name: 'consumer', outputs: [], outputKinds: {} }

const agentByName = new Map<string, Agent>([
  ['signaler', SIGNALER],
  ['consumer', CONSUMER],
])

const DEF: WorkflowDefinition = {
  $schema_version: 4,
  inputs: [],
  nodes: [
    { id: 'a1', kind: 'agent-single', agentName: 'signaler' },
    { id: 'a2', kind: 'agent-single', agentName: 'consumer' },
    // No aggregator inside ⇒ deriveWrapperFanoutOutputs yields the implicit
    // `__done__` (kind: signal) outlet.
    { id: 'wf1', kind: 'wrapper-fanout', nodeIds: [], inputs: [] },
    { id: 'g1', kind: 'wrapper-git' },
  ],
  edges: [
    // control flow: agent signal output
    {
      id: 'e_sig',
      source: { nodeId: 'a1', portName: 'done' },
      target: { nodeId: 'a2', portName: 'done' },
    },
    // data: agent default-string output
    {
      id: 'e_data',
      source: { nodeId: 'a1', portName: 'report' },
      target: { nodeId: 'a2', portName: 'report' },
    },
    // control flow: wrapper-fanout __done__ signal outlet
    {
      id: 'e_fanout',
      source: { nodeId: 'wf1', portName: '__done__' },
      target: { nodeId: 'a2', portName: 'sig2' },
    },
    // data: wrapper-git diff
    {
      id: 'e_git',
      source: { nodeId: 'g1', portName: 'git_diff' },
      target: { nodeId: 'a2', portName: 'diff' },
    },
  ],
}

const edgeById = (id: string) => DEF.edges.find((e) => e.id === id)!

describe('isControlFlowKind', () => {
  test('signal is control-flow (carries no data)', () => {
    expect(isControlFlowKind('signal')).toBe(true)
  })
  test('data kinds are not control-flow', () => {
    expect(isControlFlowKind('string')).toBe(false)
    expect(isControlFlowKind('markdown')).toBe(false)
    expect(isControlFlowKind('path<pdf>')).toBe(false)
    expect(isControlFlowKind('list<string>')).toBe(false)
  })
  test('absent / empty / unparseable / unregistered kinds default to data', () => {
    expect(isControlFlowKind(undefined)).toBe(false)
    expect(isControlFlowKind('')).toBe(false)
    expect(isControlFlowKind('totally_unknown_kind')).toBe(false)
  })
})

describe('sourcePortKind', () => {
  test('reads an agent output kind', () => {
    expect(sourcePortKind(edgeById('e_sig'), DEF, agentByName)).toBe('signal')
  })
  test('an undeclared agent output kind is undefined (default string)', () => {
    expect(sourcePortKind(edgeById('e_data'), DEF, agentByName)).toBeUndefined()
  })
  test('derives a wrapper-fanout __done__ outlet as signal', () => {
    expect(sourcePortKind(edgeById('e_fanout'), DEF, agentByName)).toBe('signal')
  })
  test('non-agent / non-fanout source ports are undefined', () => {
    expect(sourcePortKind(edgeById('e_git'), DEF, agentByName)).toBeUndefined()
  })
  test('a missing source node is undefined (stale snapshot tolerance)', () => {
    const ghost = {
      id: 'eg',
      source: { nodeId: 'ghost', portName: 'x' },
      target: { nodeId: 'a2', portName: 'x' },
    }
    expect(sourcePortKind(ghost, DEF, agentByName)).toBeUndefined()
  })
})

describe('isControlFlowEdge', () => {
  test('agent signal output edge is control-flow', () => {
    expect(isControlFlowEdge(edgeById('e_sig'), DEF, agentByName)).toBe(true)
  })
  test('wrapper-fanout __done__ edge is control-flow', () => {
    expect(isControlFlowEdge(edgeById('e_fanout'), DEF, agentByName)).toBe(true)
  })
  test('agent string output edge is a data edge', () => {
    expect(isControlFlowEdge(edgeById('e_data'), DEF, agentByName)).toBe(false)
  })
  test('wrapper-git diff edge is a data edge', () => {
    expect(isControlFlowEdge(edgeById('e_git'), DEF, agentByName)).toBe(false)
  })
})

describe('buildControlFlowEdgeIds', () => {
  test('collects exactly the control-flow edge ids', () => {
    const ids = buildControlFlowEdgeIds(DEF, agentByName)
    expect([...ids].sort()).toEqual(['e_fanout', 'e_sig'])
  })
  test('empty agent map still tags the agent-independent __done__ edge', () => {
    // Before the agents query resolves agentByName is empty; the fanout
    // __done__ outlet doesn't depend on any agent, so it must still tag.
    const ids = buildControlFlowEdgeIds(DEF, new Map())
    expect(ids.has('e_fanout')).toBe(true)
    expect(ids.has('e_sig')).toBe(false)
  })
})

describe('toFlowEdges control-flow tagging', () => {
  test('tags only control-flow edges with the control className', () => {
    const ids = buildControlFlowEdgeIds(DEF, agentByName)
    const flow = toFlowEdges(DEF.edges, ids)
    const cls = (id: string) => flow.find((e) => e.id === id)?.className
    expect(cls('e_sig')).toBe(CONTROL_FLOW_EDGE_CLASS)
    expect(cls('e_fanout')).toBe(CONTROL_FLOW_EDGE_CLASS)
    expect(cls('e_data')).toBeUndefined()
    expect(cls('e_git')).toBeUndefined()
  })
  test('back-compat: no id set ⇒ no edge is tagged', () => {
    const flow = toFlowEdges(DEF.edges)
    expect(flow.every((e) => e.className === undefined)).toBe(true)
  })
})
