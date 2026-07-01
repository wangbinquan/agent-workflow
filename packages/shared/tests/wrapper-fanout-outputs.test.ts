// RFC-060 PR-C — wrapper-fanout outputs derivation tests.
//
// Locks:
//  1. Wrapper with no aggregator → single __done__ signal outlet.
//  2. Wrapper with one aggregator → mirror the aggregator's outputs[];
//     rename via outputWrapperPortNames; kinds from outputKinds map.
//  3. Multiple aggregators → first in nodeIds[] declaration order wins
//     (validator surfaces the multi-aggregator error separately).
//  4. Non-wrapper-fanout id → empty / null contracts respected.
//  5. Helpers accept Map or plain object for agent lookup.

import { describe, expect, test } from 'bun:test'
import type { Agent } from '../src/schemas/agent'
import type { WorkflowDefinition } from '../src/schemas/workflow'
import {
  FANOUT_DONE_PORT_NAME,
  countFanoutAggregators,
  deriveWrapperFanoutOutputs,
  findFanoutAggregator,
} from '../src/wrapperFanout'

function baseAgent(name: string, fields: Partial<Agent> = {}): Agent {
  const a: Agent = {
    id: `agent-${name}`,
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
  return a
}

function defWith(nodes: WorkflowDefinition['nodes']): WorkflowDefinition {
  return { $schema_version: 4, inputs: [], nodes, edges: [] }
}

describe('FANOUT_DONE_PORT_NAME', () => {
  test('canonical spelling', () => {
    expect(FANOUT_DONE_PORT_NAME).toBe('__done__')
  })
})

describe('deriveWrapperFanoutOutputs — empty / no aggregator', () => {
  test('non-wrapper-fanout id → __done__ signal outlet (defensive fallback)', () => {
    const def = defWith([{ id: 'a', kind: 'agent-single', agentName: 'reporter' }])
    expect(deriveWrapperFanoutOutputs(def, 'a', new Map())).toEqual([
      { name: '__done__', kind: 'signal' },
    ])
  })

  test('wrapper without inner aggregator → __done__ signal outlet', () => {
    const reporter = baseAgent('reporter')
    const def = defWith([
      { id: 'w', kind: 'wrapper-fanout', nodeIds: ['a'] },
      { id: 'a', kind: 'agent-single', agentName: 'reporter' },
    ])
    expect(deriveWrapperFanoutOutputs(def, 'w', new Map([[reporter.name, reporter]]))).toEqual([
      { name: '__done__', kind: 'signal' },
    ])
  })

  test('wrapper with empty nodeIds → __done__', () => {
    const def = defWith([{ id: 'w', kind: 'wrapper-fanout', nodeIds: [] }])
    expect(deriveWrapperFanoutOutputs(def, 'w', new Map())).toEqual([
      { name: '__done__', kind: 'signal' },
    ])
  })
})

describe('deriveWrapperFanoutOutputs — single aggregator', () => {
  test('mirrors aggregator outputs with default string kind', () => {
    const agg = baseAgent('merger', { role: 'aggregator', outputs: ['final', 'summary'] })
    const def = defWith([
      { id: 'w', kind: 'wrapper-fanout', nodeIds: ['agg'] },
      { id: 'agg', kind: 'agent-single', agentName: 'merger' },
    ])
    expect(deriveWrapperFanoutOutputs(def, 'w', new Map([[agg.name, agg]]))).toEqual([
      { name: 'final', kind: 'string' },
      { name: 'summary', kind: 'string' },
    ])
  })

  test('renames via outputWrapperPortNames; uses outputKinds', () => {
    const agg = baseAgent('merger', {
      role: 'aggregator',
      outputs: ['report', 'done'],
      outputKinds: { report: 'path<md>', done: 'signal' },
      outputWrapperPortNames: { report: 'final' },
    })
    const def = defWith([
      { id: 'w', kind: 'wrapper-fanout', nodeIds: ['agg'] },
      { id: 'agg', kind: 'agent-single', agentName: 'merger' },
    ])
    expect(deriveWrapperFanoutOutputs(def, 'w', new Map([[agg.name, agg]]))).toEqual([
      { name: 'final', kind: 'path<md>' },
      { name: 'done', kind: 'signal' },
    ])
  })

  test('aggregator inner alongside normal inner nodes — first-found wins', () => {
    const normal = baseAgent('worker')
    const agg = baseAgent('merger', { role: 'aggregator', outputs: ['final'] })
    const def = defWith([
      { id: 'w', kind: 'wrapper-fanout', nodeIds: ['n1', 'agg'] },
      { id: 'n1', kind: 'agent-single', agentName: 'worker' },
      { id: 'agg', kind: 'agent-single', agentName: 'merger' },
    ])
    expect(
      deriveWrapperFanoutOutputs(
        def,
        'w',
        new Map([
          [normal.name, normal],
          [agg.name, agg],
        ]),
      ),
    ).toEqual([{ name: 'final', kind: 'string' }])
  })
})

describe('deriveWrapperFanoutOutputs — multiple aggregators', () => {
  test('picks the first aggregator in nodeIds[] order (validator handles error)', () => {
    const a1 = baseAgent('merger_a', { role: 'aggregator', outputs: ['out_a'] })
    const a2 = baseAgent('merger_b', { role: 'aggregator', outputs: ['out_b'] })
    const def = defWith([
      { id: 'w', kind: 'wrapper-fanout', nodeIds: ['agg1', 'agg2'] },
      { id: 'agg1', kind: 'agent-single', agentName: 'merger_a' },
      { id: 'agg2', kind: 'agent-single', agentName: 'merger_b' },
    ])
    const result = deriveWrapperFanoutOutputs(
      def,
      'w',
      new Map([
        [a1.name, a1],
        [a2.name, a2],
      ]),
    )
    expect(result).toEqual([{ name: 'out_a', kind: 'string' }])
  })

  test('countFanoutAggregators reports total inside the wrapper', () => {
    const a1 = baseAgent('merger_a', { role: 'aggregator', outputs: ['out_a'] })
    const a2 = baseAgent('merger_b', { role: 'aggregator', outputs: ['out_b'] })
    const def = defWith([
      { id: 'w', kind: 'wrapper-fanout', nodeIds: ['agg1', 'agg2'] },
      { id: 'agg1', kind: 'agent-single', agentName: 'merger_a' },
      { id: 'agg2', kind: 'agent-single', agentName: 'merger_b' },
    ])
    expect(
      countFanoutAggregators(
        def,
        'w',
        new Map([
          [a1.name, a1],
          [a2.name, a2],
        ]),
      ),
    ).toBe(2)
  })
})

describe('findFanoutAggregator', () => {
  test('returns null when wrapper has no aggregator', () => {
    const def = defWith([{ id: 'w', kind: 'wrapper-fanout', nodeIds: [] }])
    expect(findFanoutAggregator(def, 'w', new Map())).toBeNull()
  })

  test('returns the first aggregator node+agent pair', () => {
    const agg = baseAgent('merger', { role: 'aggregator' })
    const def = defWith([
      { id: 'w', kind: 'wrapper-fanout', nodeIds: ['agg'] },
      { id: 'agg', kind: 'agent-single', agentName: 'merger' },
    ])
    const found = findFanoutAggregator(def, 'w', new Map([[agg.name, agg]]))
    expect(found?.node.id).toBe('agg')
    expect(found?.agent.name).toBe('merger')
  })
})

describe('lookup table flexibility', () => {
  test('accepts plain object as agent lookup', () => {
    const agg = baseAgent('merger', { role: 'aggregator', outputs: ['final'] })
    const def = defWith([
      { id: 'w', kind: 'wrapper-fanout', nodeIds: ['agg'] },
      { id: 'agg', kind: 'agent-single', agentName: 'merger' },
    ])
    expect(deriveWrapperFanoutOutputs(def, 'w', { [agg.name]: agg })).toEqual([
      { name: 'final', kind: 'string' },
    ])
  })
})
