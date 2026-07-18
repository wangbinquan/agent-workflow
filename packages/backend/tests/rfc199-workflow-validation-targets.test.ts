// RFC-199 T5.5 — validator issues must carry strict, non-guessing semantic
// targets. In particular, output binding rows belong to the output node's own
// input port, loop rows stay on loop semantic fields, and duplicate workflow
// declarations must never pick an arbitrary row.

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { WorkflowValidationTargetSchema } from '@agent-workflow/shared'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  validateAgentClarifyMultiplicity,
  validateWorkflowDef,
} from '../src/services/workflow.validator'

const EMPTY_CONTEXT = { agents: [], skills: [] }

function definition(parts: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [],
    edges: [],
    ...parts,
  }
}

function issue(def: WorkflowDefinition, code: string) {
  const found = validateWorkflowDef(def, EMPTY_CONTEXT).issues.find((entry) => entry.code === code)
  expect(found, `expected validator issue ${code}`).toBeDefined()
  return found!
}

describe('RFC-199 strict workflow validation targets', () => {
  test('output binding issues focus the output node input row, never the upstream port', () => {
    const found = issue(
      definition({
        nodes: [
          {
            id: 'publish',
            kind: 'output',
            ports: [{ name: 'artifact', bind: { nodeId: 'missing', portName: 'wrong' } }],
          },
        ],
      }),
      'binding-node-missing',
    )

    expect(found.target).toEqual({
      kind: 'node-port',
      nodeId: 'publish',
      direction: 'input',
      portName: 'artifact',
    })
  })

  test('loop outputBinding and exitCondition failures focus their semantic rows', () => {
    const def = definition({
      nodes: [
        { id: 'input', kind: 'input', inputKey: 'request' },
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['input'],
          maxIterations: 2,
          exitCondition: { kind: 'port-empty', nodeId: 'missing-exit', portName: 'done' },
          outputBindings: [
            { name: 'final', bind: { nodeId: 'missing-output', portName: 'result' } },
          ],
        },
      ],
    })

    expect(issue(def, 'binding-node-missing').target).toEqual({
      kind: 'node-field',
      nodeId: 'loop',
      field: 'loop-output-bindings',
    })
    expect(issue(def, 'wrapper-loop-exit-node-missing').target).toEqual({
      kind: 'node-field',
      nodeId: 'loop',
      field: 'loop-exit-condition',
    })
  })

  test('ordinary missing node ports use the compound node-port identity', () => {
    const found = issue(
      definition({
        inputs: [{ kind: 'text', key: 'request', label: 'Request' }],
        nodes: [
          { id: 'input', kind: 'input', inputKey: 'request' },
          { id: 'output', kind: 'output', ports: [] },
        ],
        edges: [
          {
            id: 'bad-port',
            source: { nodeId: 'input', portName: 'typo' },
            target: { nodeId: 'output', portName: 'result' },
          },
        ],
      }),
      'edge-source-port-missing',
    )

    expect(found.target).toEqual({
      kind: 'node-port',
      nodeId: 'input',
      direction: 'output',
      portName: 'typo',
    })
  })

  test('duplicate workflow input identities fall back to workflow for every affected row', () => {
    const result = validateWorkflowDef(
      definition({
        inputs: [
          { kind: 'upload', key: 'files', label: 'First', targetDir: '' },
          { kind: 'upload', key: 'files', label: 'Second', targetDir: '' },
        ],
      }),
      EMPTY_CONTEXT,
    )

    const affected = result.issues.filter(
      (entry) =>
        entry.code === 'input-key-duplicate' ||
        entry.code === 'upload-input-target-dir-missing' ||
        entry.code === 'input-orphan-declared',
    )
    expect(affected.length).toBeGreaterThan(0)
    expect(affected.every((entry) => entry.target?.kind === 'workflow')).toBe(true)
  })

  test('duplicate fanout input identities never target an arbitrary port row', () => {
    const found = issue(
      definition({
        nodes: [
          {
            id: 'fan',
            kind: 'wrapper-fanout',
            nodeIds: [],
            inputs: [
              { name: 'docs', kind: 'string', isShardSource: true },
              { name: 'docs', kind: 'string' },
            ],
          },
        ],
      }),
      'wrapper-fanout-shard-source-must-be-list',
    )

    expect(found.target).toEqual({ kind: 'workflow' })
  })

  test('multi-object clarify multiplicity does not preserve the arbitrary legacy pointer as target', () => {
    const issues = validateAgentClarifyMultiplicity({
      nodes: [
        { id: 'asker', kind: 'agent-single', agentName: 'asker-agent' },
        { id: 'clarify-a', kind: 'clarify' },
        { id: 'clarify-b', kind: 'clarify' },
      ],
      edges: [
        {
          id: 'ask-a',
          source: { nodeId: 'asker', portName: '__clarify__' },
          target: { nodeId: 'clarify-a', portName: 'questions' },
        },
        {
          id: 'ask-b',
          source: { nodeId: 'asker', portName: '__clarify__' },
          target: { nodeId: 'clarify-b', portName: 'questions' },
        },
      ],
    })

    expect(
      issues.find((entry) => entry.code === 'clarify-multiple-clarify-on-same-agent'),
    ).toMatchObject({
      pointer: 'clarify-a',
      target: { kind: 'workflow' },
    })
  })

  test('source ratchet: every emitted issue has a strict target and all targets parse', () => {
    const source = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'workflow.validator.ts'),
      'utf8',
    )
    const emissions = [...source.matchAll(/^\s+code: '[^']+',/gm)]
    // Release hardening adds duplicate-node-id plus malformed loop-condition
    // emissions; every new site must still carry a strict navigation target.
    expect(emissions).toHaveLength(86)
    for (const emission of emissions) {
      const start = emission.index ?? 0
      const nextPush = source.indexOf('issues.push({', start)
      const block = source.slice(start, nextPush === -1 ? source.length : nextPush)
      expect(block).toContain('target:')
    }

    const sampleIssues = validateWorkflowDef(
      definition({
        inputs: [{ kind: 'text', key: 'orphan', label: 'Orphan' }],
        nodes: [
          { id: 'missing-agent', kind: 'agent-single', agentName: 'ghost' },
          { id: 'empty-loop', kind: 'wrapper-loop', nodeIds: [] },
        ],
      }),
      EMPTY_CONTEXT,
    ).issues
    expect(sampleIssues.length).toBeGreaterThan(0)
    for (const entry of sampleIssues) {
      expect(() => WorkflowValidationTargetSchema.parse(entry.target)).not.toThrow()
    }
  })
})
