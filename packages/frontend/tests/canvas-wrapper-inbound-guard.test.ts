import type { WorkflowDefinition } from '@agent-workflow/shared'
import { describe, expect, test } from 'vitest'
import { isUnsupportedWrapperInbound } from '../src/components/canvas/WorkflowCanvas'

const def = {
  $schema_version: 4,
  inputs: [],
  nodes: [
    { id: 'git', kind: 'wrapper-git', nodeIds: ['agent'] },
    {
      id: 'loop',
      kind: 'wrapper-loop',
      nodeIds: ['agent'],
      maxIterations: 2,
      exitCondition: { kind: 'port-empty', nodeId: 'agent', portName: 'result' },
    },
    { id: 'fan', kind: 'wrapper-fanout', nodeIds: ['agent'], inputs: [], outputs: [] },
    { id: 'agent', kind: 'agent-single', agentName: 'a' },
  ],
  edges: [],
} as unknown as WorkflowDefinition

describe('canvas wrapper inbound guard', () => {
  test('rejects the two wrapper kinds whose validator forbids inbound edges', () => {
    expect(isUnsupportedWrapperInbound(def, { target: 'git' })).toBe(true)
    expect(isUnsupportedWrapperInbound(def, { target: 'loop' })).toBe(true)
  })

  test('keeps fanout declared inputs and ordinary nodes connectable', () => {
    expect(isUnsupportedWrapperInbound(def, { target: 'fan' })).toBe(false)
    expect(isUnsupportedWrapperInbound(def, { target: 'agent' })).toBe(false)
    expect(isUnsupportedWrapperInbound(def, { target: null })).toBe(false)
  })
})
