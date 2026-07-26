// Regression discovered by the executable workflow catalog:
// wrapper-fanout boundary edges describe container plumbing, not ordinary DAG
// dependencies. Counting both wrapper-input and wrapper-output in the global
// cycle graph turns every complete worker → aggregator fanout into the false
// cycle fanout → worker → aggregator → fanout and blocks task launch.

import type { Agent, WorkflowDefinition } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import { validateWorkflowDef } from '../src/services/workflow.validator'

function agent(
  id: string,
  outputs: string[],
  fields: Partial<Pick<Agent, 'role' | 'outputWrapperPortNames'>> = {},
): Agent {
  return {
    id,
    name: id,
    description: '',
    outputs,
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

describe('wrapper-fanout boundary edges are not ordinary topology edges', () => {
  test('full shard-input + aggregator-output plumbing does not create a topology-cycle', () => {
    const definition: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [{ kind: 'files', key: 'docs', label: 'Documents' }],
      nodes: [
        { id: 'input', kind: 'input', inputKey: 'docs' },
        {
          id: 'fanout',
          kind: 'wrapper-fanout',
          nodeIds: ['worker', 'aggregator'],
          inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
        },
        {
          id: 'worker',
          kind: 'agent-single',
          agentId: 'worker-agent',
          agentName: 'worker-agent',
        },
        {
          id: 'aggregator',
          kind: 'agent-single',
          agentId: 'aggregator-agent',
          agentName: 'aggregator-agent',
        },
        {
          id: 'output',
          kind: 'output',
          ports: [{ name: 'report', bind: { nodeId: 'fanout', portName: 'report' } }],
        },
      ],
      edges: [
        {
          id: 'input-to-fanout',
          source: { nodeId: 'input', portName: 'docs' },
          target: { nodeId: 'fanout', portName: 'docs' },
        },
        {
          id: 'fanout-to-worker',
          boundary: 'wrapper-input',
          source: { nodeId: 'fanout', portName: 'docs' },
          target: { nodeId: 'worker', portName: 'doc' },
        },
        {
          id: 'worker-to-aggregator',
          source: { nodeId: 'worker', portName: 'finding' },
          target: { nodeId: 'aggregator', portName: 'findings' },
        },
        {
          id: 'aggregator-to-fanout',
          boundary: 'wrapper-output',
          source: { nodeId: 'aggregator', portName: 'report' },
          target: { nodeId: 'fanout', portName: 'report' },
        },
        {
          id: 'fanout-to-output',
          source: { nodeId: 'fanout', portName: 'report' },
          target: { nodeId: 'output', portName: 'report' },
        },
      ],
    }
    const result = validateWorkflowDef(definition, {
      agents: [
        agent('worker-agent', ['finding']),
        agent('aggregator-agent', ['report'], {
          role: 'aggregator',
          outputWrapperPortNames: { report: 'report' },
        }),
      ],
      skills: [],
    })

    expect(result.issues.map((issue) => issue.code)).not.toContain('topology-cycle')
    expect(result.ok).toBe(true)
  })
})
