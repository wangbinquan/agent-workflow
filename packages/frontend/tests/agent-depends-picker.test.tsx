// RFC-022 — AgentDependsPicker. Locks the dropdown's contract:
//   1. lists every existing agent in /api/agents minus the ones already chosen
//   2. filters out `selfName` (save-time guard rejects self-references; we
//      shouldn't even offer it as an option)
//   3. selecting an option calls onChange with the picked name appended

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Agent } from '@agent-workflow/shared'
import { AgentDependsPicker } from '../src/components/AgentDependsPicker'
import { setBaseUrl, setToken } from '../src/stores/auth'

function wrap(node: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

function fakeAgent(name: string, description = ''): Agent {
  return {
    id: name,
    name,
    description,
    outputs: [],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

function mockAgents(rows: Agent[]) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(rows), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  // Unmount via testing-library first — the Select listbox is portaled to
  // document.body, so wiping innerHTML before cleanup() races React's
  // removeChild and crashes happy-dom.
  cleanup()
  vi.restoreAllMocks()
})

// The picker dropdown is the shared <Select> (RFC-036): role=combobox trigger
// + portaled role=listbox. Open it once the list query settles.
async function openPicker() {
  const trigger = (await waitFor(() => screen.getByRole('combobox'))) as HTMLButtonElement
  await waitFor(() => expect(trigger.disabled).toBe(false))
  fireEvent.click(trigger)
  return screen.getByRole('listbox')
}

function optionLabels(list: HTMLElement): string[] {
  return within(list)
    .getAllByRole('option')
    .map((o) => o.textContent ?? '')
}

describe('AgentDependsPicker', () => {
  test('lists every agent not yet selected', async () => {
    mockAgents([fakeAgent('alpha'), fakeAgent('beta'), fakeAgent('gamma')])
    wrap(<AgentDependsPicker value={[]} onChange={() => {}} />)
    const list = await openPicker()
    expect(optionLabels(list)).toEqual(['alpha', 'beta', 'gamma'])
  })

  test('selfName is filtered out of the dropdown (self-ref save-time rejection)', async () => {
    mockAgents([fakeAgent('orchestrator'), fakeAgent('auditor'), fakeAgent('runner')])
    wrap(<AgentDependsPicker value={[]} onChange={() => {}} selfName="orchestrator" />)
    const list = await openPicker()
    expect(optionLabels(list)).toEqual(['auditor', 'runner'])
  })

  test('already-selected names are filtered out (no duplicates offered)', async () => {
    mockAgents([fakeAgent('a'), fakeAgent('b'), fakeAgent('c')])
    wrap(<AgentDependsPicker value={['b']} onChange={() => {}} />)
    const list = await openPicker()
    expect(optionLabels(list)).toEqual(['a', 'c'])
  })

  test('selecting an option appends it via onChange', async () => {
    mockAgents([fakeAgent('a'), fakeAgent('b')])
    const onChange = vi.fn()
    wrap(<AgentDependsPicker value={['existing']} onChange={onChange} />)
    const list = await openPicker()
    fireEvent.mouseDown(within(list).getByText('b'))
    expect(onChange).toHaveBeenCalledWith(['existing', 'b'])
  })

  test('load failure hides dropdown and surfaces muted error message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, code: 'boom' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      }),
    )
    wrap(<AgentDependsPicker value={[]} onChange={() => {}} />)
    await waitFor(() => screen.getByText(/Failed to load agent list/i))
    expect(screen.queryByRole('combobox')).toBeNull()
  })
})
