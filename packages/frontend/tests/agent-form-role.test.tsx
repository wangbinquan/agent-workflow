// RFC-060 + RFC-194 — role remains in Advanced, while aggregator promotion
// mappings move to each output port's transactional Edit Dialog.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { CreateAgent } from '@agent-workflow/shared'
import { AgentForm, emptyAgent } from '../src/components/AgentForm'
import { setBaseUrl, setToken } from '../src/stores/auth'

function clickSelectOption(triggerLabel: RegExp, optionLabel: string) {
  const trigger = screen.getByRole('combobox', { name: triggerLabel }) as HTMLButtonElement
  fireEvent.click(trigger)
  const list = document.querySelector('ul[role="listbox"]') as HTMLUListElement | null
  if (list === null) throw new Error('listbox not opened')
  const option = Array.from(list.querySelectorAll('li[role="option"]')).find((candidate) =>
    (candidate.textContent ?? '').includes(optionLabel),
  )
  if (option === undefined) throw new Error(`option '${optionLabel}' not found`)
  fireEvent.mouseDown(option)
}

function mount(initial: CreateAgent, onChange: (next: CreateAgent) => void) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  })
  const utils = render(
    <QueryClientProvider client={qc}>
      <AgentForm value={initial} onChange={onChange} />
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByRole('tab', { name: 'Advanced' }))
  return utils
}

function openPorts() {
  fireEvent.click(screen.getByRole('tab', { name: /Ports/ }))
}

function openOutputEditor(name: string, position = 1) {
  fireEvent.click(
    screen.getByRole('button', {
      name: new RegExp(`^Edit output port ${name}.*${position}`),
    }),
  )
}

async function saveOutputDialog() {
  const save = screen.getByTestId('agent-output-port-save') as HTMLButtonElement
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
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('AgentForm role selector', () => {
  test('renders Normal by default', () => {
    mount({ ...emptyAgent(), name: 'demo' }, vi.fn())

    const trigger = screen.getByRole('combobox', { name: /^Role$/ })
    expect(trigger.textContent).toMatch(/Normal/)
  })

  test('selecting Aggregator preserves hidden mappings and surfaces the role', () => {
    const onChange = vi.fn<(next: CreateAgent) => void>()
    mount(
      {
        ...emptyAgent(),
        name: 'demo',
        outputs: ['report'],
        outputWrapperPortNames: { report: 'final' },
      },
      onChange,
    )

    clickSelectOption(/^Role$/, 'Aggregator')

    const next = onChange.mock.calls[0]?.[0] as CreateAgent
    expect(next.role).toBe('aggregator')
    expect(next.outputWrapperPortNames).toEqual({ report: 'final' })
  })

  test('switching back to Normal clears only role and keeps promotion mappings', () => {
    const onChange = vi.fn<(next: CreateAgent) => void>()
    mount(
      {
        ...emptyAgent(),
        name: 'demo',
        role: 'aggregator',
        outputs: ['report'],
        outputWrapperPortNames: { report: 'final' },
      },
      onChange,
    )

    clickSelectOption(/^Role$/, 'Normal')

    const next = onChange.mock.calls[0]?.[0] as CreateAgent
    expect(next.role).toBeUndefined()
    expect(next.outputWrapperPortNames).toEqual({ report: 'final' })
  })
})

describe('AgentForm wrapper promotion editing', () => {
  test.each([undefined, 'aggregator' as const])(
    'Advanced has no raw outputWrapperPortNames JSON block (role=%s)',
    (role) => {
      mount({ ...emptyAgent(), name: 'demo', role }, vi.fn())

      expect(screen.queryByText(/Output → wrapper port name map/i)).toBeNull()
      expect(screen.queryByPlaceholderText(/"report":"final"/)).toBeNull()
    },
  )

  test('aggregator wrapper mapping round-trips through the output Edit Dialog', async () => {
    const onChange = vi.fn<(next: CreateAgent) => void>()
    mount(
      {
        ...emptyAgent(),
        name: 'demo',
        role: 'aggregator',
        outputs: ['report'],
        outputKinds: { report: 'markdown' },
        outputWrapperPortNames: { report: 'old_final' },
      },
      onChange,
    )
    openPorts()
    openOutputEditor('report')

    const wrapper = screen.getByTestId('agent-output-port-wrapper') as HTMLInputElement
    expect(wrapper.value).toBe('old_final')
    fireEvent.change(wrapper, { target: { value: 'final' } })
    await saveOutputDialog()

    const next = onChange.mock.calls.at(-1)?.[0] as CreateAgent
    expect(next.role).toBe('aggregator')
    expect(next.outputs).toEqual(['report'])
    expect(next.outputKinds).toEqual({ report: 'markdown' })
    expect(next.outputWrapperPortNames).toEqual({ report: 'final' })
  })

  test('normal Edit Dialog hides and preserves a legacy wrapper mapping', async () => {
    const onChange = vi.fn<(next: CreateAgent) => void>()
    mount(
      {
        ...emptyAgent(),
        name: 'demo',
        outputs: ['report'],
        outputKinds: { report: 'markdown' },
        outputWrapperPortNames: { report: 'final' },
      },
      onChange,
    )
    openPorts()
    openOutputEditor('report')

    expect(screen.queryByTestId('agent-output-port-wrapper')).toBeNull()
    clickSelectOption(/Data type/, 'string')
    await saveOutputDialog()

    const next = onChange.mock.calls.at(-1)?.[0] as CreateAgent
    expect(next.role).toBeUndefined()
    expect(next.outputs).toEqual(['report'])
    expect(next.outputKinds).toEqual({})
    expect(next.outputWrapperPortNames).toEqual({ report: 'final' })
  })
})
