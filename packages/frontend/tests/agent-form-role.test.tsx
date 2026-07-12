// RFC-060 PR-B — AgentForm role + outputWrapperPortNames field tests.
//
// Locks:
//  1. Form renders a role selector with two options (normal / aggregator)
//     using the public `<Select>` chrome (RFC-035 consistency).
//  2. Default value (role undefined → display "Normal") wires through.
//  3. Selecting "Aggregator" surfaces role: 'aggregator' upward via onChange.
//  4. Selecting back to "Normal" clears role to undefined (so fmExtra stays
//     byte-identical to pre-RFC-060 agents — see services/agent.ts).
//  5. outputWrapperPortNames JSON field is hidden when role !== 'aggregator'.
//  6. outputWrapperPortNames JSON field shows + round-trips when role === 'aggregator'.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { CreateAgent } from '@agent-workflow/shared'
import { AgentForm, emptyAgent } from '../src/components/AgentForm'
import { setBaseUrl, setToken } from '../src/stores/auth'

function clickSelectOption(triggerLabel: RegExp, optionLabel: string) {
  // Public Select is a button[role=combobox] + portaled ul[role=listbox];
  // options dispatch onChange via mouseDown (matches canvas-sharding-inspector
  // pattern). fireEvent.click on a portaled <li> doesn't fire React handlers
  // attached via onMouseDown.
  const trigger = screen.getByRole('combobox', { name: triggerLabel }) as HTMLButtonElement
  fireEvent.click(trigger)
  const list = document.querySelector('ul[role="listbox"]') as HTMLUListElement | null
  if (list === null) throw new Error('listbox not opened')
  const opt = Array.from(list.querySelectorAll('li[role="option"]')).find((li) =>
    (li.textContent ?? '').includes(optionLabel),
  )
  if (opt === undefined) throw new Error(`option '${optionLabel}' not found`)
  fireEvent.mouseDown(opt)
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
  // RFC-169: role + outputWrapperPortNames live in the Advanced tab; open it so
  // the combobox is accessible (hidden panels are excluded from getByRole).
  fireEvent.click(screen.getByRole('tab', { name: 'Advanced' }))
  return utils
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

describe('AgentForm — role selector', () => {
  test('renders a role combobox with two options', () => {
    const onChange = vi.fn<(next: CreateAgent) => void>()
    const initial: CreateAgent = { ...emptyAgent(), name: 'demo' }
    mount(initial, onChange)

    const trigger = screen.getByRole('combobox', { name: /^Role$/ })
    expect(trigger).toBeTruthy()
    // Default selection shows "Normal" because role is undefined.
    expect(trigger.textContent).toMatch(/Normal/)
  })

  test('selecting Aggregator surfaces role: aggregator on onChange', () => {
    const onChange = vi.fn<(next: CreateAgent) => void>()
    const initial: CreateAgent = { ...emptyAgent(), name: 'demo' }
    mount(initial, onChange)

    clickSelectOption(/^Role$/, 'Aggregator')

    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0]?.[0] as CreateAgent
    expect(next.role).toBe('aggregator')
  })

  test('switching back to Normal clears role to undefined (byte-identical fmExtra)', () => {
    const onChange = vi.fn<(next: CreateAgent) => void>()
    const initial: CreateAgent = { ...emptyAgent(), name: 'demo', role: 'aggregator' }
    mount(initial, onChange)

    clickSelectOption(/^Role$/, 'Normal')

    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0]?.[0] as CreateAgent
    expect(next.role).toBeUndefined()
  })
})

describe('AgentForm — outputWrapperPortNames field visibility', () => {
  test('hidden when role is normal / undefined', () => {
    const onChange = vi.fn<(next: CreateAgent) => void>()
    const initial: CreateAgent = { ...emptyAgent(), name: 'demo' }
    mount(initial, onChange)

    expect(screen.queryByText(/Output → wrapper port name map/i)).toBeNull()
  })

  test('shown when role is aggregator', () => {
    const onChange = vi.fn<(next: CreateAgent) => void>()
    const initial: CreateAgent = {
      ...emptyAgent(),
      name: 'demo',
      role: 'aggregator',
    }
    mount(initial, onChange)

    expect(screen.getByText(/Output → wrapper port name map/i)).toBeTruthy()
  })

  test('JsonField round-trips a {port: rename} object', () => {
    const onChange = vi.fn<(next: CreateAgent) => void>()
    const initial: CreateAgent = {
      ...emptyAgent(),
      name: 'demo',
      role: 'aggregator',
    }
    mount(initial, onChange)

    const field = screen.getByPlaceholderText(/"report":"final"/) as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: '{"report":"final"}' } })
    // JsonField emits onChange only when the JSON parses to a valid object;
    // the last call shape carries outputWrapperPortNames.
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]
    expect(lastCall).toBeTruthy()
    const next = lastCall?.[0] as CreateAgent
    expect(next.outputWrapperPortNames).toEqual({ report: 'final' })
  })
})
