// RFC-194 T3 — AgentPortDialog is a local transaction: it owns unfinished
// drafts, validates legacy/duplicate/kind/wrapper states, and commits only an
// atomic input array or output three-field state.

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef, useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import type { AgentInputPort } from '@agent-workflow/shared'
import {
  AgentPortDialog,
  type AgentPortDialogMode,
} from '../src/components/agent-ports/AgentPortDialog'

const INPUTS: AgentInputPort[] = [
  { name: 'request', kind: 'string' },
  { name: 'context', kind: 'markdown' },
]

describe('AgentPortDialog transaction + focus', () => {
  test('name gets initial focus; overlay does not close; Cancel writes nothing and restores trigger', async () => {
    const onCommit = vi.fn()
    const onClose = vi.fn()

    function Probe() {
      const [open, setOpen] = useState(true)
      const triggerRef = useRef<HTMLButtonElement | null>(null)
      return (
        <>
          <button ref={triggerRef} data-testid="trigger">
            Add
          </button>
          <AgentPortDialog
            open={open}
            direction="input"
            mode={{ kind: 'add' }}
            inputs={[]}
            triggerRef={triggerRef}
            onCommit={onCommit}
            onClose={() => {
              onClose()
              setOpen(false)
            }}
          />
        </>
      )
    }

    render(<Probe />)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const name = screen.getByTestId('agent-port-name')
    expect(document.activeElement).toBe(name)

    fireEvent.mouseDown(screen.getByTestId('agent-port-dialog'))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()

    fireEvent.click(screen.getByTestId('agent-port-cancel'))
    expect(onCommit).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('trigger'))
  })

  test('input add commits name/kind/required/trimmed description and closes', async () => {
    const onCommit = vi.fn()
    const onClose = vi.fn()
    render(
      <AgentPortDialog
        open
        direction="input"
        mode={{ kind: 'add' }}
        inputs={[]}
        onCommit={onCommit}
        onClose={onClose}
      />,
    )

    fireEvent.change(screen.getByTestId('agent-port-name'), { target: { value: 'source_file' } })
    fireEvent.click(screen.getByTestId('agent-port-required'))
    const description = screen.getByTestId('agent-port-description')
    expect(description.getAttribute('maxlength')).toBe('2048')
    fireEvent.change(description, { target: { value: '  Main source document  ' } })

    const save = screen.getByTestId('agent-port-save') as HTMLButtonElement
    await waitFor(() => expect(save.disabled).toBe(false))
    fireEvent.click(save)

    expect(onCommit).toHaveBeenCalledWith([
      {
        name: 'source_file',
        kind: 'string',
        required: true,
        description: 'Main source document',
      },
    ])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('switching edit index while open re-seeds the complete local draft', () => {
    const common = {
      open: true,
      direction: 'input' as const,
      inputs: INPUTS,
      onCommit: vi.fn(),
      onClose: vi.fn(),
    }
    const { rerender } = render(<AgentPortDialog {...common} mode={{ kind: 'edit', index: 0 }} />)
    const name = screen.getByTestId('agent-port-name') as HTMLInputElement
    fireEvent.change(name, { target: { value: 'unfinished' } })
    expect(name.value).toBe('unfinished')

    rerender(<AgentPortDialog {...common} mode={{ kind: 'edit', index: 1 }} />)
    expect((screen.getByTestId('agent-port-name') as HTMLInputElement).value).toBe('context')
    expect(screen.queryByTestId('agent-port-kind-advanced-input')).toBeNull()
  })

  test('same-name input refetch with changed fields makes the local transaction stale', () => {
    const onCommit = vi.fn()
    const common = {
      open: true,
      direction: 'input' as const,
      mode: { kind: 'edit' as const, index: 0 },
      onCommit,
      onClose: vi.fn(),
    }
    const { rerender } = render(
      <AgentPortDialog
        {...common}
        inputs={[
          { name: 'request', kind: 'string', required: false, description: 'old description' },
        ]}
      />,
    )
    expect((screen.getByTestId('agent-port-save') as HTMLButtonElement).disabled).toBe(false)

    rerender(
      <AgentPortDialog
        {...common}
        inputs={[
          { name: 'request', kind: 'markdown', required: true, description: 'server refresh' },
        ]}
      />,
    )

    const save = screen.getByTestId('agent-port-save') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(onCommit).not.toHaveBeenCalled()
  })

  test('same-name output refetch with changed sidecars makes the local transaction stale', () => {
    const onCommit = vi.fn()
    const common = {
      open: true,
      direction: 'output' as const,
      mode: { kind: 'edit' as const, index: 0 },
      role: 'aggregator' as const,
      onCommit,
      onClose: vi.fn(),
    }
    const { rerender } = render(
      <AgentPortDialog
        {...common}
        outputState={{
          outputs: ['artifact'],
          outputKinds: { artifact: 'markdown' },
          outputWrapperPortNames: { artifact: 'published_old' },
        }}
      />,
    )
    expect((screen.getByTestId('agent-port-save') as HTMLButtonElement).disabled).toBe(false)

    rerender(
      <AgentPortDialog
        {...common}
        outputState={{
          outputs: ['artifact'],
          outputKinds: { artifact: 'signal' },
          outputWrapperPortNames: { artifact: 'published_fresh' },
        }}
      />,
    )

    const save = screen.getByTestId('agent-port-save') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(onCommit).not.toHaveBeenCalled()
  })
})

describe('AgentPortDialog validation + atomic helpers', () => {
  test('unchanged readable legacy input name passes; a duplicate must be renamed', async () => {
    const legacyCommit = vi.fn()
    const { unmount } = render(
      <AgentPortDialog
        open
        direction="input"
        mode={{ kind: 'edit', index: 0 }}
        inputs={[
          { name: 'Legacy Name', kind: 'string' },
          { name: 'other', kind: 'string' },
        ]}
        onCommit={legacyCommit}
        onClose={() => {}}
      />,
    )
    const legacySave = screen.getByTestId('agent-port-save') as HTMLButtonElement
    await waitFor(() => expect(legacySave.disabled).toBe(false))
    fireEvent.click(legacySave)
    expect(legacyCommit.mock.calls[0]?.[0]?.[0]?.name).toBe('Legacy Name')
    unmount()

    const duplicateCommit = vi.fn()
    render(
      <AgentPortDialog
        open
        direction="input"
        mode={{ kind: 'edit', index: 0 }}
        inputs={[
          { name: 'dup', kind: 'string' },
          { name: 'dup', kind: 'markdown' },
        ]}
        onCommit={duplicateCommit}
        onClose={() => {}}
      />,
    )
    const duplicateName = screen.getByTestId('agent-port-name')
    const duplicateSave = screen.getByTestId('agent-port-save') as HTMLButtonElement
    expect(duplicateSave.disabled).toBe(true)
    const errorId = duplicateName.getAttribute('aria-describedby')
    expect(errorId).not.toBeNull()
    expect(document.getElementById(errorId ?? '')?.getAttribute('role')).toBeNull()

    fireEvent.change(duplicateName, { target: { value: 'unique' } })
    await waitFor(() => expect(duplicateSave.disabled).toBe(false))
    fireEvent.click(duplicateSave)
    expect(duplicateCommit.mock.calls[0]?.[0]?.map((port: AgentInputPort) => port.name)).toEqual([
      'unique',
      'dup',
    ])
  })

  test('invalid stored kind owns one parse alert and blocks save until repaired', async () => {
    const onCommit = vi.fn()
    render(
      <AgentPortDialog
        open
        direction="output"
        mode={{ kind: 'edit', index: 0 }}
        outputState={{ outputs: ['artifact'], outputKinds: { artifact: 'not a kind' } }}
        role="normal"
        onCommit={onCommit}
        onClose={() => {}}
      />,
    )

    const advanced = screen.getByTestId('agent-port-kind-advanced-input')
    const save = screen.getByTestId('agent-port-save') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(screen.queryByRole('alert')).toBeNull()
    const initialError = document.querySelector('.kind-select__error')
    expect(initialError).toBeTruthy()
    expect(advanced.getAttribute('aria-describedby')).toBe(initialError?.id)

    fireEvent.change(advanced, { target: { value: 'markdown' } })
    await waitFor(() => expect(save.disabled).toBe(false))
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(save)
    expect(onCommit).toHaveBeenCalledWith({
      outputs: ['artifact'],
      outputKinds: { artifact: 'markdown' },
      outputWrapperPortNames: undefined,
    })
  })

  test('a newly edited invalid kind is the Dialog-owned live error', async () => {
    render(
      <AgentPortDialog
        open
        direction="output"
        mode={{ kind: 'edit', index: 0 }}
        outputState={{ outputs: ['artifact'], outputKinds: { artifact: 'markdown' } }}
        role="normal"
        onCommit={() => {}}
        onClose={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /advanced/i }))
    const advanced = screen.getByTestId('agent-port-kind-advanced-input')
    fireEvent.change(advanced, { target: { value: 'not a kind' } })
    await waitFor(() => expect(advanced.getAttribute('aria-invalid')).toBe('true'))
    expect(advanced.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id)
  })

  test('schema-rejected nested path kind cannot slip through the input helper', async () => {
    const onCommit = vi.fn()
    render(
      <AgentPortDialog
        open
        direction="input"
        mode={{ kind: 'edit', index: 0 }}
        inputs={[{ name: 'artifact', kind: 'list<list<path<md>>>' }]}
        onCommit={onCommit}
        onClose={() => {}}
      />,
    )

    const advanced = screen.getByTestId('agent-port-kind-advanced-input')
    const save = screen.getByTestId('agent-port-save') as HTMLButtonElement
    // The generic grammar accepts this string, but AgentOutputKindSchema rejects
    // nested path lists because archival supports a single list layer only.
    expect(advanced.getAttribute('aria-invalid')).toBe('true')
    expect(save.disabled).toBe(true)
    expect(screen.queryByRole('alert')).toBeNull()
    const schemaError = document.querySelector('.kind-select__error')
    expect(schemaError).toBeTruthy()
    expect(advanced.getAttribute('aria-describedby')).toBe(schemaError?.id)

    fireEvent.change(advanced, { target: { value: 'markdown' } })
    await waitFor(() => expect(save.disabled).toBe(false))
    fireEvent.click(save)
    expect(onCommit.mock.calls[0]?.[0]?.[0]?.kind).toBe('markdown')
  })

  test('aggregator promoted names are effectively unique and commit all three output fields', async () => {
    const onCommit = vi.fn()
    render(
      <AgentPortDialog
        open
        direction="output"
        mode={{ kind: 'edit', index: 0 }}
        outputState={{
          outputs: ['draft', 'published'],
          outputKinds: { draft: 'markdown' },
          outputWrapperPortNames: { published: 'result' },
        }}
        role="aggregator"
        onCommit={onCommit}
        onClose={() => {}}
      />,
    )

    const wrapper = screen.getByTestId('agent-port-wrapper')
    const save = screen.getByTestId('agent-port-save') as HTMLButtonElement
    fireEvent.change(wrapper, { target: { value: 'result' } })
    expect(save.disabled).toBe(true)
    const errorId = wrapper.getAttribute('aria-describedby')
    expect(document.getElementById(errorId ?? '')?.getAttribute('role')).toBe('alert')

    fireEvent.change(wrapper, { target: { value: 'final_result' } })
    await waitFor(() => expect(save.disabled).toBe(false))
    fireEvent.click(save)
    expect(onCommit).toHaveBeenCalledWith({
      outputs: ['draft', 'published'],
      outputKinds: { draft: 'markdown' },
      outputWrapperPortNames: { published: 'result', draft: 'final_result' },
    })
  })

  test('an orphan sidecar name fails closed inside the helper and leaves the Dialog open', async () => {
    const onCommit = vi.fn()
    const onClose = vi.fn()
    render(
      <AgentPortDialog
        open
        direction="output"
        mode={{ kind: 'add' }}
        outputState={{ outputs: [], outputKinds: { orphan: 'markdown' } }}
        role="normal"
        onCommit={onCommit}
        onClose={onClose}
      />,
    )

    fireEvent.change(screen.getByTestId('agent-port-name'), { target: { value: 'orphan' } })
    const save = screen.getByTestId('agent-port-save') as HTMLButtonElement
    await waitFor(() => expect(save.disabled).toBe(false))
    fireEvent.click(save)

    expect(onCommit).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
    const name = screen.getByTestId('agent-port-name')
    expect(document.getElementById(name.getAttribute('aria-describedby') ?? '')).not.toBeNull()
  })
})

describe('AgentPortDialog nested Escape', () => {
  test('first Escape closes KindSelect and restores its trigger; second closes Dialog with zero writes', async () => {
    const onClose = vi.fn()
    const onCommit = vi.fn()

    function Probe({ mode }: { mode: AgentPortDialogMode }) {
      const [open, setOpen] = useState(true)
      return (
        <AgentPortDialog
          open={open}
          direction="output"
          mode={mode}
          outputState={{ outputs: ['artifact'] }}
          role="normal"
          onCommit={onCommit}
          onClose={() => {
            onClose()
            setOpen(false)
          }}
        />
      )
    }

    render(<Probe mode={{ kind: 'edit', index: 0 }} />)
    const combobox = screen.getByRole('combobox')
    fireEvent.click(combobox)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const listbox = screen.getByRole('listbox')

    fireEvent.keyDown(listbox, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(combobox.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(combobox)

    fireEvent.keyDown(combobox, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
