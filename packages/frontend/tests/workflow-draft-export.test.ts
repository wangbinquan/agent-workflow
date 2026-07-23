// RFC-199 — terminal drafts export from memory and are visibly marked
// unsaved; no API read or persisted workflow id is required.

import { describe, expect, test } from 'vitest'
import { buildWorkflowLocalDraftExport } from '../src/lib/workflow-draft-export'

describe('workflow local draft export', () => {
  test('produces importable YAML without a stale id and marks the filename unsaved', () => {
    const snapshot = {
      name: 'my workflow / local',
      description: 'kept after delete',
      definition: { $schema_version: 4 as const, inputs: [], nodes: [], edges: [] },
    }
    const artifact = buildWorkflowLocalDraftExport(snapshot)

    expect(artifact.filename).toBe('my-workflow-local-unsaved.yaml')
    expect(artifact.yaml).toContain('name: my workflow / local')
    expect(artifact.yaml).toContain('description: kept after delete')
    expect(artifact.yaml).toContain('$schema_version: 4')
    expect(artifact.yaml).not.toMatch(/^id:/m)
  })

  test('converts canonical agent ids to name-only selectors for import recovery', () => {
    const artifact = buildWorkflowLocalDraftExport({
      name: 'recoverable',
      description: '',
      definition: {
        $schema_version: 4,
        inputs: [],
        nodes: [
          {
            id: 'worker',
            kind: 'agent-single',
            agentId: 'installation-local-agent-id',
            agentName: 'shared-worker',
          },
        ],
        edges: [],
      },
    })

    expect(artifact.yaml).toContain('agentName: shared-worker')
    expect(artifact.yaml).not.toContain('agentId:')
  })
})
