// RFC-228 — workflow static validation covers MCP ids on both the directly
// selected Agent and its dependsOn closure. Existing disabled MCP rows retain
// RFC-223's intentional "not injected" behavior; only a missing row is invalid.

import { describe, expect, test } from 'bun:test'
import type { Agent, Mcp, WorkflowDefinition } from '@agent-workflow/shared'
import { validateWorkflowDef } from '../src/services/workflow.validator'

function agent(name: string, opts: { dependsOn?: string[]; mcp?: string[] } = {}): Agent {
  return {
    id: `agent-${name}`,
    name,
    description: '',
    outputs: [],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: (opts.dependsOn ?? []).map((dependency) => `agent-${dependency}`),
    mcp: (opts.mcp ?? []).map((mcpName) => `mcp-${mcpName}`),
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

function mcp(name: string, enabled = true): Mcp {
  return {
    id: `mcp-${name}`,
    name,
    description: '',
    type: 'local',
    config: { command: [name] },
    enabled,
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

const definition: WorkflowDefinition = {
  $schema_version: 4,
  inputs: [],
  nodes: [
    {
      id: 'node',
      kind: 'agent-single',
      agentId: 'agent-root',
      agentName: 'root',
    },
  ],
  edges: [],
}

describe('workflow validator — MCP resource references', () => {
  test('reports mcp-not-found on the directly used Agent', () => {
    const result = validateWorkflowDef(definition, {
      agents: [agent('root', { mcp: ['missing'] })],
      skills: [],
      mcps: [],
    })
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'mcp-not-found',
        pointer: 'node',
      }),
    )
  })

  test('reports mcp-not-found from the dependsOn closure', () => {
    const result = validateWorkflowDef(definition, {
      agents: [
        agent('root', { dependsOn: ['child'] }),
        agent('child', { mcp: ['missing-in-child'] }),
      ],
      skills: [],
      mcps: [],
    })
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'mcp-not-found',
        pointer: 'node',
      }),
    )
  })

  test('a present disabled MCP is not treated as missing', () => {
    const result = validateWorkflowDef(definition, {
      agents: [agent('root', { mcp: ['off'] })],
      skills: [],
      mcps: [mcp('off', false)],
    })
    expect(result.issues.some((issue) => issue.code === 'mcp-not-found')).toBe(false)
  })

  test('legacy pure callers without an MCP inventory keep their existing behavior', () => {
    const result = validateWorkflowDef(definition, {
      agents: [agent('root', { mcp: ['unknown'] })],
      skills: [],
    })
    expect(result.issues.some((issue) => issue.code === 'mcp-not-found')).toBe(false)
  })
})
