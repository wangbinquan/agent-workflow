// RFC-004 — opening an old workflow (input node present, `inputs: []` empty)
// must heal `definition.inputs[]` on load so the next auto-save writes the
// corrected shape back to the daemon. No backend migration runs.
//
// If this goes red, check workflows.edit.tsx's load-from-query useEffect AND
// healLoadedDefinition.

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { describe, expect, test } from 'vitest'
import { healLoadedDefinition } from '../src/routes/workflows.edit'

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

  test('clean shape (inputs[] already matches) returns the same reference', () => {
    const clean: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [{ kind: 'text', key: 'requirement', label: 'requirement', required: true }],
      nodes: [{ id: 'i1', kind: 'input', inputKey: 'requirement' } as WorkflowNode],
      edges: [],
    }
    expect(healLoadedDefinition(clean)).toBe(clean)
  })
})
