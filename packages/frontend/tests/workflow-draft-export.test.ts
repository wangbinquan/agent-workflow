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
})
