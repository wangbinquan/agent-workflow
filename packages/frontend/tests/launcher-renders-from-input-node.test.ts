// RFC-004 regression: the launcher form is driven SOLELY by
// `definition.inputs[]`. Adding an input node to the canvas does not
// produce a launcher field by itself — the matching inputs[] entry must
// exist (editor syncs this on every change; old workflows self-heal on
// open via healLoadedDefinition).
//
// If this goes red, someone refactored the launcher to scan input nodes
// directly. That bypasses syncInputDefs / the editor's inputs[] declaration
// (broken on the failed task 01KRNJXKNSXR8C1DHSCCCWHDD4) — revert the
// regression and re-route through workflow.definition.inputs[].

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { describe, expect, test } from 'vitest'
import { launcherFieldDefs } from '../src/components/launch/DynamicInput'

describe('launcherFieldDefs (RFC-004)', () => {
  test('returns the declared inputs entries, in order', () => {
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [
        { kind: 'text', key: 'requirement', label: 'Need', required: true },
        { kind: 'files', key: 'context', label: 'Context' },
      ],
      nodes: [],
      edges: [],
    }
    const fields = launcherFieldDefs(def)
    expect(fields.map((f) => f.key)).toEqual(['requirement', 'context'])
    expect(fields[0]?.label).toBe('Need')
    expect(fields[1]?.kind).toBe('files')
  })

  test('input node WITHOUT a matching inputs[] entry produces zero fields', () => {
    // The exact contract: the launcher MUST NOT render a field just because
    // an input node exists. Without an inputs[] entry the task launches with
    // task.inputs = {} and the scheduler routes an empty string into the
    // graph — exactly the failure mode RFC-004 fixes elsewhere by syncing
    // inputs[] in the editor.
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [{ id: 'i1', kind: 'input', inputKey: 'requirement' }],
      edges: [],
    }
    expect(launcherFieldDefs(def)).toEqual([])
  })

  test('undefined / missing definition returns empty array', () => {
    expect(launcherFieldDefs(undefined)).toEqual([])
    expect(launcherFieldDefs({} as { inputs?: never })).toEqual([])
  })
})
