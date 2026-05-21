// LOCKS: RFC-055 — workflow validator agent-multi sharding rules.
//
// Pairs with packages/shared/tests/sharding.test.ts (pure validator) and
// packages/frontend/tests/canvas-sharding-inspector.test.tsx (UI form).
// These tests exercise the bridge: validator emits the right code +
// severity for each shape, and per-directory with depth=2 stays clean.

import type { Agent, WorkflowDefinition } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import { validateWorkflowDef } from '../src/services/workflow.validator'

function agent(name: string, outputs: string[] = []): Agent {
  return {
    id: `agent-${name}`,
    name,
    description: '',
    outputs,
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
  }
}

function makeAgentMultiDef(extra: Record<string, unknown>): WorkflowDefinition {
  // Wrap a single agent-multi node with the minimum upstream wiring the
  // sourcePort rule needs so it doesn't drown sharding signal in noise.
  return {
    $schema_version: 3,
    inputs: [{ kind: 'text', key: 'src', label: 'src' }],
    nodes: [
      { id: 'wg', kind: 'wrapper-git', nodeIds: ['x'] },
      { id: 'x', kind: 'input', inputKey: 'src' },
      {
        id: 'm1',
        kind: 'agent-multi',
        agentName: 'auditor',
        sourcePort: { nodeId: 'wg', portName: 'git_diff' },
        ...extra,
      },
    ],
    edges: [],
  }
}

const CTX = { agents: [agent('auditor', ['findings'])], skills: [] }

describe('RFC-055 workflow validator — agent-multi sharding rules', () => {
  test('missing shardingStrategy → single warning, no error', () => {
    const def = makeAgentMultiDef({})
    const issues = validateWorkflowDef(def, CTX).issues.filter((i) =>
      i.code.startsWith('agent-multi-sharding-'),
    )
    expect(issues.length).toBe(1)
    expect(issues[0]).toMatchObject({
      code: 'agent-multi-sharding-missing',
      severity: 'warning',
      pointer: 'm1',
    })
  })

  test('invalid kind → error code=agent-multi-sharding-invalid', () => {
    const def = makeAgentMultiDef({ shardingStrategy: { kind: 'wrong' } })
    const issues = validateWorkflowDef(def, CTX).issues.filter((i) =>
      i.code.startsWith('agent-multi-sharding-'),
    )
    expect(issues.length).toBe(1)
    expect(issues[0]?.code).toBe('agent-multi-sharding-invalid')
    // No explicit severity = treated as error by aggregator (workflow.validator.ts:827).
    expect(issues[0]?.severity).toBeUndefined()
    expect(issues[0]?.message).toContain('kind must be one of')
  })

  test('per-n-files with n=0 → error', () => {
    const def = makeAgentMultiDef({ shardingStrategy: { kind: 'per-n-files', n: 0 } })
    const issues = validateWorkflowDef(def, CTX).issues.filter((i) =>
      i.code.startsWith('agent-multi-sharding-'),
    )
    expect(issues.length).toBe(1)
    expect(issues[0]?.code).toBe('agent-multi-sharding-invalid')
    expect(issues[0]?.message).toContain("'n' must be an integer")
  })

  test('per-directory depth=2 is valid (zero sharding-related issues)', () => {
    const def = makeAgentMultiDef({ shardingStrategy: { kind: 'per-directory', depth: 2 } })
    const issues = validateWorkflowDef(def, CTX).issues.filter((i) =>
      i.code.startsWith('agent-multi-sharding-'),
    )
    expect(issues).toEqual([])
  })
})
