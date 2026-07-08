// RFC-151 PR-1 — OutputsEditor × useChipsCommit: outputKinds roundtrip lock.
//
// OutputsEditor is NOT a plain chips list: each port row carries a KindSelect
// and the component must keep the outputKinds map in sync (delete a port →
// its kind entry goes too). RFC-151 extracted the add-input's token-commit
// core (Enter/comma commit, Backspace delete-last, dedup, validate) into the
// shared `useChipsCommit` hook exported from ChipsInput.tsx — the design-gate
// risk is that the extraction silently drops the kinds bookkeeping. This
// suite locks the roundtrip:
//   add port → pick kind → map entry written;
//   delete port (row × AND Backspace) → map entry pruned;
//   editing other ports never loses an existing non-default kind.
// Rendering itself is already locked by OutputsEditor.test.tsx (unchanged).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { AgentOutputKindsMap } from '@agent-workflow/shared'
import { OutputsEditor } from '../src/components/OutputsEditor'

type OnChange = (outputs: string[], kinds: AgentOutputKindsMap | undefined) => void

// Controlled harness that feeds every change back in, so multi-step
// interactions run against the updated value (same pattern as
// OutputsEditor.test.tsx's mountStateful).
function mountStateful(
  initialOutputs: string[],
  initialKinds: AgentOutputKindsMap | undefined,
  spy: OnChange,
) {
  function Harness() {
    const [outputs, setOutputs] = useState(initialOutputs)
    const [kinds, setKinds] = useState(initialKinds)
    return (
      <OutputsEditor
        outputs={outputs}
        outputKinds={kinds}
        onChange={(o, k) => {
          spy(o, k)
          setOutputs(o)
          setKinds(k)
        }}
        placeholder="add a port"
      />
    )
  }
  return render(<Harness />)
}

function addPort(name: string) {
  const input = screen.getByPlaceholderText('add a port') as HTMLInputElement
  fireEvent.change(input, { target: { value: name } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

function pickKind(port: string, optionLabel: string) {
  const trigger = screen.getByRole('combobox', {
    name: new RegExp(`Output kind for ${port}`),
  }) as HTMLButtonElement
  fireEvent.click(trigger)
  const opt = Array.from(document.querySelectorAll('li[role="option"]')).find((li) =>
    (li.textContent ?? '').includes(optionLabel),
  )
  if (opt === undefined) throw new Error(`option '${optionLabel}' not found`)
  fireEvent.mouseDown(opt)
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('OutputsEditor — outputKinds roundtrip through the shared commit hook', () => {
  test('add port → select kind → remove port: map entry follows the port', () => {
    const spy = vi.fn<OnChange>()
    mountStateful([], undefined, spy)

    addPort('report')
    expect(spy).toHaveBeenLastCalledWith(['report'], undefined)

    pickKind('report', 'markdown')
    expect(spy).toHaveBeenLastCalledWith(['report'], { report: 'markdown' })

    fireEvent.click(screen.getByLabelText('Remove report'))
    expect(spy).toHaveBeenLastCalledWith([], undefined)
  })

  test('Backspace on empty input removes the last port AND its kind entry', () => {
    const spy = vi.fn<OnChange>()
    mountStateful(['summary', 'report'], { report: 'markdown' }, spy)
    const input = screen.getByPlaceholderText('add a port') as HTMLInputElement
    fireEvent.keyDown(input, { key: 'Backspace' })
    expect(spy).toHaveBeenLastCalledWith(['summary'], undefined)
  })

  test('edit roundtrip never loses an unrelated non-default kind', () => {
    const spy = vi.fn<OnChange>()
    mountStateful(['report'], { report: 'markdown' }, spy)

    // Add a second port — report's kind must survive untouched.
    addPort('extra')
    expect(spy).toHaveBeenLastCalledWith(['report', 'extra'], { report: 'markdown' })

    // Backspace-remove the freshly added kindless port — still untouched.
    const input = screen.getByPlaceholderText('add a port') as HTMLInputElement
    fireEvent.keyDown(input, { key: 'Backspace' })
    expect(spy).toHaveBeenLastCalledWith(['report'], { report: 'markdown' })
  })

  test('dedup and pattern validation still gate the add input (hook wiring)', () => {
    const spy = vi.fn<OnChange>()
    mountStateful(['report'], undefined, spy)
    const input = screen.getByPlaceholderText('add a port') as HTMLInputElement

    fireEvent.change(input, { target: { value: 'report' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(spy).not.toHaveBeenCalled()
    expect(screen.getByText(/duplicate/)).toBeTruthy()

    fireEvent.change(input, { target: { value: 'BadName' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('source-level: one token-commit core, no fork', () => {
  const chipsSrc = readFileSync(
    join(__dirname, '..', 'src', 'components', 'ChipsInput.tsx'),
    'utf8',
  )
  const outputsSrc = readFileSync(
    join(__dirname, '..', 'src', 'components', 'OutputsEditor.tsx'),
    'utf8',
  )

  test('ChipsInput exports useChipsCommit and consumes it itself', () => {
    expect(chipsSrc).toContain('export function useChipsCommit')
    expect(chipsSrc).toContain('useChipsCommit({')
  })

  test('OutputsEditor delegates commit/keyboard semantics to the hook', () => {
    expect(outputsSrc).toContain("import { useChipsCommit } from './ChipsInput'")
    // The forked keyboard handler must not come back.
    expect(outputsSrc.includes("e.key === 'Enter'"), 'local Enter handling returned').toBe(false)
    expect(outputsSrc.includes("e.key === 'Backspace'"), 'local Backspace handling returned').toBe(
      false,
    )
    expect(outputsSrc.includes('.includes(token)'), 'local dedup check returned').toBe(false)
  })
})
