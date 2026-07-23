// RFC-094 (audit WP-6a) — validator guardrails for broken topologies.
//
// What this locks in (design/RFC-094-validator-guardrails/design.md §1):
//   1. `wrapper-loop-nested` (error): a wrapper-loop nested — directly OR
//      transitively through other wrappers — inside another wrapper-loop is
//      rejected. node_runs rows have no parent-scope axis, so the inner loop
//      silently no-ops from the outer loop's 2nd round (audit S-6; runtime
//      current behavior locked by scheduler-audit-s06). Non-loop-in-loop
//      wrapper combinations stay legal.
//   2. `fanout-inner-chain-unsupported` (error): a non-boundary data edge
//      between two inner nodes of the same wrapper-fanout whose target is not
//      the aggregator is rejected (audit S-5: the dispatch side never feeds
//      per-shard chains; the target reads an EMPTY port). Edges into the
//      aggregator, clarify-channel edges and boundary edges stay legal.
//   3. Audit gap ⑥-9 regression: a legal boundary='wrapper-input' edge no
//      longer misfires `edge-source-port-missing` (rule 2 exempts it; rule 4's
//      `boundary-input-port-not-declared` still validates the UNDECLARED case
//      — asserted here so the exemption cannot eat rule 4's job).
//
// These rules gate task LAUNCH only (createTask, task.ts) — canvas saves are
// not blocked (proposal.md §静态校验 "校验失败不阻止保存，但阻止启动 task").

import type { Agent, WorkflowDefinition } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import { validateWorkflowDef } from '../src/services/workflow.validator'

function valAgent(name: string, fields: Partial<Agent> = {}): Agent {
  return {
    id: `agent-${name}`,
    name,
    description: '',
    outputs: ['result'],
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

const AGENTS = [
  valAgent('worker'),
  valAgent('auditor'),
  valAgent('fixer'),
  valAgent('agg', { role: 'aggregator' } as Partial<Agent>),
]

function def(
  nodes: Array<Record<string, unknown>>,
  edges: Array<Record<string, unknown>> = [],
  inputs: Array<Record<string, unknown>> = [],
): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs,
    nodes,
    edges,
  } as unknown as WorkflowDefinition
}

const DOCS_INPUT = [{ kind: 'text', key: 'docs', label: 'docs' }]

const loop = (id: string, nodeIds: string[]): Record<string, unknown> => ({
  id,
  kind: 'wrapper-loop',
  nodeIds,
  maxIterations: 2,
  exitCondition: { kind: 'port-empty', nodeId: 'w', portName: 'result' },
  outputBindings: [],
})
const git = (id: string, nodeIds: string[]): Record<string, unknown> => ({
  id,
  kind: 'wrapper-git',
  nodeIds,
})
const fanout = (id: string, nodeIds: string[]): Record<string, unknown> => ({
  id,
  kind: 'wrapper-fanout',
  nodeIds,
  inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
})
const agent = (id: string, agentName = 'worker'): Record<string, unknown> => ({
  id,
  kind: 'agent-single',
  agentId: `agent-${agentName}`,
  agentName,
})

function codesFor(d: WorkflowDefinition, pointer?: string): string[] {
  const res = validateWorkflowDef(d, { agents: AGENTS, skills: [] })
  return res.issues.filter((i) => pointer === undefined || i.pointer === pointer).map((i) => i.code)
}

describe('RFC-094 rule 1 — wrapper-loop-nested (audit S-6)', () => {
  test('direct loop-in-loop → error on the inner loop', () => {
    const d = def([loop('outer', ['inner']), loop('inner', ['w']), agent('w')])
    expect(codesFor(d, 'inner')).toContain('wrapper-loop-nested')
  })

  test('transitive loop→git→loop → error (same iteration-axis collision)', () => {
    const d = def([loop('outer', ['g']), git('g', ['inner']), loop('inner', ['w']), agent('w')])
    expect(codesFor(d, 'inner')).toContain('wrapper-loop-nested')
  })

  test('transitive loop→fanout→loop → error', () => {
    const d = def([
      loop('outer', ['fan']),
      fanout('fan', ['inner']),
      loop('inner', ['w']),
      agent('w'),
    ])
    expect(codesFor(d, 'inner')).toContain('wrapper-loop-nested')
  })

  test('non-loop-in-loop combinations stay legal: git-in-loop / loop-in-git / fanout-in-loop / single loop', () => {
    const combos: WorkflowDefinition[] = [
      def([loop('l', ['g']), git('g', ['w']), agent('w')]),
      def([git('g', ['l']), loop('l', ['w']), agent('w')]),
      def([loop('l', ['fan']), fanout('fan', ['w']), agent('w')]),
      def([loop('l', ['w']), agent('w')]),
    ]
    for (const d of combos) {
      const res = validateWorkflowDef(d, { agents: AGENTS, skills: [] })
      expect(res.issues.map((i) => i.code)).not.toContain('wrapper-loop-nested')
    }
  })
})

describe('RFC-094 rule 2 — fanout-inner-chain-unsupported (audit S-5)', () => {
  const baseNodes = (fixAgent: string): Array<Record<string, unknown>> => [
    fanout('fan', ['a', 'b']),
    agent('a', 'auditor'),
    agent('b', fixAgent),
  ]
  const chainEdge = {
    id: 'eChain',
    source: { nodeId: 'a', portName: 'result' },
    target: { nodeId: 'b', portName: 'findings' },
  }

  test('inner → non-aggregator inner data edge → error', () => {
    const d = def(baseNodes('fixer'), [chainEdge])
    const res = validateWorkflowDef(d, { agents: AGENTS, skills: [] })
    const hit = res.issues.filter((i) => i.pointer === 'eChain')
    expect(hit.map((i) => i.code)).toEqual(['fanout-inner-chain-unsupported'])
    expect((hit[0]!.severity ?? 'error') as string).toBe('error')
  })

  test('inner → aggregator edge stays legal', () => {
    const d = def(baseNodes('agg'), [chainEdge])
    expect(codesFor(d, 'eChain')).toEqual([])
  })

  test('clarify-channel edge inside the fanout stays legal', () => {
    const d = def(
      [
        fanout('fan', ['a', 'cl']),
        agent('a', 'auditor'),
        { id: 'cl', kind: 'clarify', maxRounds: 1 },
      ],
      [
        {
          id: 'eAsk',
          source: { nodeId: 'a', portName: '__clarify__' },
          target: { nodeId: 'cl', portName: 'questions' },
        },
      ],
    )
    expect(codesFor(d, 'eAsk')).not.toContain('fanout-inner-chain-unsupported')
  })

  test('cross-fanout / top-level edges are not in scope of this rule', () => {
    const d = def(
      [fanout('fan', ['a']), agent('a', 'auditor'), agent('top', 'fixer')],
      [
        {
          id: 'eOut',
          source: { nodeId: 'top', portName: 'result' },
          target: { nodeId: 'a', portName: 'extra' },
        },
      ],
    )
    expect(codesFor(d, 'eOut')).not.toContain('fanout-inner-chain-unsupported')
  })
})

describe('RFC-094 rule 3 — boundary edge false positive fixed (audit gap ⑥-9)', () => {
  test('a declared wrapper-input boundary edge produces no edge-source-port-missing', () => {
    const d = def(
      [{ id: 'inp', kind: 'input', inputKey: 'docs' }, fanout('fan', ['a']), agent('a', 'auditor')],
      [
        {
          id: 'e1',
          source: { nodeId: 'inp', portName: 'docs' },
          target: { nodeId: 'fan', portName: 'docs' },
        },
        {
          id: 'eB',
          source: { nodeId: 'fan', portName: 'docs' },
          target: { nodeId: 'a', portName: 'doc' },
          boundary: 'wrapper-input',
        },
      ],

      DOCS_INPUT,
    )
    const res = validateWorkflowDef(d, { agents: AGENTS, skills: [] })
    expect(res.issues.filter((i) => i.pointer === 'eB')).toEqual([])
    expect(res.ok).toBe(true)
  })

  test("rule 4 still catches an UNDECLARED boundary source port (the exemption doesn't eat rule 4's job)", () => {
    const d = def(
      [{ id: 'inp', kind: 'input', inputKey: 'docs' }, fanout('fan', ['a']), agent('a', 'auditor')],
      [
        {
          id: 'e1',
          source: { nodeId: 'inp', portName: 'docs' },
          target: { nodeId: 'fan', portName: 'docs' },
        },
        {
          id: 'eBad',
          source: { nodeId: 'fan', portName: 'no-such-port' },
          target: { nodeId: 'a', portName: 'doc' },
          boundary: 'wrapper-input',
        },
      ],

      DOCS_INPUT,
    )
    const codes = codesFor(d, 'eBad')
    expect(codes).toContain('boundary-input-port-not-declared')
    expect(codes).not.toContain('edge-source-port-missing')
  })
})
