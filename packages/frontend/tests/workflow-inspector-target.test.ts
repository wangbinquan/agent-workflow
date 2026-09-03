import { describe, expect, test } from 'vitest'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import {
  planWorkflowIssueNavigation,
  workflowInspectorFieldId,
  workflowInspectorPortId,
} from '../src/lib/workflow-inspector-target'

// RFC-354: an output node's ports are its inbound edges.
const definition: WorkflowDefinition = {
  $schema_version: 6,
  inputs: [{ kind: 'text', key: 'request', label: 'Request' }],
  nodes: [
    { id: 'input', kind: 'input', inputKey: 'request' },
    { id: 'publish', kind: 'output' },
  ],
  edges: [
    {
      id: 'result',
      source: { nodeId: 'input', portName: 'out' },
      target: { nodeId: 'publish', portName: 'result' },
    },
  ],
}

describe('RFC-199 validation → inspector navigation plan', () => {
  test('uses stable semantic field and compound port anchors', () => {
    expect(
      planWorkflowIssueNavigation(
        { kind: 'node-field', nodeId: 'input', field: 'input-definition' },
        definition,
      ),
    ).toEqual({
      selection: { kind: 'node', id: 'input' },
      focusId: workflowInspectorFieldId('input', 'input-definition'),
    })
    expect(
      planWorkflowIssueNavigation(
        { kind: 'node-port', nodeId: 'publish', direction: 'input', portName: 'result' },
        definition,
      ),
    ).toEqual({
      selection: { kind: 'node', id: 'publish' },
      focusId: workflowInspectorPortId('publish', 'input', 'result'),
    })
  })

  test('maps unique workflow rows to their owning canvas object', () => {
    expect(
      planWorkflowIssueNavigation({ kind: 'workflow-input', inputKey: 'request' }, definition),
    ).toEqual({
      selection: { kind: 'node', id: 'input' },
      focusId: workflowInspectorFieldId('input', 'input-definition'),
    })
    expect(
      planWorkflowIssueNavigation({ kind: 'workflow-output', outputName: 'result' }, definition),
    ).toEqual({
      selection: { kind: 'node', id: 'publish' },
      focusId: workflowInspectorPortId('publish', 'input', 'result'),
    })
  })

  test('never guesses when more than one canvas object owns a workflow identity', () => {
    const duplicate: WorkflowDefinition = {
      ...definition,
      nodes: [
        ...definition.nodes,
        { id: 'input-2', kind: 'input', inputKey: 'request' },
        { id: 'publish-2', kind: 'output' },
      ],
      edges: [
        ...definition.edges,
        {
          id: 'result-2',
          source: { nodeId: 'input', portName: 'out' },
          target: { nodeId: 'publish-2', portName: 'result' },
        },
      ],
    }
    expect(
      planWorkflowIssueNavigation({ kind: 'workflow-input', inputKey: 'request' }, duplicate),
    ).toEqual({ selection: null, focusId: null })
    expect(
      planWorkflowIssueNavigation({ kind: 'workflow-output', outputName: 'result' }, duplicate),
    ).toEqual({ selection: null, focusId: null })
  })
})
