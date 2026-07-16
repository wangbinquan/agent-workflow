// RFC-199 §7.1 — strict validation targets take precedence over legacy
// pointers; the compatibility path is pure, conservative, and never guesses
// between duplicate workflow declarations.

import type { WorkflowDefinition, WorkflowValidationIssue } from '@agent-workflow/shared'
import { WorkflowValidationTargetSchema } from '@agent-workflow/shared'
import { describe, expect, test } from 'vitest'
import { resolveWorkflowIssueTarget } from '../src/lib/workflow-validation-target'

function definition(parts: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [],
    edges: [],
    ...parts,
  }
}

function resolve(issue: WorkflowValidationIssue, def: WorkflowDefinition) {
  return resolveWorkflowIssueTarget(issue, def)
}

describe('resolveWorkflowIssueTarget', () => {
  test('strict target wins over a contradictory legacy pointer', () => {
    const def = definition({
      nodes: [{ id: 'loop', kind: 'wrapper-loop', nodeIds: [] }],
      edges: [
        {
          id: 'legacy-edge',
          source: { nodeId: 'loop', portName: 'out' },
          target: { nodeId: 'loop', portName: 'in' },
        },
      ],
    })

    expect(
      resolve(
        {
          code: 'legacy',
          message: 'legacy',
          pointer: 'legacy-edge',
          target: { kind: 'node-field', nodeId: 'loop', field: 'loop-exit-condition' },
        },
        def,
      ),
    ).toEqual({ kind: 'node-field', nodeId: 'loop', field: 'loop-exit-condition' })
  })

  test('stale strict target returns unknown and does not guess from pointer', () => {
    const def = definition({
      nodes: [{ id: 'live-node', kind: 'input', inputKey: 'request' }],
    })
    expect(
      resolve(
        {
          code: 'agent-not-found',
          message: 'stale',
          pointer: 'live-node',
          target: { kind: 'node', nodeId: 'deleted-node' },
        },
        def,
      ),
    ).toEqual({ kind: 'unknown' })
  })

  test('legacy edge port codes recover the compound node-port target', () => {
    const def = definition({
      nodes: [
        { id: 'source', kind: 'input', inputKey: 'request' },
        { id: 'target', kind: 'output', ports: [] },
      ],
      edges: [
        {
          id: 'edge',
          source: { nodeId: 'source', portName: 'missing-output' },
          target: { nodeId: 'target', portName: 'missing-input' },
        },
      ],
    })

    expect(
      resolve({ code: 'edge-source-port-missing', message: 'legacy', pointer: 'edge' }, def),
    ).toEqual({
      kind: 'node-port',
      nodeId: 'source',
      direction: 'output',
      portName: 'missing-output',
    })
    expect(
      resolve({ code: 'edge-target-port-missing', message: 'legacy', pointer: 'edge' }, def),
    ).toEqual({
      kind: 'node-port',
      nodeId: 'target',
      direction: 'input',
      portName: 'missing-input',
    })
  })

  test('legacy loop and prompt codes map through the finite semantic field table', () => {
    const def = definition({
      nodes: [
        { id: 'loop', kind: 'wrapper-loop', nodeIds: [] },
        { id: 'worker', kind: 'agent-single', agentName: 'worker' },
      ],
    })

    expect(
      resolve({ code: 'wrapper-loop-exit-port-missing', message: 'legacy', pointer: 'loop' }, def),
    ).toEqual({ kind: 'node-field', nodeId: 'loop', field: 'loop-exit-condition' })
    expect(
      resolve({ code: 'prompt-template-unresolved', message: 'legacy', pointer: 'worker' }, def),
    ).toEqual({ kind: 'node-field', nodeId: 'worker', field: 'prompt' })
  })

  test('legacy binding code is exact for loop field and conservative for output rows', () => {
    const def = definition({
      nodes: [
        { id: 'loop', kind: 'wrapper-loop', nodeIds: [] },
        { id: 'publish', kind: 'output', ports: [] },
      ],
    })

    expect(
      resolve({ code: 'binding-node-missing', message: 'legacy', pointer: 'loop' }, def),
    ).toEqual({ kind: 'node-field', nodeId: 'loop', field: 'loop-output-bindings' })
    expect(
      resolve({ code: 'binding-node-missing', message: 'legacy', pointer: 'publish' }, def),
    ).toEqual({ kind: 'node', nodeId: 'publish' })
  })

  test('duplicate input/output identities fall back to workflow instead of picking a row', () => {
    const def = definition({
      inputs: [
        { kind: 'text', key: 'request', label: 'First' },
        { kind: 'text', key: 'request', label: 'Second' },
      ],
      nodes: [
        {
          id: 'output-a',
          kind: 'output',
          ports: [{ name: 'result', bind: { nodeId: 'source', portName: 'a' } }],
        },
        {
          id: 'output-b',
          kind: 'output',
          ports: [{ name: 'result', bind: { nodeId: 'source', portName: 'b' } }],
        },
      ],
    })

    expect(
      resolve({ code: 'input-orphan-declared', message: 'legacy', pointer: 'request' }, def),
    ).toEqual({ kind: 'workflow' })
    expect(
      resolve(
        {
          code: 'legacy-output',
          message: 'legacy',
          target: { kind: 'workflow-output', outputName: 'result' },
        },
        def,
      ),
    ).toEqual({ kind: 'workflow' })
  })

  test('unknown pointers stay unknown and every resolved strict branch parses', () => {
    const def = definition({
      inputs: [{ kind: 'text', key: 'request', label: 'Request' }],
      nodes: [{ id: 'input', kind: 'input', inputKey: 'request' }],
    })
    expect(resolve({ code: 'legacy', message: 'legacy', pointer: 'gone' }, def)).toEqual({
      kind: 'unknown',
    })

    const resolved = [
      resolve({ code: 'input-orphan-declared', message: 'legacy', pointer: 'request' }, def),
      resolve({ code: 'wrapper-empty', message: 'legacy', pointer: 'input' }, def),
      resolve({ code: 'topology-cycle', message: 'legacy' }, def),
    ]
    for (const target of resolved) {
      expect(target.kind).not.toBe('unknown')
      expect(() => WorkflowValidationTargetSchema.parse(target)).not.toThrow()
    }
  })

  test('uncategorised legacy code does not guess across colliding pointer domains', () => {
    const def = definition({
      inputs: [{ kind: 'text', key: 'same', label: 'Same' }],
      nodes: [{ id: 'same', kind: 'input', inputKey: 'same' }],
      edges: [
        {
          id: 'same',
          source: { nodeId: 'same', portName: 'same' },
          target: { nodeId: 'same', portName: 'same' },
        },
      ],
    })

    expect(resolve({ code: 'legacy-unknown', message: 'legacy', pointer: 'same' }, def)).toEqual({
      kind: 'unknown',
    })
  })
})
