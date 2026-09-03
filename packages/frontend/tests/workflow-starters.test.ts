import { describe, expect, test } from 'vitest'
import type { Agent } from '@agent-workflow/shared'
import {
  WORKFLOW_STARTER_CATALOG,
  planWorkflowStarter,
  workflowStarterAgentIneligibleReason,
} from '../src/lib/workflow-starters'

function agent(
  name: string,
  options: Partial<Pick<Agent, 'outputs' | 'outputKinds' | 'role' | 'outputWrapperPortNames'>> = {},
): Agent {
  return {
    id: `id-${name}`,
    name,
    description: '',
    outputs: options.outputs ?? ['result'],
    outputKinds: options.outputKinds ?? { result: 'markdown' },
    outputWrapperPortNames: options.outputWrapperPortNames,
    role: options.role,
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
}

describe('RFC-199 T11 starter catalog', () => {
  test('contains the two trusted candidates plus blank-to-picker', () => {
    expect(WORKFLOW_STARTER_CATALOG.map((entry) => entry.id)).toEqual([
      'standard-development',
      'audit-only',
      'blank',
    ])
  })

  test('standard candidate wires git_diff through fan-out aggregation and output promotion', () => {
    const agents = [
      agent('coder'),
      agent('auditor', { outputs: ['finding'], outputKinds: { finding: 'markdown' } }),
      agent('aggregator', {
        role: 'aggregator',
        outputs: ['summary'],
        outputKinds: { summary: 'markdown' },
        outputWrapperPortNames: { summary: 'audit_summary' },
      }),
      agent('fixer', { outputs: ['patch'], outputKinds: { patch: 'markdown' } }),
    ]
    const planned = planWorkflowStarter(
      'standard-development',
      {
        coder: 'id-coder',
        auditor: 'id-auditor',
        aggregator: 'id-aggregator',
        fixer: 'id-fixer',
      },
      agents,
    )
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.definition.nodes.find((node) => node.id === 'starter_git')).toMatchObject({
      kind: 'wrapper-git',
      nodeIds: ['starter_coder'],
    })
    // RFC-354: the fan-out parameter is the `git_diff` edge; the node only names the shard source.
    expect(planned.definition.nodes.find((node) => node.id === 'starter_fanout')).toEqual({
      id: 'starter_fanout',
      kind: 'wrapper-fanout',
      title: expect.any(String),
      nodeIds: ['starter_auditor', 'starter_aggregator'],
      shardSourcePort: 'changed_files',
      position: expect.any(Object),
    })
    expect(planned.definition.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: { nodeId: 'starter_git', portName: 'git_diff' },
          target: { nodeId: 'starter_fanout', portName: 'changed_files' },
        }),
        expect.objectContaining({
          source: { nodeId: 'starter_fanout', portName: 'audit_summary' },
          target: { nodeId: 'starter_fixer', portName: 'findings' },
        }),
      ]),
    )
    expect(planned.outputPorts.aggregator).toBe('summary')
  })

  test('preflight rejects a non-aggregator and signal-only output roles', () => {
    expect(workflowStarterAgentIneligibleReason('aggregator', agent('plain'))).toBe(
      'aggregator-role-required',
    )
    expect(
      workflowStarterAgentIneligibleReason(
        'auditor',
        agent('signal-only', { outputs: ['done'], outputKinds: { done: 'signal' } }),
      ),
    ).toBe('data-output-required')
  })

  test('audit-only candidate binds the selected agent output once', () => {
    const planned = planWorkflowStarter('audit-only', { auditor: 'id-audit' }, [
      agent('audit', { outputs: ['report'], outputKinds: { report: 'markdown' } }),
    ])
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.definition.nodes).toHaveLength(3)
    expect(planned.definition.edges).toHaveLength(2)
    // RFC-354: the output port IS the edge into the output node.
    const outputNode = planned.definition.nodes.at(-1) as unknown as Record<string, unknown>
    expect(outputNode).toMatchObject({ id: 'starter_output', kind: 'output' })
    expect('ports' in outputNode).toBe(false)
    expect(planned.definition.edges).toContainEqual(
      expect.objectContaining({
        source: { nodeId: 'starter_auditor', portName: 'report' },
        target: { nodeId: 'starter_output', portName: 'audit_report' },
      }),
    )
  })
})
