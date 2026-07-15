// RFC-194 — OutputsEditor is an explicit card + Dialog editor for one logical
// three-field value: outputs, outputKinds, and outputWrapperPortNames.
// These tests deliberately exercise the public UI transaction instead of the
// retired inline token composer / per-row controls.

import { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { AgentOutputKindsMap } from '@agent-workflow/shared'
import { OutputsEditor } from '../src/components/OutputsEditor'

type WrapperMap = Record<string, string>
type OnChange = (
  outputs: string[],
  kinds: AgentOutputKindsMap | undefined,
  wrappers: WrapperMap | undefined,
) => void

interface InitialState {
  outputs: string[]
  kinds?: AgentOutputKindsMap
  wrappers?: WrapperMap
  aggregator?: boolean
}

function mountStateful(initial: InitialState, spy: OnChange = vi.fn<OnChange>()) {
  function Harness() {
    const [outputs, setOutputs] = useState(initial.outputs)
    const [kinds, setKinds] = useState<AgentOutputKindsMap | undefined>(initial.kinds)
    const [wrappers, setWrappers] = useState<WrapperMap | undefined>(initial.wrappers)
    return (
      <OutputsEditor
        outputs={outputs}
        outputKinds={kinds}
        outputWrapperPortNames={wrappers}
        aggregator={initial.aggregator}
        onChange={(nextOutputs, nextKinds, nextWrappers) => {
          spy(nextOutputs, nextKinds, nextWrappers)
          setOutputs(nextOutputs)
          setKinds(nextKinds)
          setWrappers(nextWrappers)
        }}
      />
    )
  }

  return { ...render(<Harness />), spy }
}

function openEdit(name: string, position: number) {
  fireEvent.click(
    screen.getByRole('button', {
      name: new RegExp(`^Edit output port ${name}.*${position}`),
    }),
  )
  return screen.getByTestId('agent-output-port-dialog')
}

async function saveDialog() {
  const save = screen.getByTestId('agent-output-port-save') as HTMLButtonElement
  await waitFor(() => expect(save.disabled).toBe(false))
  fireEvent.click(save)
}

function confirmDelete(name: string, position: number) {
  fireEvent.click(
    screen.getByRole('button', {
      name: new RegExp(`^Delete output port ${name}.*${position}`),
    }),
  )
  fireEvent.click(
    screen.getByRole('button', {
      name: new RegExp(`^Confirm deletion of output port ${name}.*${position}`),
    }),
  )
}

describe('OutputsEditor explicit card and Dialog flow', () => {
  test('renders a useful empty state and adds the first port only after Dialog save', async () => {
    const { spy } = mountStateful({ outputs: [] })

    expect(screen.getByTestId('agent-output-ports-empty')).toBeTruthy()
    expect(screen.queryByTestId('agent-output-port-list')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()

    fireEvent.click(screen.getByTestId('agent-output-port-add'))
    const dialog = screen.getByTestId('agent-output-port-dialog')
    expect(within(dialog).getByRole('dialog')).toBeTruthy()
    fireEvent.change(screen.getByTestId('agent-output-port-name'), {
      target: { value: 'result' },
    })

    expect(spy).not.toHaveBeenCalled()
    await saveDialog()

    expect(spy).toHaveBeenLastCalledWith(['result'], undefined, undefined)
    expect(screen.queryByTestId('agent-output-ports-empty')).toBeNull()
    expect(screen.getByTestId('agent-port-card-output-0')).toBeTruthy()
  })

  test('renders declared outputs as read-only cards with canonical kind summaries', () => {
    const { container } = mountStateful({
      outputs: ['summary', 'report'],
      kinds: { report: 'markdown_file' },
    })

    expect(screen.getAllByTestId(/^agent-port-card-output-/)).toHaveLength(2)
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(
      container.querySelector(
        '[data-testid="agent-port-card-output-0"] .agent-port-card__kind-code',
      )?.textContent,
    ).toBe('string')
    expect(
      container.querySelector(
        '[data-testid="agent-port-card-output-1"] .agent-port-card__kind-code',
      )?.textContent,
    ).toBe('path<md>')
  })

  test('aggregator rename and delete update both sidecar maps atomically', async () => {
    const { spy } = mountStateful({
      outputs: ['report', 'keep'],
      kinds: { report: 'markdown', keep: 'signal' },
      wrappers: { report: 'old_promoted', keep: 'keep_promoted' },
      aggregator: true,
    })

    openEdit('report', 1)
    fireEvent.change(screen.getByTestId('agent-output-port-name'), {
      target: { value: 'final_report' },
    })
    fireEvent.change(screen.getByTestId('agent-output-port-wrapper'), {
      target: { value: 'new_promoted' },
    })
    expect(screen.getByText(/Renaming may invalidate existing workflow references/)).toBeTruthy()
    expect(spy).not.toHaveBeenCalled()

    await saveDialog()
    expect(spy).toHaveBeenLastCalledWith(
      ['final_report', 'keep'],
      { keep: 'signal', final_report: 'markdown' },
      { keep: 'keep_promoted', final_report: 'new_promoted' },
    )

    confirmDelete('final_report', 1)
    expect(spy).toHaveBeenLastCalledWith(['keep'], { keep: 'signal' }, { keep: 'keep_promoted' })
  })

  test('normal role hides the wrapper field but preserves and migrates its stored mapping', async () => {
    const { spy } = mountStateful({
      outputs: ['report'],
      kinds: { report: 'markdown' },
      wrappers: { report: 'promoted_report' },
      aggregator: false,
    })

    openEdit('report', 1)
    expect(screen.queryByTestId('agent-output-port-wrapper')).toBeNull()
    expect(screen.getByText(/promoted_report.*inactive/i)).toBeTruthy()
    fireEvent.change(screen.getByTestId('agent-output-port-name'), {
      target: { value: 'final_report' },
    })
    await saveDialog()

    expect(spy).toHaveBeenLastCalledWith(
      ['final_report'],
      { final_report: 'markdown' },
      { final_report: 'promoted_report' },
    )
  })

  test('orphan repair clears same-key sidecars independently and emits final empty-map tombstones', async () => {
    const { spy } = mountStateful({
      outputs: [],
      kinds: { ghost: 'markdown' },
      wrappers: { ghost: 'published' },
    })

    expect(screen.getAllByRole('button', { name: /orphan mapping.*ghost/i })).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: /Clean up.*outputKinds:ghost/i }))
    fireEvent.click(screen.getByRole('button', { name: /Confirm cleanup.*outputKinds:ghost/i }))

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Clean up.*outputKinds:ghost/i })).toBeNull(),
    )
    expect(
      screen.getByRole('button', { name: /Clean up.*outputWrapperPortNames:ghost/i }),
    ).toBeTruthy()
    expect(spy).toHaveBeenLastCalledWith([], {}, { ghost: 'published' })

    fireEvent.click(screen.getByRole('button', { name: /Clean up.*outputWrapperPortNames:ghost/i }))
    fireEvent.click(
      screen.getByRole('button', { name: /Confirm cleanup.*outputWrapperPortNames:ghost/i }),
    )
    await waitFor(() => expect(screen.queryByText(/Unlinked output mappings found/)).toBeNull())
    expect(spy).toHaveBeenLastCalledWith([], {}, {})
  })

  test('orphan confirmation is reset when a refetch replaces the same source and key value', () => {
    const onChange = vi.fn<OnChange>()
    const { rerender } = render(
      <OutputsEditor outputs={[]} outputKinds={{ ghost: 'markdown' }} onChange={onChange} />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Clean up.*outputKinds:ghost/i }))
    expect(screen.getByRole('button', { name: /Confirm cleanup.*outputKinds:ghost/i })).toBeTruthy()

    rerender(<OutputsEditor outputs={[]} outputKinds={{ ghost: 'signal' }} onChange={onChange} />)
    expect(screen.getByText(/signal/)).toBeTruthy()
    const refreshed = screen.getByRole('button', { name: /Clean up.*outputKinds:ghost/i })
    fireEvent.click(refreshed)
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Confirm cleanup.*outputKinds:ghost/i })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Confirm cleanup.*outputKinds:ghost/i }))
    expect(onChange).toHaveBeenCalledWith([], {}, undefined)
  })

  test('duplicate and invalid names stay local and cannot be submitted', () => {
    const { spy } = mountStateful({ outputs: ['summary'] })
    fireEvent.click(screen.getByTestId('agent-output-port-add'))
    const name = screen.getByTestId('agent-output-port-name')
    const save = screen.getByTestId('agent-output-port-save') as HTMLButtonElement

    fireEvent.change(name, { target: { value: 'summary' } })
    expect(save.disabled).toBe(true)
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText(/Port names must be unique/)).toBeTruthy()

    fireEvent.change(name, { target: { value: 'BadName' } })
    expect(save.disabled).toBe(true)
    expect(screen.getByText(/Start with a lowercase letter/)).toBeTruthy()
    expect(spy).not.toHaveBeenCalled()
  })
})
