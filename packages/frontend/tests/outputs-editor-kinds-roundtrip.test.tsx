// RFC-194 — output kinds round-trip through the explicit Dialog transaction.
// The old Enter/comma/Backspace token composer is intentionally gone: edits
// remain local until Save, and deletion is a visible two-step card action.

import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { AgentOutputKindsMap } from '@agent-workflow/shared'
import { OutputsEditor } from '../src/components/OutputsEditor'

type WrapperMap = Record<string, string>
type OnChange = (
  outputs: string[],
  kinds: AgentOutputKindsMap | undefined,
  wrappers: WrapperMap | undefined,
) => void

function mountStateful(
  initialOutputs: string[],
  initialKinds: AgentOutputKindsMap | undefined,
  initialWrappers: WrapperMap | undefined,
  spy: OnChange,
) {
  function Harness() {
    const [outputs, setOutputs] = useState(initialOutputs)
    const [kinds, setKinds] = useState<AgentOutputKindsMap | undefined>(initialKinds)
    const [wrappers, setWrappers] = useState<WrapperMap | undefined>(initialWrappers)
    return (
      <OutputsEditor
        outputs={outputs}
        outputKinds={kinds}
        outputWrapperPortNames={wrappers}
        onChange={(nextOutputs, nextKinds, nextWrappers) => {
          spy(nextOutputs, nextKinds, nextWrappers)
          setOutputs(nextOutputs)
          setKinds(nextKinds)
          setWrappers(nextWrappers)
        }}
      />
    )
  }

  return render(<Harness />)
}

function chooseOption(trigger: HTMLElement, optionLabel: RegExp) {
  fireEvent.click(trigger)
  const option = screen
    .getAllByRole('option')
    .find((candidate) => optionLabel.test(candidate.textContent ?? ''))
  if (option === undefined) throw new Error(`option ${String(optionLabel)} not found`)
  fireEvent.mouseDown(option)
}

function editPort(name: string, position: number) {
  fireEvent.click(
    screen.getByRole('button', {
      name: new RegExp(`^Edit output port ${name}.*${position}`),
    }),
  )
}

async function saveDialog() {
  const save = screen.getByTestId('agent-output-port-save') as HTMLButtonElement
  await waitFor(() => expect(save.disabled).toBe(false))
  fireEvent.click(save)
}

describe('OutputsEditor kind and sidecar round-trip', () => {
  test('Add Dialog composes list<path<md>> and emits all three fields only on Save', async () => {
    const spy = vi.fn<OnChange>()
    mountStateful([], undefined, undefined, spy)

    fireEvent.click(screen.getByTestId('agent-output-port-add'))
    fireEvent.change(screen.getByTestId('agent-output-port-name'), {
      target: { value: 'docs' },
    })
    chooseOption(screen.getByRole('combobox', { name: /docs.*Data type/i }), /file path/i)
    chooseOption(screen.getByRole('combobox', { name: /docs.*file extension/i }), /Markdown/i)
    fireEvent.click(screen.getByRole('checkbox', { name: /docs.*list/i }))

    expect(spy).not.toHaveBeenCalled()
    await saveDialog()

    expect(spy).toHaveBeenLastCalledWith(['docs'], { docs: 'list<path<md>>' }, undefined)
    expect(
      document.querySelector('[data-testid="agent-port-card-output-0"] .agent-port-card__kind-code')
        ?.textContent,
    ).toBe('list<path<md>>')
  })

  test('editing one port back to string drops only its kind entry', async () => {
    const spy = vi.fn<OnChange>()
    mountStateful(['report', 'keep'], { report: 'markdown', keep: 'signal' }, undefined, spy)

    editPort('report', 1)
    chooseOption(screen.getByRole('combobox', { name: /report.*Data type/i }), /^string/i)
    expect(spy).not.toHaveBeenCalled()
    await saveDialog()

    expect(spy).toHaveBeenLastCalledWith(['report', 'keep'], { keep: 'signal' }, undefined)
  })

  test('Cancel discards an unfinished kind change', () => {
    const spy = vi.fn<OnChange>()
    mountStateful(['report'], { report: 'markdown' }, undefined, spy)

    editPort('report', 1)
    chooseOption(screen.getByRole('combobox', { name: /report.*Data type/i }), /file path/i)
    fireEvent.click(screen.getByTestId('agent-output-port-cancel'))

    expect(spy).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(
      document.querySelector('[data-testid="agent-port-card-output-0"] .agent-port-card__kind-code')
        ?.textContent,
    ).toBe('markdown')
  })

  test('Backspace is inert; explicit confirmed delete prunes kind and wrapper tombstones', () => {
    const spy = vi.fn<OnChange>()
    mountStateful(['summary', 'report'], { report: 'markdown' }, { report: 'promoted_report' }, spy)

    const add = screen.getByTestId('agent-output-port-add')
    fireEvent.keyDown(add, { key: 'Backspace' })
    expect(spy).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /^Delete output port report.*2/ }))
    expect(spy).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole('button', { name: /^Confirm deletion of output port report.*2/ }),
    )

    // Empty maps are intentional sparse-update tombstones: returning undefined
    // here would preserve the stale server values on PUT.
    expect(spy).toHaveBeenLastCalledWith(['summary'], {}, {})
  })
})
