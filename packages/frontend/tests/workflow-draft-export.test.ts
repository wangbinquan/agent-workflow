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

    // RFC-264 RE-JUDGEMENT (was 'my-workflow-local-unsaved.yaml'): the download
    // name keeps the workflow's own characters and only replaces what a file
    // system rejects — here the `/`. Spaces survive.
    expect(artifact.filename).toBe('my workflow - local-unsaved.yaml')
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

// RFC-264 — a Chinese-named workflow must not download as the bare fallback
// `workflow.yaml`. The old sanitizer folded everything outside [a-zA-Z0-9_-]
// to `-` and then stripped the edges, which erased CJK names completely.
describe('RFC-264 download file names keep their script', () => {
  const snapshotWith = (name: string) => ({
    name,
    description: '',
    definition: { $schema_version: 4 as const, inputs: [], nodes: [], edges: [] },
  })

  test('a Chinese name survives into the filename', () => {
    expect(buildWorkflowLocalDraftExport(snapshotWith('代码审计流水线')).filename).toBe(
      '代码审计流水线-unsaved.yaml',
    )
    expect(buildWorkflowLocalDraftExport(snapshotWith('审计 Pipeline v2')).filename).toBe(
      '审计 Pipeline v2-unsaved.yaml',
    )
  })

  test('only file-system-hostile characters are replaced', () => {
    // POSIX separator + the Windows reserved set.
    expect(buildWorkflowLocalDraftExport(snapshotWith('a/b\\c:d*e?f"g<h>i|j')).filename).toBe(
      'a-b-c-d-e-f-g-h-i-j-unsaved.yaml',
    )
  })

  test('the name is folded first, and a trailing dot/space is dropped (Windows)', () => {
    expect(buildWorkflowLocalDraftExport(snapshotWith('  代码审计　流程  ')).filename).toBe(
      '代码审计 流程-unsaved.yaml',
    )
    expect(buildWorkflowLocalDraftExport(snapshotWith('report.')).filename).toBe(
      'report-unsaved.yaml',
    )
  })

  test('a name that sanitizes to nothing still falls back', () => {
    expect(buildWorkflowLocalDraftExport(snapshotWith('   ')).filename).toBe(
      'workflow-unsaved.yaml',
    )
  })
})
