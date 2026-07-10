// RFC-166 (T7) — AgentForm's InputsEditor forwards declared input ports as a
// single onChange payload so callers PUT /api/agents with `inputs` set. Locks:
//  1. Adding a port (type + Enter) surfaces inputs with the default string kind.
//  2. Changing a port's kind via the shared KindSelect surfaces inputs[].kind.
//  3. Toggling the per-port `required` checkbox surfaces inputs[].required.
//  4. Removing a port drops it from inputs.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { CreateAgent } from '@agent-workflow/shared'
import { AgentForm, emptyAgent } from '../src/components/AgentForm'
import { setBaseUrl, setToken } from '../src/stores/auth'

function mount(initial: CreateAgent, onChange: (next: CreateAgent) => void) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <AgentForm value={initial} onChange={onChange} />
    </QueryClientProvider>,
  )
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

function lastPayload(onChange: ReturnType<typeof vi.fn>): CreateAgent {
  return onChange.mock.calls.at(-1)?.[0] as CreateAgent
}

describe('AgentForm inputs port editor', () => {
  test('adding an input port surfaces inputs[] with the default string kind', () => {
    const onChange = vi.fn<(next: CreateAgent) => void>()
    mount({ ...emptyAgent(), name: 'demo' }, onChange)

    const add = screen.getByPlaceholderText('add an input port name then Enter')
    fireEvent.change(add, { target: { value: 'diff' } })
    fireEvent.keyDown(add, { key: 'Enter' })

    expect(onChange).toHaveBeenCalled()
    expect(lastPayload(onChange).inputs).toEqual([{ name: 'diff', kind: 'string' }])
  })

  test('changing a port kind surfaces inputs[].kind', () => {
    const onChange = vi.fn<(next: CreateAgent) => void>()
    mount({ ...emptyAgent(), name: 'demo', inputs: [{ name: 'spec', kind: 'string' }] }, onChange)

    const trigger = screen.getByRole('combobox', { name: /Input kind for spec/ })
    fireEvent.click(trigger)
    const opt = Array.from(document.querySelectorAll('li[role="option"]')).find((li) =>
      (li.textContent ?? '').includes('markdown'),
    )
    if (opt === undefined) throw new Error('markdown option not found')
    fireEvent.mouseDown(opt)

    expect(lastPayload(onChange).inputs).toEqual([{ name: 'spec', kind: 'markdown' }])
  })

  test('toggling required surfaces inputs[].required', () => {
    const onChange = vi.fn<(next: CreateAgent) => void>()
    mount({ ...emptyAgent(), name: 'demo', inputs: [{ name: 'diff', kind: 'string' }] }, onChange)

    fireEvent.click(screen.getByLabelText('Mark diff as required'))

    expect(lastPayload(onChange).inputs).toEqual([{ name: 'diff', kind: 'string', required: true }])
  })

  test('removing a port drops it from inputs', () => {
    const onChange = vi.fn<(next: CreateAgent) => void>()
    mount({ ...emptyAgent(), name: 'demo', inputs: [{ name: 'diff', kind: 'string' }] }, onChange)

    fireEvent.click(screen.getByLabelText('Remove diff'))

    expect(lastPayload(onChange).inputs).toEqual([])
  })
})
