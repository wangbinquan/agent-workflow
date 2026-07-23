// RFC-060 PR-C — wrapper-fanout aggregator-detection boundary tests.
//
// Locks the two SILENT SKIPS in isAggregatorAgentNode that the existing
// suite (wrapper-fanout-outputs.test.ts) never exercises — every test there
// uses an `agent-single` inner node whose agent is PRESENT in the lookup Map,
// so neither boundary is currently regression-protected:
//
//  GAP 1a — non-agent-single rejection (wrapperFanout.ts:53):
//    isAggregatorAgentNode returns null unless node.kind === 'agent-single'.
//    A wrapper-fanout whose only inner nodes are NON-agent-single kinds
//    (e.g. wrapper-git / review) therefore has NO aggregator: findFanoutAggregator
//    === null, countFanoutAggregators === 0, and deriveWrapperFanoutOutputs
//    collapses to the implicit __done__ signal outlet.
//
//    NOTE: the gap was originally phrased as "an aggregator-role agent attached
//    to an `agent-multi` inner node is ignored". That premise is FICTIONAL:
//    'agent-multi' is a SUPERSEDED/dead NodeKind (schemas/workflow.ts:41-45,
//    removed from NODE_KIND by RFC-060) — it is no longer authorable, fails the
//    validator with `unknown-node-kind`, and a literal {kind:'agent-multi'} is a
//    TS2322 error under the WorkflowDefinition['nodes'] type. We instead cover
//    the SAME line-53 branch with current, authorable non-agent-single inner
//    kinds (wrapper-git, review). See deviations in the task summary.
//
//  GAP 1b — unknown agent-id skip (wrapperFanout.ts:56-57):
//    An agent-single inner referencing an agent ID absent from the lookup
//    table resolves to `undefined` and is skipped WITHOUT throwing. A mix of
//    [missing-agent, valid-aggregator] must still return the valid aggregator.
//
// A refactor that loosened the kind check or threw on a missing agent would
// pass every test in wrapper-fanout-outputs.test.ts but break these.

import { describe, expect, test } from 'bun:test'
import type { Agent } from '../src/schemas/agent'
import type { WorkflowDefinition } from '../src/schemas/workflow'
import {
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

describe('wrapper-fanout aggregator detection — non-agent-single inner kinds (line 53 rejection)', () => {
  test('aggregator-role agent matters only via agent-single; wrapper-git inner is not an aggregator → __done__', () => {
    // Even though `merger` is an aggregator agent in the lookup, the inner node
    // is a wrapper-git (non-agent-single), so isAggregatorAgentNode bails at
    // line 53 — the wrapper collapses to the implicit __done__ signal outlet.
    const merger = baseAgent('merger', { role: 'aggregator', outputs: ['final'] })
    const def = defWith([
      { id: 'w', kind: 'wrapper-fanout', nodeIds: ['g'] },
      { id: 'g', kind: 'wrapper-git', nodeIds: [] },
    ])
    const lookup = new Map([[merger.id, merger]])

    expect(findFanoutAggregator(def, 'w', lookup)).toBeNull()
    expect(countFanoutAggregators(def, 'w', lookup)).toBe(0)
    expect(deriveWrapperFanoutOutputs(def, 'w', lookup)).toEqual([
      { name: '__done__', kind: 'signal' },
    ])
  })

  test('review inner node is not an aggregator → null / 0 / __done__', () => {
    const def = defWith([
      { id: 'w', kind: 'wrapper-fanout', nodeIds: ['r'] },
      { id: 'r', kind: 'review', title: 'gate' },
    ])

    expect(findFanoutAggregator(def, 'w', new Map())).toBeNull()
    expect(countFanoutAggregators(def, 'w', new Map())).toBe(0)
    expect(deriveWrapperFanoutOutputs(def, 'w', new Map())).toEqual([
      { name: '__done__', kind: 'signal' },
    ])
  })
})

describe('wrapper-fanout aggregator detection — unknown agent id skip (lines 56-57)', () => {
  test('agent-single inner referencing an id absent from the lookup → null, no throw', () => {
    const def = defWith([
      { id: 'w', kind: 'wrapper-fanout', nodeIds: ['a'] },
      { id: 'a', kind: 'agent-single', agentId: 'agent-ghost', agentName: 'ghost' },
    ])
    // 'ghost' is absent from the (empty) lookup → lookupAgent returns undefined.
    expect(() => findFanoutAggregator(def, 'w', new Map())).not.toThrow()
    expect(findFanoutAggregator(def, 'w', new Map())).toBeNull()
    expect(countFanoutAggregators(def, 'w', new Map())).toBe(0)
    expect(deriveWrapperFanoutOutputs(def, 'w', new Map())).toEqual([
      { name: '__done__', kind: 'signal' },
    ])
  })

  test('[missing-agent, valid-aggregator] → skips unresolvable first, returns valid aggregator', () => {
    const agg = baseAgent('merger', { role: 'aggregator', outputs: ['final'] })
    const def = defWith([
      { id: 'w', kind: 'wrapper-fanout', nodeIds: ['ghostNode', 'aggNode'] },
      // first inner references a missing agent id (skipped at line 57)
      { id: 'ghostNode', kind: 'agent-single', agentId: 'agent-ghost', agentName: 'ghost' },
      // second inner is a valid agent-single aggregator
      { id: 'aggNode', kind: 'agent-single', agentId: agg.id, agentName: 'merger' },
    ])
    // lookup has ONLY the valid aggregator, not 'ghost'
    const lookup = new Map([[agg.id, agg]])

    const found = findFanoutAggregator(def, 'w', lookup)
    expect(found?.node.id).toBe('aggNode')
    expect(found?.agent.name).toBe('merger')
    expect(countFanoutAggregators(def, 'w', lookup)).toBe(1)
    expect(deriveWrapperFanoutOutputs(def, 'w', lookup)).toEqual([
      { name: 'final', kind: 'string' },
    ])
  })

  test('accepts a plain object lookup with the missing name as undefined → skipped, no throw', () => {
    const agg = baseAgent('merger', { role: 'aggregator', outputs: ['final'] })
    const def = defWith([
      { id: 'w', kind: 'wrapper-fanout', nodeIds: ['ghostNode', 'aggNode'] },
      { id: 'ghostNode', kind: 'agent-single', agentId: 'agent-ghost', agentName: 'ghost' },
      { id: 'aggNode', kind: 'agent-single', agentId: agg.id, agentName: 'merger' },
    ])
    // plain-object form; 'ghost' explicitly undefined exercises the same skip
    const lookup: Record<string, Agent | undefined> = {
      'agent-ghost': undefined,
      [agg.id]: agg,
    }

    const found = findFanoutAggregator(def, 'w', lookup)
    expect(found?.node.id).toBe('aggNode')
    expect(countFanoutAggregators(def, 'w', lookup)).toBe(1)
  })
})
