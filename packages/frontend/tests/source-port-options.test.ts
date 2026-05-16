// sourcePortOptions — locks in the agent-multi sourcePort dropdown's
// candidate list. The dropdown replaces an earlier two-text-input field
// that let users free-type an unknown node id ('diff' instead of e.g.
// 'wrap_git_yny27b'), tripping `agent-multi-source-port-missing` at save
// time. The helper is pure so we can test it without mounting xyflow /
// the inspector — the integration cases live in node-inspector.test.tsx.

import { describe, expect, test } from 'vitest'
import type { Agent, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { sourcePortOptions } from '../src/components/canvas/NodeInspector'

const CODER: Agent = {
  id: 'agent-coder',
  name: 'coder',
  description: '',
  outputs: ['code', 'logs'],
  readonly: false,
  syncOutputsOnIterate: true,
  permission: {},
  skills: [],
  dependsOn: [],
  frontmatterExtra: {},
  bodyMd: '',
  schemaVersion: 1,
  createdAt: 0,
  updatedAt: 0,
}

function def(nodes: WorkflowNode[]): WorkflowDefinition {
  return { $schema_version: 1, inputs: [], nodes, edges: [] }
}

describe('sourcePortOptions', () => {
  test('lists upstream nodes that produce at least one output port', () => {
    const opts = sourcePortOptions(
      def([
        { id: 'wg', kind: 'wrapper-git', nodeIds: [] } as WorkflowNode,
        { id: 'a1', kind: 'agent-single', agentName: 'coder' } as WorkflowNode,
        { id: 'm1', kind: 'agent-multi', agentName: 'coder' } as WorkflowNode,
      ]),
      [CODER],
      'm1',
    )
    // wg → git_diff; a1 → code, logs. Plus m1 is excluded as `selfNodeId`.
    expect(opts.map((o) => o.nodeId)).toEqual(['a1', 'wg'])
    expect(opts.find((o) => o.nodeId === 'wg')?.outputs).toEqual(['git_diff'])
    expect(opts.find((o) => o.nodeId === 'a1')?.outputs).toEqual(['code', 'logs'])
  })

  test('excludes the agent-multi node itself', () => {
    const opts = sourcePortOptions(
      def([
        { id: 'm1', kind: 'agent-multi', agentName: 'coder' } as WorkflowNode,
        { id: 'wg', kind: 'wrapper-git', nodeIds: [] } as WorkflowNode,
      ]),
      [CODER],
      'm1',
    )
    expect(opts.map((o) => o.nodeId)).toEqual(['wg'])
  })

  test('excludes nodes that produce no outputs (e.g. agent without resolved agent definition)', () => {
    // agent-single referencing an unknown agent name — computePorts has
    // no `outputs` to read, so it falls through with zero outputs and
    // can't legitimately be picked as an upstream source.
    const opts = sourcePortOptions(
      def([
        { id: 'a1', kind: 'agent-single', agentName: 'ghost' } as WorkflowNode,
        { id: 'wg', kind: 'wrapper-git', nodeIds: [] } as WorkflowNode,
      ]),
      [], // no agents resolved
      'm1',
    )
    expect(opts.map((o) => o.nodeId)).toEqual(['wg'])
  })

  test('agent-multi parents include the synthetic `errors` port', () => {
    // computePorts auto-appends `errors` to agent-multi outputs; an
    // upstream agent-multi should be selectable AND surface that port
    // so users can fan-out over another fan-out's error stream.
    const opts = sourcePortOptions(
      def([
        { id: 'fan_a', kind: 'agent-multi', agentName: 'coder' } as WorkflowNode,
        { id: 'm1', kind: 'agent-multi', agentName: 'coder' } as WorkflowNode,
      ]),
      [CODER],
      'm1',
    )
    expect(opts.find((o) => o.nodeId === 'fan_a')?.outputs).toEqual(['code', 'logs', 'errors'])
  })

  test('input nodes appear (their `inputKey` is exposed as an output port)', () => {
    const opts = sourcePortOptions(
      def([{ id: 'in1', kind: 'input', inputKey: 'req' } as WorkflowNode]),
      [CODER],
      'm1',
    )
    expect(opts).toEqual([{ nodeId: 'in1', kind: 'input', outputs: ['req'] }])
  })

  test('sorted by node id for stable rendering', () => {
    const opts = sourcePortOptions(
      def([
        { id: 'z', kind: 'wrapper-git', nodeIds: [] } as WorkflowNode,
        { id: 'a', kind: 'wrapper-git', nodeIds: [] } as WorkflowNode,
        { id: 'm', kind: 'wrapper-git', nodeIds: [] } as WorkflowNode,
      ]),
      [],
      'm1',
    )
    expect(opts.map((o) => o.nodeId)).toEqual(['a', 'm', 'z'])
  })

  test('empty definition → empty list', () => {
    expect(sourcePortOptions(def([]), [], 'm1')).toEqual([])
  })
})
