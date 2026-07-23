// RFC-060 PR-D — fanout.ts shard scope + auto-promote tests.
//
// Locks:
//   - perShard = reachable from shardSource boundary edges via inner edges
//   - aggregator excluded from both perShard and shared (third axis)
//   - cross-set auto-promote moves shared→perShard at fix-point
//   - boundary-output edges don't propagate
//   - aggregator exempt from auto-promote (stays shared/separate)
//   - empty shardSource binding → empty perShard
//   - estimateShardTotal multiplies nested expectedShardCount

import type { Agent, WorkflowDefinition } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import {
  applyAutoPromote,
  computeShardScope,
  estimateShardTotal,
  findBoundaryEdgesToInner,
} from '../src/services/fanout'

function baseAgent(name: string, fields: Partial<Agent> = {}): Agent {
  return {
    id: name,
    name,
    description: '',
    outputs: ['out'],
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
    ...fields,
  }
}

function defWith(
  nodes: WorkflowDefinition['nodes'],
  edges: WorkflowDefinition['edges'] = [],
): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: nodes.map((node) =>
      node.kind === 'agent-single' &&
      typeof node.agentName === 'string' &&
      node.agentId === undefined
        ? { ...node, agentId: node.agentName }
        : node,
    ),
    edges,
  }
}

describe('computeShardScope — basic reachable BFS', () => {
  test('one inner agent connected to shardSource → perShard only', () => {
    const def = defWith(
      [
        {
          id: 'w',
          kind: 'wrapper-fanout',
          nodeIds: ['a'],
          inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
        },
        { id: 'a', kind: 'agent-single', agentName: 'reporter' },
      ],
      [
        {
          id: 'e_in',
          source: { nodeId: 'w', portName: 'docs' },
          target: { nodeId: 'a', portName: 'doc' },
          boundary: 'wrapper-input',
        },
      ],
    )
    const scope = computeShardScope({
      wrapperId: 'w',
      defn: def,
      agents: new Map([['reporter', baseAgent('reporter')]]),
    })
    expect([...scope.perShard]).toEqual(['a'])
    expect([...scope.shared]).toEqual([])
    expect(scope.aggregatorId).toBeNull()
    expect(scope.shardSourceName).toBe('docs')
  })

  test('inner agent only connected to broadcast input → shared', () => {
    const def = defWith(
      [
        {
          id: 'w',
          kind: 'wrapper-fanout',
          nodeIds: ['a'],
          inputs: [
            { name: 'docs', kind: 'list<path<md>>', isShardSource: true },
            { name: 'spec', kind: 'path<md>' },
          ],
        },
        { id: 'a', kind: 'agent-single', agentName: 'reporter' },
      ],
      [
        // boundary-input from broadcast port; no shardSource edge → 'a' shared
        {
          id: 'e_in',
          source: { nodeId: 'w', portName: 'spec' },
          target: { nodeId: 'a', portName: 'in' },
          boundary: 'wrapper-input',
        },
      ],
    )
    const scope = computeShardScope({
      wrapperId: 'w',
      defn: def,
      agents: new Map([['reporter', baseAgent('reporter')]]),
    })
    expect([...scope.perShard]).toEqual([])
    expect([...scope.shared]).toEqual(['a'])
  })

  test('aggregator separated from perShard/shared', () => {
    const def = defWith(
      [
        {
          id: 'w',
          kind: 'wrapper-fanout',
          nodeIds: ['worker', 'agg'],
          inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
        },
        { id: 'worker', kind: 'agent-single', agentName: 'reporter' },
        { id: 'agg', kind: 'agent-single', agentName: 'merger' },
      ],
      [
        {
          id: 'e_in',
          source: { nodeId: 'w', portName: 'docs' },
          target: { nodeId: 'worker', portName: 'doc' },
          boundary: 'wrapper-input',
        },
        {
          id: 'e_inner',
          source: { nodeId: 'worker', portName: 'out' },
          target: { nodeId: 'agg', portName: 'reports' },
        },
      ],
    )
    const scope = computeShardScope({
      wrapperId: 'w',
      defn: def,
      agents: new Map([
        ['reporter', baseAgent('reporter')],
        ['merger', baseAgent('merger', { role: 'aggregator' })],
      ]),
    })
    expect([...scope.perShard]).toEqual(['worker'])
    expect([...scope.shared]).toEqual([])
    expect(scope.aggregatorId).toBe('agg')
  })

  test('boundary-output edge does not propagate perShard membership', () => {
    const def = defWith(
      [
        {
          id: 'w',
          kind: 'wrapper-fanout',
          nodeIds: ['agg'],
          inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
        },
        { id: 'agg', kind: 'agent-single', agentName: 'merger' },
        { id: 'downstream', kind: 'agent-single', agentName: 'sink' },
      ],
      [
        {
          id: 'e_in',
          source: { nodeId: 'w', portName: 'docs' },
          target: { nodeId: 'agg', portName: 'reports' },
          boundary: 'wrapper-input',
        },
        {
          id: 'e_out',
          source: { nodeId: 'agg', portName: 'final' },
          target: { nodeId: 'w', portName: 'final' },
          boundary: 'wrapper-output',
        },
      ],
    )
    const scope = computeShardScope({
      wrapperId: 'w',
      defn: def,
      agents: new Map([
        ['merger', baseAgent('merger', { role: 'aggregator' })],
        ['sink', baseAgent('sink')],
      ]),
    })
    // 'downstream' is OUTSIDE the wrapper; it must not appear in any set.
    expect(scope.perShard.has('downstream')).toBe(false)
    expect(scope.shared.has('downstream')).toBe(false)
  })

  test('no shardSource boundary edge → empty perShard', () => {
    const def = defWith(
      [
        {
          id: 'w',
          kind: 'wrapper-fanout',
          nodeIds: ['a'],
          inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
        },
        { id: 'a', kind: 'agent-single', agentName: 'reporter' },
      ],
      [],
    )
    const scope = computeShardScope({
      wrapperId: 'w',
      defn: def,
      agents: new Map([['reporter', baseAgent('reporter')]]),
    })
    expect([...scope.perShard]).toEqual([])
    expect([...scope.shared]).toEqual(['a'])
  })
})

describe('applyAutoPromote — cross-set propagation', () => {
  test('shared target of perShard source → promoted to perShard', () => {
    const def = defWith(
      [
        {
          id: 'w',
          kind: 'wrapper-fanout',
          nodeIds: ['a', 'b'],
          inputs: [
            { name: 'docs', kind: 'list<path<md>>', isShardSource: true },
            { name: 'spec', kind: 'path<md>' },
          ],
        },
        { id: 'a', kind: 'agent-single', agentName: 'reporter' },
        { id: 'b', kind: 'agent-single', agentName: 'sink' },
      ],
      [
        {
          id: 'e_in_a',
          source: { nodeId: 'w', portName: 'docs' },
          target: { nodeId: 'a', portName: 'doc' },
          boundary: 'wrapper-input',
        },
        {
          id: 'e_in_b',
          source: { nodeId: 'w', portName: 'spec' },
          target: { nodeId: 'b', portName: 'spec' },
          boundary: 'wrapper-input',
        },
        // cross-set fan-in: a (perShard) → b (initially shared)
        {
          id: 'e_inner',
          source: { nodeId: 'a', portName: 'out' },
          target: { nodeId: 'b', portName: 'report' },
        },
      ],
    )
    const agents = new Map([
      ['reporter', baseAgent('reporter')],
      ['sink', baseAgent('sink')],
    ])
    const scope = applyAutoPromote(computeShardScope({ wrapperId: 'w', defn: def, agents }), def)
    expect(scope.perShard.has('a')).toBe(true)
    expect(scope.perShard.has('b')).toBe(true)
    expect(scope.shared.has('b')).toBe(false)
  })

  test('chain promotes transitively via fix-point loop', () => {
    const def = defWith(
      [
        {
          id: 'w',
          kind: 'wrapper-fanout',
          nodeIds: ['a', 'b', 'c'],
          inputs: [
            { name: 'docs', kind: 'list<path<md>>', isShardSource: true },
            { name: 'spec', kind: 'path<md>' },
          ],
        },
        { id: 'a', kind: 'agent-single', agentName: 'reporter' },
        { id: 'b', kind: 'agent-single', agentName: 'sink_b' },
        { id: 'c', kind: 'agent-single', agentName: 'sink_c' },
      ],
      [
        {
          id: 'e_in_a',
          source: { nodeId: 'w', portName: 'docs' },
          target: { nodeId: 'a', portName: 'doc' },
          boundary: 'wrapper-input',
        },
        {
          id: 'e_in_b',
          source: { nodeId: 'w', portName: 'spec' },
          target: { nodeId: 'b', portName: 's' },
          boundary: 'wrapper-input',
        },
        {
          id: 'e_in_c',
          source: { nodeId: 'w', portName: 'spec' },
          target: { nodeId: 'c', portName: 's' },
          boundary: 'wrapper-input',
        },
        // chain a → b → c
        {
          id: 'e_ab',
          source: { nodeId: 'a', portName: 'out' },
          target: { nodeId: 'b', portName: 'in' },
        },
        {
          id: 'e_bc',
          source: { nodeId: 'b', portName: 'out' },
          target: { nodeId: 'c', portName: 'in' },
        },
      ],
    )
    const agents = new Map([
      ['reporter', baseAgent('reporter')],
      ['sink_b', baseAgent('sink_b')],
      ['sink_c', baseAgent('sink_c')],
    ])
    const scope = applyAutoPromote(computeShardScope({ wrapperId: 'w', defn: def, agents }), def)
    expect(scope.perShard.has('a')).toBe(true)
    expect(scope.perShard.has('b')).toBe(true)
    expect(scope.perShard.has('c')).toBe(true)
    expect([...scope.shared]).toEqual([])
  })

  test('aggregator exempt from auto-promote (stays as separate axis)', () => {
    const def = defWith(
      [
        {
          id: 'w',
          kind: 'wrapper-fanout',
          nodeIds: ['a', 'agg'],
          inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
        },
        { id: 'a', kind: 'agent-single', agentName: 'reporter' },
        { id: 'agg', kind: 'agent-single', agentName: 'merger' },
      ],
      [
        {
          id: 'e_in',
          source: { nodeId: 'w', portName: 'docs' },
          target: { nodeId: 'a', portName: 'doc' },
          boundary: 'wrapper-input',
        },
        // a → agg edge (perShard fan-in to aggregator)
        {
          id: 'e_to_agg',
          source: { nodeId: 'a', portName: 'out' },
          target: { nodeId: 'agg', portName: 'reports' },
        },
      ],
    )
    const agents = new Map([
      ['reporter', baseAgent('reporter')],
      ['merger', baseAgent('merger', { role: 'aggregator' })],
    ])
    const scope = applyAutoPromote(computeShardScope({ wrapperId: 'w', defn: def, agents }), def)
    expect(scope.perShard.has('a')).toBe(true)
    expect(scope.perShard.has('agg')).toBe(false) // aggregator stays out
    expect(scope.shared.has('agg')).toBe(false)
    expect(scope.aggregatorId).toBe('agg')
  })
})

describe('estimateShardTotal', () => {
  test('no nested fanout → outer count unchanged', () => {
    const def = defWith([
      {
        id: 'w',
        kind: 'wrapper-fanout',
        nodeIds: ['a'],
        inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
      },
      { id: 'a', kind: 'agent-single', agentName: 'r' },
    ])
    expect(estimateShardTotal(def, 'w', 8)).toBe(8)
  })

  test('nested fanout with declared expectedShardCount multiplies', () => {
    const def = defWith([
      {
        id: 'outer',
        kind: 'wrapper-fanout',
        nodeIds: ['inner'],
        inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
      },
      {
        id: 'inner',
        kind: 'wrapper-fanout',
        nodeIds: [],
        inputs: [{ name: 'items', kind: 'list<string>', isShardSource: true }],
        expectedShardCount: 4,
      },
    ])
    expect(estimateShardTotal(def, 'outer', 8)).toBe(32) // 8 × 4
  })

  test('nested fanout without declared count → uses default 16', () => {
    const def = defWith([
      {
        id: 'outer',
        kind: 'wrapper-fanout',
        nodeIds: ['inner'],
        inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
      },
      {
        id: 'inner',
        kind: 'wrapper-fanout',
        nodeIds: [],
        inputs: [{ name: 'items', kind: 'list<string>', isShardSource: true }],
      },
    ])
    expect(estimateShardTotal(def, 'outer', 8)).toBe(8 * 16)
  })
})

describe('findBoundaryEdgesToInner', () => {
  test('returns boundary-input edges to a specific inner node', () => {
    const def = defWith(
      [
        {
          id: 'w',
          kind: 'wrapper-fanout',
          nodeIds: ['a'],
          inputs: [
            { name: 'docs', kind: 'list<path<md>>', isShardSource: true },
            { name: 'spec', kind: 'path<md>' },
          ],
        },
        { id: 'a', kind: 'agent-single', agentName: 'r' },
      ],
      [
        {
          id: 'e1',
          source: { nodeId: 'w', portName: 'docs' },
          target: { nodeId: 'a', portName: 'doc' },
          boundary: 'wrapper-input',
        },
        {
          id: 'e2',
          source: { nodeId: 'w', portName: 'spec' },
          target: { nodeId: 'a', portName: 'spec' },
          boundary: 'wrapper-input',
        },
        // non-boundary edge in same defn ignored
        {
          id: 'e3',
          source: { nodeId: 'a', portName: 'out' },
          target: { nodeId: 'somewhere', portName: 'in' },
        },
      ],
    )
    const result = findBoundaryEdgesToInner(def, 'w', 'a')
    expect(result.map((e) => e.id)).toEqual(['e1', 'e2'])
  })
})
