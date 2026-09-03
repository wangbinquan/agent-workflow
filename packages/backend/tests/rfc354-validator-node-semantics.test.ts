// RFC-354 — validator side of the unified node model (parameters / returns /
// closures / frames). Locks, in one place:
//   1. loop-in-loop is LEGAL again — the RFC-094 `wrapper-loop-nested` ban is
//      retired because node_runs now carries a frame axis (container_run_id);
//      any nesting depth, directly or through wrapper-git, validates.
//   2. wrapper-git / wrapper-loop accept inbound edges: an inbound edge is a
//      PARAMETER (edge-derived like agent inputs), so the old
//      "does not accept inbound edges in v1" `edge-target-port-missing` is gone.
//   3. a `wrapper-input` boundary edge out of a loop / git must name one of
//      those edge-derived parameters (`boundary-input-port-not-declared`,
//      generalized from fanout-only).
//   4. the fan-out BODY stays agent-only, now at schema time:
//      `wrapper-fanout-unsupported-inner-kind` mirrors the runtime rejection in
//      engine/wrapper/fanoutStrategy.ts (`v1-unsupported-inner-kind`). Kinds
//      with their own placement rule (script / call-*) are not double-reported.

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

const AGENTS = [valAgent('worker'), valAgent('agg', { role: 'aggregator' } as Partial<Agent>)]

function def(
  nodes: Array<Record<string, unknown>>,
  edges: Array<Record<string, unknown>> = [],
  inputs: Array<Record<string, unknown>> = [],
): WorkflowDefinition {
  return { $schema_version: 5, inputs, nodes, edges } as unknown as WorkflowDefinition
}

const DOCS_INPUT = [{ kind: 'text', key: 'docs', label: 'docs' }]

const loop = (id: string, nodeIds: string[], exitNodeId = 'w'): Record<string, unknown> => ({
  id,
  kind: 'wrapper-loop',
  nodeIds,
  maxIterations: 2,
  exitCondition: { kind: 'port-empty', nodeId: exitNodeId, portName: 'result' },
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
const input = (id: string, key = 'docs'): Record<string, unknown> => ({
  id,
  kind: 'input',
  inputKey: key,
})

function codes(d: WorkflowDefinition, pointer?: string): string[] {
  const res = validateWorkflowDef(d, { agents: AGENTS, skills: [] })
  return res.issues.filter((i) => pointer === undefined || i.pointer === pointer).map((i) => i.code)
}

describe('RFC-354 §1 — nested loops validate (wrapper-loop-nested retired)', () => {
  test('direct loop-in-loop: no error on the inner loop', () => {
    const d = def([loop('outer', ['inner'], 'inner'), loop('inner', ['w']), agent('w')])
    expect(codes(d)).not.toContain('wrapper-loop-nested')
    // The outer exit condition points at the inner loop, which has no port
    // `result` — that is a genuine authoring error and must still surface; it
    // is unrelated to nesting.
    expect(codes(d, 'inner')).toEqual([])
  })

  test('three levels: loop ⊃ git ⊃ loop ⊃ agent', () => {
    const d = def([
      loop('outer', ['g'], 'g'),
      git('g', ['inner']),
      loop('inner', ['w']),
      agent('w'),
    ])
    expect(codes(d, 'inner')).toEqual([])
    expect(codes(d, 'g')).toEqual([])
    expect(codes(d)).not.toContain('wrapper-loop-nested')
  })

  test('the retired code never appears anywhere', () => {
    const d = def([loop('a', ['b'], 'b'), loop('b', ['c'], 'c'), loop('c', ['w']), agent('w')])
    expect(codes(d)).not.toContain('wrapper-loop-nested')
  })
})

describe('RFC-354 §2 — loop / git inbound edges are parameters', () => {
  test('an edge into a wrapper-loop is accepted (no edge-target-port-missing)', () => {
    const d = def(
      [input('docs_in'), loop('l', ['w']), agent('w')],
      [
        {
          id: 'e1',
          source: { nodeId: 'docs_in', portName: 'docs' },
          target: { nodeId: 'l', portName: 'docs' },
        },
      ],
      DOCS_INPUT,
    )
    expect(codes(d, 'e1')).not.toContain('edge-target-port-missing')
  })

  test('an edge into a wrapper-git is accepted', () => {
    const d = def(
      [input('docs_in'), git('g', ['w']), agent('w')],
      [
        {
          id: 'e1',
          source: { nodeId: 'docs_in', portName: 'docs' },
          target: { nodeId: 'g', portName: 'docs' },
        },
      ],
      DOCS_INPUT,
    )
    expect(codes(d, 'e1')).not.toContain('edge-target-port-missing')
  })
})

describe('RFC-354 §3 — wrapper-input boundary edges out of a loop / git', () => {
  const body = (extraEdges: Array<Record<string, unknown>>) =>
    def(
      [input('docs_in'), loop('l', ['w']), agent('w')],
      [
        {
          id: 'param',
          source: { nodeId: 'docs_in', portName: 'docs' },
          target: { nodeId: 'l', portName: 'docs' },
        },
        ...extraEdges,
      ],
      DOCS_INPUT,
    )

  test('routing a declared parameter into the body is legal', () => {
    const d = body([
      {
        id: 'b1',
        boundary: 'wrapper-input',
        source: { nodeId: 'l', portName: 'docs' },
        target: { nodeId: 'w', portName: 'docs' },
      },
    ])
    expect(codes(d, 'b1')).toEqual([])
  })

  test('routing a parameter nobody wired is boundary-input-port-not-declared', () => {
    const d = body([
      {
        id: 'b1',
        boundary: 'wrapper-input',
        source: { nodeId: 'l', portName: 'nope' },
        target: { nodeId: 'w', portName: 'docs' },
      },
    ])
    expect(codes(d, 'b1')).toContain('boundary-input-port-not-declared')
  })

  test('a wrapper-input edge whose source is not a wrapper is still rejected', () => {
    const d = body([
      {
        id: 'b1',
        boundary: 'wrapper-input',
        source: { nodeId: 'docs_in', portName: 'docs' },
        target: { nodeId: 'w', portName: 'docs' },
      },
    ])
    expect(codes(d, 'b1')).toContain('boundary-input-source-not-wrapper')
  })
})

describe('RFC-354 §4 — fan-out bodies stay agent-only, at schema time', () => {
  test('a loop inside a fanout is an error on the loop', () => {
    const d = def([fanout('fan', ['inner']), loop('inner', ['w']), agent('w')], [], DOCS_INPUT)
    expect(codes(d, 'inner')).toContain('wrapper-fanout-unsupported-inner-kind')
  })

  test('a git wrapper inside a fanout is an error (transitively, through a loop)', () => {
    const d = def(
      [fanout('fan', ['inner']), loop('inner', ['g']), git('g', ['w']), agent('w')],
      [],
      DOCS_INPUT,
    )
    expect(codes(d, 'g')).toContain('wrapper-fanout-unsupported-inner-kind')
  })

  test('a single agent inside a fanout is fine; loops around a fanout are fine', () => {
    const d = def([loop('l', ['fan'], 'fan'), fanout('fan', ['w']), agent('w')], [], DOCS_INPUT)
    expect(codes(d)).not.toContain('wrapper-fanout-unsupported-inner-kind')
  })

  test('script nodes keep their own placement rule and are not double-reported', () => {
    const d = def(
      [
        fanout('fan', ['s']),
        { id: 's', kind: 'script', language: 'bash', body: 'echo hi', outputs: [] },
      ],
      [],
      DOCS_INPUT,
    )
    const c = codes(d, 's')
    expect(c).toContain('script-in-fanout-unsupported')
    expect(c).not.toContain('wrapper-fanout-unsupported-inner-kind')
  })
})
