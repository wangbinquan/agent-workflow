// Regression coverage for wrapper scope projection.
//
// A runtime dependency whose endpoint lives inside a wrapper must be projected
// to the direct representatives at the endpoints' least common scope. Without
// this projection the parent scheduler sees neither endpoint and may dispatch
// the wrapper before an external upstream has completed.

import type { WorkflowDefinition, WorkflowNode } from '../src'
import {
  analyzeWorkflowScopeTree,
  buildWorkflowScopeParentMap,
  projectWorkflowDependency,
  resolveWorkflowSourceRef,
} from '../src'
import { describe, expect, test } from 'bun:test'

function node(id: string): WorkflowNode {
  return { id, kind: 'agent-single', agentName: id } as WorkflowNode
}

describe('workflow wrapper scope projection', () => {
  test('containment analysis reports every ambiguity before runtime uses the parent map', () => {
    const definition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        node('inner'),
        {
          id: 'git-a',
          kind: 'wrapper-git',
          nodeIds: ['inner', 'inner', 'missing', 'git-b'],
        },
        { id: 'git-b', kind: 'wrapper-git', nodeIds: ['inner', 'git-a'] },
      ],
      edges: [],
    } as unknown as WorkflowDefinition

    const analysis = analyzeWorkflowScopeTree(definition)

    expect(analysis.issues.map((issue) => issue.code)).toEqual([
      'wrapper-child-duplicate',
      'wrapper-child-node-missing',
      'wrapper-child-multiple-parents',
      'wrapper-containment-cycle',
    ])
    expect(analysis.parents.get('inner')).toBe('git-b')
  })

  test('external → loop inner projects to external → loop in the root scope', () => {
    const definition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        node('external'),
        node('inner'),
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['inner'],
          maxIterations: 2,
          exitCondition: { kind: 'port-empty', nodeId: 'inner', portName: 'done' },
        },
      ],
      edges: [],
    } as unknown as WorkflowDefinition
    const parents = buildWorkflowScopeParentMap(definition)

    expect(projectWorkflowDependency('external', 'inner', parents)).toEqual({
      scopeId: null,
      sourceNodeId: 'external',
      targetNodeId: 'loop',
    })
  })

  test('nested wrappers project at every relevant LCA without flattening the inner scope', () => {
    const definition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        node('external'),
        node('deep'),
        {
          id: 'git',
          kind: 'wrapper-git',
          nodeIds: ['deep'],
        },
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['git'],
          maxIterations: 2,
          exitCondition: { kind: 'port-empty', nodeId: 'git', portName: 'git_diff' },
        },
      ],
      edges: [],
    } as unknown as WorkflowDefinition
    const parents = buildWorkflowScopeParentMap(definition)

    expect(projectWorkflowDependency('external', 'deep', parents)).toEqual({
      scopeId: null,
      sourceNodeId: 'external',
      targetNodeId: 'loop',
    })
    expect(projectWorkflowDependency('git', 'deep', parents)).toEqual({
      scopeId: 'loop',
      sourceNodeId: 'git',
      targetNodeId: 'git',
    })
  })

  test('loop inner output resolves through the declared wrapper output before leaving the loop', () => {
    const definition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        node('inner'),
        node('sink'),
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['inner'],
          maxIterations: 2,
          exitCondition: { kind: 'port-empty', nodeId: 'inner', portName: 'done' },
          outputBindings: [{ name: 'final', bind: { nodeId: 'inner', portName: 'result' } }],
        },
      ],
      edges: [],
    } as unknown as WorkflowDefinition

    expect(
      resolveWorkflowSourceRef(definition, { nodeId: 'inner', portName: 'result' }, 'sink'),
    ).toEqual({
      ok: true,
      source: { nodeId: 'loop', portName: 'final' },
      exitedWrapperIds: ['loop'],
    })
  })

  test('an inner source with no wrapper outlet fails closed instead of bypassing the boundary', () => {
    const definition = {
      $schema_version: 4,
      inputs: [],
      nodes: [node('inner'), node('sink'), { id: 'git', kind: 'wrapper-git', nodeIds: ['inner'] }],
      edges: [],
    } as unknown as WorkflowDefinition

    expect(
      resolveWorkflowSourceRef(definition, { nodeId: 'inner', portName: 'result' }, 'sink'),
    ).toMatchObject({
      ok: false,
      wrapperId: 'git',
      wrapperKind: 'wrapper-git',
      source: { nodeId: 'inner', portName: 'result' },
    })
  })

  test('nested fanout → loop outlets are promoted one declared boundary at a time', () => {
    const definition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        node('aggregator'),
        node('sink'),
        {
          id: 'fan',
          kind: 'wrapper-fanout',
          nodeIds: ['aggregator'],
          inputs: [{ name: 'items', kind: 'list<markdown>', isShardSource: true }],
        },
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['fan'],
          maxIterations: 2,
          exitCondition: { kind: 'port-not-empty', nodeId: 'fan', portName: 'summary' },
          outputBindings: [{ name: 'final', bind: { nodeId: 'fan', portName: 'summary' } }],
        },
      ],
      edges: [
        {
          id: 'fan-output',
          boundary: 'wrapper-output',
          source: { nodeId: 'aggregator', portName: 'result' },
          target: { nodeId: 'fan', portName: 'summary' },
        },
      ],
    } as unknown as WorkflowDefinition

    expect(
      resolveWorkflowSourceRef(definition, { nodeId: 'aggregator', portName: 'result' }, 'sink'),
    ).toEqual({
      ok: true,
      source: { nodeId: 'loop', portName: 'final' },
      exitedWrapperIds: ['fan', 'loop'],
    })
  })
})
