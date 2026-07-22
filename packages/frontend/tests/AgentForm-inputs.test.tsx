// RFC-194 — AgentForm input ports use explicit Card + Add/Edit Dialog
// transactions. No inline composer, blur commit, or Backspace delete remains.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { CreateAgent } from '@agent-workflow/shared'
import { AgentForm, emptyAgent } from '../src/components/AgentForm'
import { setBaseUrl, setToken } from '../src/stores/auth'

function mount(initial: CreateAgent, onChange: (next: CreateAgent) => void) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  })
  const utils = render(
    <QueryClientProvider client={qc}>
      <AgentForm value={initial} onChange={onChange} />
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByRole('tab', { name: /Ports/ }))
  return utils
}

function lastPayload(onChange: ReturnType<typeof vi.fn>): CreateAgent {
  return onChange.mock.calls.at(-1)?.[0] as CreateAgent
}

function openInputEditor(name: string, position = 1) {
  fireEvent.click(
    screen.getByRole('button', {
      name: new RegExp(`^Edit input port ${name}.*${position}`),
    }),
  )
}

function chooseKind(optionLabel: string) {
  const trigger = screen.getByRole('combobox', { name: /Data type/ })
  fireEvent.click(trigger)
  const option = Array.from(document.querySelectorAll('li[role="option"]')).find((candidate) =>
    (candidate.textContent ?? '').includes(optionLabel),
  )
  if (option === undefined) throw new Error(`kind option '${optionLabel}' not found`)
  fireEvent.mouseDown(option)
}

async function saveInputDialog() {
  const save = screen.getByTestId('agent-input-port-save') as HTMLButtonElement
  await waitFor(() => expect(save.disabled).toBe(false))
  fireEvent.click(save)
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('AgentForm input port cards and Dialog', () => {
  test('explicit Add commits a port with the default string kind', async () => {
    const onChange = vi.fn<(next: CreateAgent) => void>()
    mount({ ...emptyAgent(), name: 'demo' }, onChange)

    expect(screen.getByTestId('agent-input-ports-empty')).toBeTruthy()
    expect(screen.queryByPlaceholderText(/input port name then Enter/i)).toBeNull()
    fireEvent.click(screen.getByTestId('agent-input-port-add'))
    fireEvent.change(screen.getByTestId('agent-input-port-name'), {
      target: { value: 'diff' },
    })
    await saveInputDialog()

    expect(lastPayload(onChange).inputs).toEqual([{ name: 'diff', kind: 'string' }])
  })

  test('Edit Dialog commits kind and trimmed description together', async () => {
    const onChange = vi.fn<(next: CreateAgent) => void>()
    mount(
      {
        ...emptyAgent(),
        name: 'demo',
        inputs: [{ name: 'spec', kind: 'string', description: 'Old description' }],
      },
      onChange,
    )

    expect(screen.getByText('Old description')).toBeTruthy()
    openInputEditor('spec')
    expect((screen.getByTestId('agent-input-port-description') as HTMLTextAreaElement).value).toBe(
      'Old description',
    )
    chooseKind('markdown')
    fireEvent.change(screen.getByTestId('agent-input-port-description'), {
      target: { value: '  Detailed specification  ' },
    })
    await saveInputDialog()

    expect(lastPayload(onChange).inputs).toEqual([
      { name: 'spec', kind: 'markdown', description: 'Detailed specification' },
    ])
  })

  test('Edit Dialog commits the required flag without losing other input fields', async () => {
    const onChange = vi.fn<(next: CreateAgent) => void>()
    mount(
      {
        ...emptyAgent(),
        name: 'demo',
        inputs: [{ name: 'diff', kind: 'path<md>', description: 'Patch file' }],
      },
      onChange,
    )

    openInputEditor('diff')
    // RFC-218: absence means required (D5), so the dialog opens CHECKED and
    // this click turns Required off — the explicit false must persist.
    fireEvent.click(screen.getByTestId('agent-input-port-required'))
    await saveInputDialog()

    expect(lastPayload(onChange).inputs).toEqual([
      { name: 'diff', kind: 'path<md>', required: false, description: 'Patch file' },
    ])
  })

  test('two-click card deletion drops the input port', () => {
    const onChange = vi.fn<(next: CreateAgent) => void>()
    mount(
      {
        ...emptyAgent(),
        name: 'demo',
        inputs: [{ name: 'diff', kind: 'string', description: 'Keep until confirmed' }],
      },
      onChange,
    )

    const remove = screen.getByRole('button', { name: /^Delete input port diff.*1/ })
    fireEvent.click(remove)
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /^Confirm delet.*input port diff.*1/ }))

    expect(lastPayload(onChange).inputs).toEqual([])
  })
})
