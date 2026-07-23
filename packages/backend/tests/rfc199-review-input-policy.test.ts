// RFC-199 G2 — review's single fixed input is one shared policy at both the
// editor planner and the authoritative save/import validator boundary.

import {
  REVIEW_INPUT_PORT_NAME,
  type Agent,
  type WorkflowDefinition,
  type WorkflowEdge,
} from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import { validateWorkflowDef } from '../src/services/workflow.validator'

function agent(name: string): Agent {
  return {
    id: `agent-${name}`,
    name,
    description: '',
    outputs: ['doc'],
    outputKinds: { doc: 'markdown' },
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

const agents = [agent('source'), agent('other')]

function edge(
  id: string,
  sourceNodeId: string,
  targetPortName: string = REVIEW_INPUT_PORT_NAME,
): WorkflowEdge {
  return {
    id,
    source: { nodeId: sourceNodeId, portName: 'doc' },
    target: { nodeId: 'review', portName: targetPortName },
  }
}

function definition(edges: WorkflowEdge[]): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [
      {
        id: 'source',
        kind: 'agent-single',
        agentId: 'agent-source',
        agentName: 'source',
      },
      {
        id: 'other',
        kind: 'agent-single',
        agentId: 'agent-other',
        agentName: 'other',
      },
      {
        id: 'review',
        kind: 'review',
        inputSource: { nodeId: 'source', portName: 'doc' },
        rerunnableOnReject: ['source'],
        rerunnableOnIterate: ['source'],
      },
    ],
    edges,
  }
}

function codes(def: WorkflowDefinition): string[] {
  return validateWorkflowDef(def, { agents, skills: [] }).issues.map((issue) => issue.code)
}

describe('RFC-199 review fixed-input validator policy', () => {
  test('accepts the canonical fixed port and matching inputSource mirror', () => {
    const result = codes(definition([edge('canonical', 'source')]))
    expect(result).not.toContain('edge-target-port-missing')
    expect(result).not.toContain('review-input-edge-conflict')
    expect(result).not.toContain('review-input-edge-mismatch')
  })

  test('rejects an arbitrary target port', () => {
    expect(codes(definition([edge('wrong-port', 'source', 'document')]))).toContain(
      'edge-target-port-missing',
    )
  })

  test('rejects multiple inbound edges instead of silently choosing one', () => {
    expect(codes(definition([edge('first', 'source'), edge('second', 'other')]))).toContain(
      'review-input-edge-conflict',
    )
  })

  test('rejects a canonical edge whose source disagrees with inputSource', () => {
    expect(codes(definition([edge('mismatch', 'other')]))).toContain('review-input-edge-mismatch')
  })
})
