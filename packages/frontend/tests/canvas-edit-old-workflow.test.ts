// RFC-004 — opening an old workflow (input node present, `inputs: []` empty)
// must heal `definition.inputs[]` on load so the next auto-save writes the
// corrected shape back to the daemon. No backend migration runs.
//
// RFC-354 (schema v6): the same load boundary upgrades a pre-v6 definition —
// the review `inputSource`, output `ports[].bind`, loop `outputBindings` /
// `exitCondition.nodeId` and fan-out `inputs[]` PortRefs all become edges —
// so the canvas only ever sees v6. A v6 definition passes through by
// reference when nothing needs fixing.
//
// If this goes red, check workflows.edit.tsx's load-from-query useEffect AND
// healLoadedDefinition + shared migrateWorkflowDefinitionToLatest.

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { WORKFLOW_SCHEMA_VERSION } from '@agent-workflow/shared'
import { describe, expect, test } from 'vitest'
import { healLoadedDefinition } from '../src/routes/workflows.edit'
import { REVIEW_INPUT_HANDLE_ID } from '../src/components/canvas/connectionSync'

describe('healLoadedDefinition (RFC-004)', () => {
  test('old shape: inputs:[] + input node with inputKey → inputs[] populated', () => {
    const old: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [{ id: 'i1', kind: 'input', inputKey: 'requirement' } as WorkflowNode],
      edges: [],
    }
    const healed = healLoadedDefinition(old)
    expect(healed).not.toBe(old)
    expect(healed.inputs).toHaveLength(1)
    expect(healed.inputs[0]?.key).toBe('requirement')
    expect(healed.inputs[0]?.kind).toBe('text')
    expect(healed.inputs[0]?.required).toBe(true)
  })

  test('clean v6 shape (inputs[] already matches) returns the same reference', () => {
    const clean: WorkflowDefinition = {
      $schema_version: WORKFLOW_SCHEMA_VERSION,
      inputs: [{ kind: 'text', key: 'requirement', label: 'requirement', required: true }],
      nodes: [{ id: 'i1', kind: 'input', inputKey: 'requirement' } as WorkflowNode],
      edges: [],
    }
    expect(healLoadedDefinition(clean)).toBe(clean)
  })
})

describe('healLoadedDefinition (RFC-354 schema upgrade at the load boundary)', () => {
  test('v5 review.inputSource with no edge → the __review_input__ edge is materialized, the field dropped', () => {
    const def: WorkflowDefinition = {
      $schema_version: 5,
      inputs: [],
      nodes: [
        { id: 'a', kind: 'agent-single', agentName: 'stub' } as unknown as WorkflowNode,
        {
          id: 'r',
          kind: 'review',
          inputSource: { nodeId: 'a', portName: 'design' },
        } as unknown as WorkflowNode,
      ],
      edges: [],
    }
    const healed = healLoadedDefinition(def)
    expect(healed.$schema_version).toBe(WORKFLOW_SCHEMA_VERSION)
    expect(healed.edges).toHaveLength(1)
    expect(healed.edges[0]!.target).toEqual({ nodeId: 'r', portName: REVIEW_INPUT_HANDLE_ID })
    expect(healed.edges[0]!.source).toEqual({ nodeId: 'a', portName: 'design' })
    const r = healed.nodes.find((n) => n.id === 'r') as unknown as Record<string, unknown>
    expect('inputSource' in r).toBe(false)
  })

  test('v5 output ports[].bind → one inbound edge per port, the ports field dropped', () => {
    const def: WorkflowDefinition = {
      $schema_version: 5,
      inputs: [],
      nodes: [
        { id: 'a', kind: 'agent-single', agentName: 'stub' } as unknown as WorkflowNode,
        {
          id: 'o',
          kind: 'output',
          ports: [{ name: 'final_doc', bind: { nodeId: 'a', portName: 'design' } }],
        } as unknown as WorkflowNode,
      ],
      edges: [],
    }
    const healed = healLoadedDefinition(def)
    expect(healed.edges).toHaveLength(1)
    expect(healed.edges[0]!.target).toEqual({ nodeId: 'o', portName: 'final_doc' })
    expect(healed.edges[0]!.source).toEqual({ nodeId: 'a', portName: 'design' })
    const o = healed.nodes.find((n) => n.id === 'o') as unknown as Record<string, unknown>
    expect('ports' in o).toBe(false)
  })

  test('v5 loop outputBindings + exitCondition.nodeId → wrapper-output return edge + own-port exit', () => {
    const def: WorkflowDefinition = {
      $schema_version: 5,
      inputs: [],
      nodes: [
        { id: 'a', kind: 'agent-single', agentName: 'stub' } as unknown as WorkflowNode,
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['a'],
          maxIterations: 2,
          exitCondition: { kind: 'port-empty', nodeId: 'a', portName: 'design' },
          outputBindings: [{ name: 'final', bind: { nodeId: 'a', portName: 'design' } }],
        } as unknown as WorkflowNode,
      ],
      edges: [],
    }
    const healed = healLoadedDefinition(def)
    expect(healed.edges).toEqual([
      expect.objectContaining({
        source: { nodeId: 'a', portName: 'design' },
        target: { nodeId: 'loop', portName: 'final' },
        boundary: 'wrapper-output',
      }),
    ])
    const loop = healed.nodes.find((n) => n.id === 'loop') as unknown as Record<string, unknown>
    expect(loop.exitCondition).toEqual({ kind: 'port-empty', portName: 'final' })
    expect('outputBindings' in loop).toBe(false)
  })

  test('v5 fan-out inputs[] → shardSourcePort', () => {
    const def: WorkflowDefinition = {
      $schema_version: 5,
      inputs: [],
      nodes: [
        {
          id: 'fan',
          kind: 'wrapper-fanout',
          nodeIds: [],
          inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
        } as unknown as WorkflowNode,
      ],
      edges: [],
    }
    const fan = healLoadedDefinition(def).nodes[0] as unknown as Record<string, unknown>
    expect(fan.shardSourcePort).toBe('docs')
    expect('inputs' in fan).toBe(false)
  })

  test('v6 definition with the review edge already wired → ref-equal short-circuit', () => {
    const def: WorkflowDefinition = {
      $schema_version: WORKFLOW_SCHEMA_VERSION,
      inputs: [],
      nodes: [
        { id: 'a', kind: 'agent-single', agentName: 'stub' } as unknown as WorkflowNode,
        { id: 'r', kind: 'review' } as unknown as WorkflowNode,
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'a', portName: 'design' },
          target: { nodeId: 'r', portName: REVIEW_INPUT_HANDLE_ID },
        },
      ],
    }
    expect(healLoadedDefinition(def)).toBe(def)
  })
})
