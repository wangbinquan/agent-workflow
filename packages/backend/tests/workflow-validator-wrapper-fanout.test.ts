// RFC-060 PR-C — wrapper-fanout validator rules.
//
// Locks rules:
//   - wrapper-fanout-shard-source-missing (0 isShardSource)
//   - wrapper-fanout-shard-source-duplicate (2+ isShardSource)
//   - wrapper-fanout-shard-source-must-be-list (kind not list<T>)
//   - wrapper-fanout-nested (warning when nested inside another fanout)
//   - aggregator-agent-outside-fanout (PR-C refinement of PR-B blanket rule)
//   - multiple-aggregators-in-fanout
//   - boundary-input-* / boundary-output-* edge checks
//   - review-input-list-kind-not-supported
//   - review accepts path<md> kind (RFC-060 path<T> grammar)

import type { Agent, Skill, WorkflowDefinition } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import { validateWorkflowDef } from '../src/services/workflow.validator'

function agent(name: string, fields: Partial<Agent> = {}): Agent {
  return {
    id: `agent-${name}`,
    name,
    description: '',
    outputs: ['out'],
    readonly: false,
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

const EMPTY_SKILLS: Skill[] = []

function makeDef(parts: Partial<WorkflowDefinition>): WorkflowDefinition {
  return { $schema_version: 4, inputs: [], nodes: [], edges: [], ...parts }
}

function codesOf(def: WorkflowDefinition, agents: Agent[] = []): string[] {
  return validateWorkflowDef(def, { agents, skills: EMPTY_SKILLS }).issues.map((i) => i.code)
}

describe('wrapper-fanout — required fields', () => {
  test('no inputs → wrapper-fanout-shard-source-missing', () => {
    const def = makeDef({
      nodes: [
        { id: 'w', kind: 'wrapper-fanout', nodeIds: ['a'] },
        { id: 'a', kind: 'agent-single', agentName: 'reporter' },
      ],
    })
    expect(codesOf(def, [agent('reporter')])).toContain('wrapper-fanout-shard-source-missing')
  })

  test('two shardSource inputs → wrapper-fanout-shard-source-duplicate', () => {
    const def = makeDef({
      nodes: [
        {
          id: 'w',
          kind: 'wrapper-fanout',
          nodeIds: ['a'],
          inputs: [
            { name: 'docs', kind: 'list<path<md>>', isShardSource: true },
            { name: 'codes', kind: 'list<string>', isShardSource: true },
          ],
        },
        { id: 'a', kind: 'agent-single', agentName: 'reporter' },
      ],
    })
    expect(codesOf(def, [agent('reporter')])).toContain('wrapper-fanout-shard-source-duplicate')
  })

  test('shardSource not list<T> → wrapper-fanout-shard-source-must-be-list', () => {
    const def = makeDef({
      nodes: [
        {
          id: 'w',
          kind: 'wrapper-fanout',
          nodeIds: ['a'],
          inputs: [{ name: 'docs', kind: 'path<md>', isShardSource: true }],
        },
        { id: 'a', kind: 'agent-single', agentName: 'reporter' },
      ],
    })
    expect(codesOf(def, [agent('reporter')])).toContain('wrapper-fanout-shard-source-must-be-list')
  })

  test('valid wrapper-fanout passes shardSource validation', () => {
    const def = makeDef({
      nodes: [
        {
          id: 'w',
          kind: 'wrapper-fanout',
          nodeIds: ['a'],
          inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
        },
        { id: 'a', kind: 'agent-single', agentName: 'reporter' },
      ],
    })
    const codes = codesOf(def, [agent('reporter')])
    expect(codes).not.toContain('wrapper-fanout-shard-source-missing')
    expect(codes).not.toContain('wrapper-fanout-shard-source-duplicate')
    expect(codes).not.toContain('wrapper-fanout-shard-source-must-be-list')
  })
})

describe('wrapper-fanout — nested warning', () => {
  test('fanout inside fanout → wrapper-fanout-nested warning', () => {
    const def = makeDef({
      nodes: [
        {
          id: 'outer',
          kind: 'wrapper-fanout',
          nodeIds: ['inner'],
          inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
        },
        {
          id: 'inner',
          kind: 'wrapper-fanout',
          nodeIds: ['a'],
          inputs: [{ name: 'items', kind: 'list<string>', isShardSource: true }],
        },
        { id: 'a', kind: 'agent-single', agentName: 'reporter' },
      ],
    })
    const issues = validateWorkflowDef(def, {
      agents: [agent('reporter')],
      skills: EMPTY_SKILLS,
    }).issues
    const nested = issues.find((i) => i.code === 'wrapper-fanout-nested')
    expect(nested).not.toBeUndefined()
    expect(nested?.severity).toBe('warning')
  })
})

describe('aggregator placement (PR-C refinement)', () => {
  test('aggregator inner of wrapper-fanout → no aggregator-outside violation', () => {
    const def = makeDef({
      nodes: [
        {
          id: 'w',
          kind: 'wrapper-fanout',
          nodeIds: ['agg'],
          inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
        },
        { id: 'agg', kind: 'agent-single', agentName: 'merger' },
      ],
    })
    expect(codesOf(def, [agent('merger', { role: 'aggregator' })])).not.toContain(
      'aggregator-agent-outside-fanout',
    )
  })

  test('aggregator at top level → still flagged', () => {
    const def = makeDef({
      nodes: [{ id: 'n', kind: 'agent-single', agentName: 'merger' }],
    })
    expect(codesOf(def, [agent('merger', { role: 'aggregator' })])).toContain(
      'aggregator-agent-outside-fanout',
    )
  })

  test('aggregator inner of wrapper-git → still flagged (must be fanout)', () => {
    const def = makeDef({
      nodes: [
        { id: 'wg', kind: 'wrapper-git', nodeIds: ['agg'] },
        { id: 'agg', kind: 'agent-single', agentName: 'merger' },
      ],
    })
    expect(codesOf(def, [agent('merger', { role: 'aggregator' })])).toContain(
      'aggregator-agent-outside-fanout',
    )
  })
})

describe('multiple-aggregators-in-fanout', () => {
  test('two aggregators inside one fanout → flagged', () => {
    const def = makeDef({
      nodes: [
        {
          id: 'w',
          kind: 'wrapper-fanout',
          nodeIds: ['a1', 'a2'],
          inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
        },
        { id: 'a1', kind: 'agent-single', agentName: 'merger_a' },
        { id: 'a2', kind: 'agent-single', agentName: 'merger_b' },
      ],
    })
    expect(
      codesOf(def, [
        agent('merger_a', { role: 'aggregator' }),
        agent('merger_b', { role: 'aggregator' }),
      ]),
    ).toContain('multiple-aggregators-in-fanout')
  })

  test('one aggregator + one normal inside fanout → no multiple-aggregators issue', () => {
    const def = makeDef({
      nodes: [
        {
          id: 'w',
          kind: 'wrapper-fanout',
          nodeIds: ['agg', 'worker'],
          inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
        },
        { id: 'agg', kind: 'agent-single', agentName: 'merger' },
        { id: 'worker', kind: 'agent-single', agentName: 'reporter' },
      ],
    })
    expect(
      codesOf(def, [agent('merger', { role: 'aggregator' }), agent('reporter')]),
    ).not.toContain('multiple-aggregators-in-fanout')
  })
})

describe('boundary edges', () => {
  test('boundary=wrapper-input source not wrapper-fanout → flagged', () => {
    const def = makeDef({
      nodes: [
        { id: 'a', kind: 'agent-single', agentName: 'r', outputs: ['x'] },
        { id: 'b', kind: 'agent-single', agentName: 'r' },
      ],
      edges: [
        {
          id: 'e',
          source: { nodeId: 'a', portName: 'x' },
          target: { nodeId: 'b', portName: 'in' },
          boundary: 'wrapper-input',
        },
      ],
    })
    expect(codesOf(def, [agent('r', { outputs: ['x'] })])).toContain(
      'boundary-input-source-not-wrapper',
    )
  })

  test('boundary=wrapper-input port not declared on wrapper → flagged', () => {
    const def = makeDef({
      nodes: [
        {
          id: 'w',
          kind: 'wrapper-fanout',
          nodeIds: ['a'],
          inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
        },
        { id: 'a', kind: 'agent-single', agentName: 'r' },
      ],
      edges: [
        {
          id: 'e',
          source: { nodeId: 'w', portName: 'unknownport' },
          target: { nodeId: 'a', portName: 'in' },
          boundary: 'wrapper-input',
        },
      ],
    })
    expect(codesOf(def, [agent('r')])).toContain('boundary-input-port-not-declared')
  })

  test('boundary=wrapper-input target not inner → flagged', () => {
    const def = makeDef({
      nodes: [
        {
          id: 'w',
          kind: 'wrapper-fanout',
          nodeIds: ['a'],
          inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
        },
        { id: 'a', kind: 'agent-single', agentName: 'r' },
        { id: 'outsider', kind: 'agent-single', agentName: 'r' },
      ],
      edges: [
        {
          id: 'e',
          source: { nodeId: 'w', portName: 'docs' },
          target: { nodeId: 'outsider', portName: 'in' },
          boundary: 'wrapper-input',
        },
      ],
    })
    expect(codesOf(def, [agent('r')])).toContain('boundary-input-target-not-inner')
  })

  test('boundary=wrapper-output source must be aggregator → non-aggregator flagged', () => {
    const def = makeDef({
      nodes: [
        {
          id: 'w',
          kind: 'wrapper-fanout',
          nodeIds: ['worker'],
          inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
        },
        { id: 'worker', kind: 'agent-single', agentName: 'reporter', outputs: ['out'] },
      ],
      edges: [
        {
          id: 'e',
          source: { nodeId: 'worker', portName: 'out' },
          target: { nodeId: 'w', portName: 'final' },
          boundary: 'wrapper-output',
        },
      ],
    })
    expect(codesOf(def, [agent('reporter', { outputs: ['out'] })])).toContain(
      'boundary-output-source-must-be-aggregator',
    )
  })

  test('boundary=wrapper-output aggregator source → no violation', () => {
    const def = makeDef({
      nodes: [
        {
          id: 'w',
          kind: 'wrapper-fanout',
          nodeIds: ['agg'],
          inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
        },
        { id: 'agg', kind: 'agent-single', agentName: 'merger' },
      ],
      edges: [
        {
          id: 'e',
          source: { nodeId: 'agg', portName: 'final' },
          target: { nodeId: 'w', portName: 'final' },
          boundary: 'wrapper-output',
        },
      ],
    })
    const codes = codesOf(def, [agent('merger', { role: 'aggregator', outputs: ['final'] })])
    expect(codes).not.toContain('boundary-output-source-must-be-aggregator')
  })
})

describe('review-input-list-kind-not-supported', () => {
  test('review input pointing at list<T> port → flagged', () => {
    const def = makeDef({
      nodes: [
        {
          id: 'reporter',
          kind: 'agent-single',
          agentName: 'reporter',
          outputs: ['docs'],
        },
        {
          id: 'rev',
          kind: 'review',
          inputSource: { nodeId: 'reporter', portName: 'docs' },
        },
      ],
    })
    expect(
      codesOf(def, [
        agent('reporter', {
          outputs: ['docs'],
          outputKinds: { docs: 'list<path<md>>' },
        }),
      ]),
    ).toContain('review-input-list-kind-not-supported')
  })

  test('review input on path<md> → accepted', () => {
    const def = makeDef({
      nodes: [
        {
          id: 'reporter',
          kind: 'agent-single',
          agentName: 'reporter',
          outputs: ['report'],
        },
        {
          id: 'rev',
          kind: 'review',
          inputSource: { nodeId: 'reporter', portName: 'report' },
        },
      ],
    })
    const codes = codesOf(def, [
      agent('reporter', { outputs: ['report'], outputKinds: { report: 'path<md>' } }),
    ])
    expect(codes).not.toContain('review-input-source-not-markdown')
    expect(codes).not.toContain('review-input-list-kind-not-supported')
  })

  test("review input on legacy 'markdown_file' literal still accepted", () => {
    const def = makeDef({
      nodes: [
        {
          id: 'reporter',
          kind: 'agent-single',
          agentName: 'reporter',
          outputs: ['report'],
        },
        {
          id: 'rev',
          kind: 'review',
          inputSource: { nodeId: 'reporter', portName: 'report' },
        },
      ],
    })
    const codes = codesOf(def, [
      agent('reporter', { outputs: ['report'], outputKinds: { report: 'markdown_file' } }),
    ])
    expect(codes).not.toContain('review-input-source-not-markdown')
    expect(codes).not.toContain('review-input-list-kind-not-supported')
  })

  test('review input on string kind → still flagged as not-markdown', () => {
    const def = makeDef({
      nodes: [
        {
          id: 'reporter',
          kind: 'agent-single',
          agentName: 'reporter',
          outputs: ['note'],
        },
        {
          id: 'rev',
          kind: 'review',
          inputSource: { nodeId: 'reporter', portName: 'note' },
        },
      ],
    })
    expect(
      codesOf(def, [agent('reporter', { outputs: ['note'], outputKinds: { note: 'string' } })]),
    ).toContain('review-input-source-not-markdown')
  })
})
