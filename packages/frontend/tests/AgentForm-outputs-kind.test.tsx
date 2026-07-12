// Integration smoke: AgentForm forwards OutputsEditor's (outputs, outputKinds)
// updates as a single onChange payload so callers PUT /api/agents with the
// kind set. Locks RFC-005 design.md §line 120 wiring; if AgentForm ever
// reverts to ChipsInput-only, this test goes red before users hit prod.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { CreateAgent } from '@agent-workflow/shared'
import { AgentForm, emptyAgent } from '../src/components/AgentForm'
import { setBaseUrl, setToken } from '../src/stores/auth'

function mount(initial: CreateAgent, onChange: (next: CreateAgent) => void) {
  // SkillsPicker inside AgentForm hits useQuery → needs a client. Cache off so
  // the test doesn't depend on a network fetch resolving.
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  })
  const utils = render(
    <QueryClientProvider client={qc}>
      <AgentForm value={initial} onChange={onChange} />
    </QueryClientProvider>,
  )
  // RFC-169: the OutputsEditor lives in the Ports tab; open it so the port
  // controls are accessible (hidden panels are excluded from getByRole).
  fireEvent.click(screen.getByRole('tab', { name: /Ports/ }))
  return utils
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  // SkillsPicker fires GET /api/skills on mount. Resolve it synchronously
  // with an empty list so the QueryClient never logs a post-teardown error.
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
  )
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('AgentForm outputs kind round-trip', () => {
  test('selecting a kind on an existing port surfaces outputKinds upward', () => {
    const onChange = vi.fn<(next: CreateAgent) => void>()
    const initial: CreateAgent = { ...emptyAgent(), name: 'demo', outputs: ['report'] }
    mount(initial, onChange)

    // RFC-080 PR-B: the per-port kind editor is now the public KindSelect
    // (button[role=combobox] + portaled listbox). Other comboboxes (model /
    // role picker) live on the same form, so target the per-port aria-label.
    const trigger = screen.getByRole('combobox', { name: /Output kind for report/ })
    fireEvent.click(trigger)
    const opt = Array.from(document.querySelectorAll('li[role="option"]')).find((li) =>
      (li.textContent ?? '').includes('markdown'),
    )
    if (opt === undefined) throw new Error('markdown option not found')
    fireEvent.mouseDown(opt)

    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0]?.[0] as CreateAgent
    expect(next.outputs).toEqual(['report'])
    expect(next.outputKinds).toEqual({ report: 'markdown' })
  })
})
