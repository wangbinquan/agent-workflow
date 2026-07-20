import type {
  WorkflowDefinition,
  WorkflowNode,
  WorkflowValidationIssue,
} from '@agent-workflow/shared'
import { describe, expect, test } from 'vitest'
import { projectWorkflowValidationIssues } from '../src/lib/workflow-validation-projection'

const definition: WorkflowDefinition = {
  $schema_version: 4,
  inputs: [],
  nodes: [
    { id: 'author', kind: 'agent-single', agentName: 'writer' } as WorkflowNode,
    { id: 'review', kind: 'review', inputSource: { nodeId: '', portName: '' } } as WorkflowNode,
  ],
  edges: [
    {
      id: 'edge-1',
      source: { nodeId: 'author', portName: 'doc' },
      target: { nodeId: 'review', portName: '__review_input__' },
    },
  ],
}

describe('projectWorkflowValidationIssues', () => {
  test('counts node/field/port issues and edge issues without using color alone', () => {
    const issues: WorkflowValidationIssue[] = [
      {
        code: 'agent-not-found',
        message: 'missing',
        target: { kind: 'node-field', nodeId: 'author', field: 'agent' },
      },
      {
        code: 'prompt-template-deprecated-token',
        message: 'old',
        severity: 'warning',
        target: { kind: 'node-field', nodeId: 'author', field: 'prompt' },
      },
      {
        code: 'edge-target-port-missing',
        message: 'missing',
        target: { kind: 'edge', edgeId: 'edge-1' },
      },
    ]
    expect(projectWorkflowValidationIssues(definition, issues)).toEqual({
      nodes: { author: { errors: 1, warnings: 1 } },
      edges: { 'edge-1': { errors: 1, warnings: 0 } },
    })
  })

  test('stale strict targets and workflow-wide issues are not guessed onto an object', () => {
    const issues: WorkflowValidationIssue[] = [
      {
        code: 'agent-not-found',
        message: 'gone',
        target: { kind: 'node-field', nodeId: 'deleted', field: 'agent' },
      },
      {
        code: 'topology-cycle',
        message: 'cycle',
        target: { kind: 'workflow' },
      },
    ]
    expect(projectWorkflowValidationIssues(definition, issues)).toEqual({ nodes: {}, edges: {} })
  })
})
