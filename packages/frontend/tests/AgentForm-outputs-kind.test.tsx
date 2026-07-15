// RFC-194 integration smoke: AgentForm forwards the output Card/Edit Dialog's
// atomic (outputs, outputKinds, outputWrapperPortNames) transaction upward.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

function chooseKind(optionLabel: string) {
  const trigger = screen.getByRole('combobox', { name: /Data type/ })
  fireEvent.click(trigger)
  const option = Array.from(document.querySelectorAll('li[role="option"]')).find((candidate) =>
    (candidate.textContent ?? '').includes(optionLabel),
  )
  if (option === undefined) throw new Error(`kind option '${optionLabel}' not found`)
  fireEvent.mouseDown(option)
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

describe('AgentForm output kind round-trip', () => {
  test('Edit Dialog writes the selected kind while forwarding all output state', async () => {
    const onChange = vi.fn<(next: CreateAgent) => void>()
    const initial: CreateAgent = {
      ...emptyAgent(),
      name: 'demo',
      outputs: ['report'],
      outputWrapperPortNames: { report: 'hidden_legacy_mapping' },
    }
    mount(initial, onChange)

    fireEvent.click(screen.getByRole('button', { name: /^Edit output port report.*1/ }))
    chooseKind('markdown')
    const save = screen.getByTestId('agent-output-port-save') as HTMLButtonElement
    await waitFor(() => expect(save.disabled).toBe(false))
    fireEvent.click(save)

    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0]?.[0] as CreateAgent
    expect(next.outputs).toEqual(['report'])
    expect(next.outputKinds).toEqual({ report: 'markdown' })
    // A normal-role edit cannot see this legacy mapping and must preserve it.
    expect(next.outputWrapperPortNames).toEqual({ report: 'hidden_legacy_mapping' })
  })
})
