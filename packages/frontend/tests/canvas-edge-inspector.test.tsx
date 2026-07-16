// EdgeInspector — RFC-003 rename + delete flow.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import {
  EdgeInspector,
  hasConflict,
  type InspectorChangeMeta,
} from '../src/components/canvas/EdgeInspector'

function makeDef(): WorkflowDefinition {
  return {
    $schema_version: 1,
    inputs: [],
    nodes: [],
    edges: [
      {
        id: 'e1',
        source: { nodeId: 'in1', portName: 'out' },
        target: { nodeId: 'agent1', portName: 'out' },
      },
      {
        id: 'e2',
        source: { nodeId: 'wrap_git_1', portName: 'git_diff' },
        target: { nodeId: 'agent1', portName: 'git_diff' },
      },
    ],
  }
}

function Host({
  onChangeSpy,
  initialDef,
}: {
  onChangeSpy: (def: WorkflowDefinition, meta: InspectorChangeMeta) => void
  initialDef: WorkflowDefinition
}) {
  const [def, setDef] = useState(initialDef)
  const edge = def.edges.find((e) => e.id === 'e1')
  // After delete the parent route would clear selection; mimic that here.
  if (edge === undefined) return null
  return (
    <EdgeInspector
      edge={edge}
      definition={def}
      onChange={(next, meta) => {
        setDef(next)
        onChangeSpy(next, meta)
      }}
      onClose={() => {}}
    />
  )
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('EdgeInspector', () => {
  test('renames target.portName on blur → onChange fires with updated edge', () => {
    const onChange = vi.fn()
    render(<Host initialDef={makeDef()} onChangeSpy={onChange} />)
    const input = screen
      .getAllByRole('textbox')
      .find((i) => (i as HTMLInputElement).value === 'out')!
    fireEvent.change(input, { target: { value: 'requirement' } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledTimes(2)
    const next = onChange.mock.calls[0]![0] as WorkflowDefinition
    expect(next.edges.find((e) => e.id === 'e1')!.target.portName).toBe('requirement')
    expect(onChange.mock.calls[0]?.[1]).toEqual({
      source: 'inspector',
      label: 'Target port name',
      mergeKey: 'edge:e1:target.portName',
      transaction: 'update',
    })
    expect(onChange.mock.calls[1]?.[0]).toEqual(next)
    expect(onChange.mock.calls[1]?.[1]).toEqual({
      source: 'inspector',
      label: 'Target port name',
      mergeKey: 'edge:e1:target.portName',
      transaction: 'update',
      historyBoundary: 'blur',
    })
  })

  test('renaming to an already-occupied port (same source+target) → blocked + conflict text', () => {
    const def = makeDef()
    // Add a sibling edge from `in1` to `agent1` already occupying `requirement`.
    def.edges.push({
      id: 'sibling',
      source: { nodeId: 'in1', portName: 'out' },
      target: { nodeId: 'agent1', portName: 'requirement' },
    })
    const onChange = vi.fn()
    const { container } = render(<Host initialDef={def} onChangeSpy={onChange} />)
    const input = screen
      .getAllByRole('textbox')
      .find((i) => (i as HTMLInputElement).value === 'out')!
    fireEvent.change(input, { target: { value: 'requirement' } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0]?.[0]).toBe(def)
    expect(onChange.mock.calls[0]?.[1]).toMatchObject({
      mergeKey: 'edge:e1:target.portName',
      historyBoundary: 'blur',
    })
    // Asserted via class instead of text so the i18n race in test setup
    // doesn't matter (the conflict box renders <div class="error-box">).
    expect(container.querySelector('.error-box')).not.toBeNull()
  })

  test('renaming to empty / unchanged → no-op (no onChange, no error)', () => {
    const onChange = vi.fn()
    const { container } = render(<Host initialDef={makeDef()} onChangeSpy={onChange} />)
    const input = screen
      .getAllByRole('textbox')
      .find((i) => (i as HTMLInputElement).value === 'out')!
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0]?.[1]).toMatchObject({
      mergeKey: 'edge:e1:target.portName',
      historyBoundary: 'blur',
    })
    expect(container.querySelector('.error-box')).toBeNull()
  })

  test('delete button removes the edge from definition', () => {
    const onChange = vi.fn()
    const { container } = render(<Host initialDef={makeDef()} onChangeSpy={onChange} />)
    // Match by class to avoid i18n race on button label.
    const btn = container.querySelector('.btn--danger') as HTMLButtonElement | null
    expect(btn).not.toBeNull()
    fireEvent.click(btn!)
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0]![0] as WorkflowDefinition
    expect(next.edges.find((e) => e.id === 'e1')).toBeUndefined()
    expect(next.edges).toHaveLength(1)
    expect(onChange.mock.calls[0]?.[1]).toEqual({
      source: 'inspector',
      label: 'Delete edge',
      transaction: 'single',
    })
  })
})

describe('hasConflict', () => {
  test('same source + same target node + same new portName → conflict', () => {
    const def = makeDef()
    def.edges.push({
      id: 'sibling',
      source: { nodeId: 'in1', portName: 'out' },
      target: { nodeId: 'agent1', portName: 'requirement' },
    })
    expect(hasConflict(def, def.edges[0]!, 'requirement')).toBe(true)
  })

  test('same target node + same portName but DIFFERENT source → fan-in, NOT a conflict', () => {
    const def = makeDef()
    expect(hasConflict(def, def.edges[0]!, 'git_diff')).toBe(false)
  })

  test('renaming to its own current portName → not a conflict', () => {
    const def = makeDef()
    expect(hasConflict(def, def.edges[0]!, 'out')).toBe(false)
  })
})
