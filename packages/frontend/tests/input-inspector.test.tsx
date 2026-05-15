// RFC-004 — Input node inspector renders 5 fields and routes edits through
// the renameInputKey / patchInputDef cascades. If this file goes red, the
// inspector is no longer keeping `definition.inputs[]`, the input node's
// `inputKey`, and outbound `source.portName` in lock-step — verify
// NodeInspector.tsx (input branch) AND syncInputDefs.ts.

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { NodeInspector } from '../src/components/canvas/NodeInspector'

function makeDef(parts: Partial<WorkflowDefinition>): WorkflowDefinition {
  return { $schema_version: 1, inputs: [], nodes: [], edges: [], ...parts }
}

function Host({
  initial,
  onChangeSpy,
}: {
  initial: WorkflowDefinition
  onChangeSpy: (def: WorkflowDefinition) => void
}) {
  const [def, setDef] = useState(initial)
  return (
    <NodeInspector
      definition={def}
      selectedNodeId="i1"
      agents={[]}
      onChange={(next) => {
        setDef(next)
        onChangeSpy(next)
      }}
      onClose={() => {}}
    />
  )
}

function last(onChange: ReturnType<typeof vi.fn>): WorkflowDefinition {
  return onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as WorkflowDefinition
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('input NodeInspector (RFC-004)', () => {
  test('renders 5 launcher-field controls (key + kind + label + required + description)', () => {
    const def = makeDef({
      inputs: [{ kind: 'text', key: 'req', label: 'Need it', required: true }],
      nodes: [{ id: 'i1', kind: 'input', inputKey: 'req' } as WorkflowNode],
    })
    render(<Host initial={def} onChangeSpy={vi.fn()} />)
    // inputKey TextInput by displayed value
    expect(screen.getByDisplayValue('req')).toBeTruthy()
    // kind <select> — text default option present + 4 kinds
    const kindSelect = screen.getByRole('combobox') as HTMLSelectElement
    const kinds = Array.from(kindSelect.options).map((o) => o.value)
    expect(kinds).toEqual(['text', 'files', 'enum', 'git'])
    expect(kindSelect.value).toBe('text')
    // label TextInput shows 'Need it'
    expect(screen.getByDisplayValue('Need it')).toBeTruthy()
    // required Switch shows checked
    const switchEl = screen.getByRole('checkbox') as HTMLInputElement
    expect(switchEl.checked).toBe(true)
    // description TextArea exists (empty by default)
    const description = document.querySelector('textarea')
    expect(description).not.toBeNull()
  })

  test('changing inputKey renames node + inputs entry + outbound edge in one go', () => {
    const def = makeDef({
      inputs: [{ kind: 'text', key: 'req', label: 'Need it' }],
      nodes: [
        { id: 'i1', kind: 'input', inputKey: 'req' } as WorkflowNode,
        { id: 'a1', kind: 'agent-single', agentName: 'x' } as unknown as WorkflowNode,
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'i1', portName: 'req' },
          target: { nodeId: 'a1', portName: 'req' },
        },
      ],
    })
    const spy = vi.fn()
    render(<Host initial={def} onChangeSpy={spy} />)
    fireEvent.change(screen.getByDisplayValue('req'), { target: { value: 'spec' } })
    const next = last(spy)
    expect((next.nodes[0] as Record<string, unknown>).inputKey).toBe('spec')
    expect(next.inputs[0]?.key).toBe('spec')
    expect(next.inputs[0]?.label).toBe('Need it')
    expect(next.edges[0]?.source.portName).toBe('spec')
    // The agent-side target port name is preserved.
    expect(next.edges[0]?.target.portName).toBe('req')
  })

  test('editing label only touches the matching inputs[] entry, leaves the node alone', () => {
    const def = makeDef({
      inputs: [{ kind: 'text', key: 'req', label: 'old' }],
      nodes: [{ id: 'i1', kind: 'input', inputKey: 'req' } as WorkflowNode],
    })
    const spy = vi.fn()
    render(<Host initial={def} onChangeSpy={spy} />)
    fireEvent.change(screen.getByDisplayValue('old'), { target: { value: 'new label' } })
    const next = last(spy)
    expect(next.inputs[0]?.label).toBe('new label')
    expect(next.inputs[0]?.key).toBe('req')
    expect((next.nodes[0] as Record<string, unknown>).inputKey).toBe('req')
  })

  test('changing kind to files updates the inputs[] entry without affecting the node or edges', () => {
    const def = makeDef({
      inputs: [{ kind: 'text', key: 'req', label: 'req' }],
      nodes: [{ id: 'i1', kind: 'input', inputKey: 'req' } as WorkflowNode],
    })
    const spy = vi.fn()
    render(<Host initial={def} onChangeSpy={spy} />)
    const kindSelect = screen.getByRole('combobox') as HTMLSelectElement
    fireEvent.change(kindSelect, { target: { value: 'files' } })
    const next = last(spy)
    expect(next.inputs[0]?.kind).toBe('files')
    expect((next.nodes[0] as Record<string, unknown>).inputKey).toBe('req')
  })
})
