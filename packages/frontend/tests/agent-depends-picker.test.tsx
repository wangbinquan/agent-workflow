// RFC-022 → RFC-173 T3 — AgentDependsPicker over <MultiSelect>. Contract:
//   1. lists every existing agent in /api/agents (selected shown CHECKED, not
//      filtered out — RFC-173 §3.2)
//   2. still excludes `selfName` from the offer (self-ref save-time rejection)
//   3. toggling an option appends the picked name via onChange
//   4. load failure keeps the combobox usable (free-text)

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
  cleanup()
  vi.restoreAllMocks()
})

async function openPicker() {
  const input = (await waitFor(() => screen.getByRole('combobox'))) as HTMLInputElement
  fireEvent.focus(input)
  const list = screen.getByRole('listbox')
  await waitFor(() => within(list).getAllByRole('option'))
  return list
}

// A checked row's textContent carries a trailing '✓' from the check indicator;
// strip it so name comparisons stay exact.
function optionTexts(list: HTMLElement): string[] {
  return within(list)
    .getAllByRole('option')
    .map((o) => (o.textContent ?? '').replace(/✓/g, ''))
}

describe('AgentDependsPicker', () => {
  test('lists every agent', async () => {
    mockAgents([fakeAgent('alpha'), fakeAgent('beta'), fakeAgent('gamma')])
    wrap(<AgentDependsPicker value={[]} onChange={() => {}} />)
    const list = await openPicker()
    expect(optionTexts(list)).toEqual(expect.arrayContaining(['alpha', 'beta', 'gamma']))
  })

  test('selfName is excluded from the offer (self-ref save-time rejection)', async () => {
    mockAgents([fakeAgent('orchestrator'), fakeAgent('auditor'), fakeAgent('runner')])
    wrap(<AgentDependsPicker value={[]} onChange={() => {}} selfName="orchestrator" />)
    const list = await openPicker()
    const texts = optionTexts(list)
    expect(texts).toEqual(expect.arrayContaining(['auditor', 'runner']))
    expect(texts).not.toContain('orchestrator')
  })

  test('already-selected names stay in the dropdown, CHECKED', async () => {
    mockAgents([fakeAgent('a'), fakeAgent('b'), fakeAgent('c')])
    wrap(<AgentDependsPicker value={['b']} onChange={() => {}} />)
    const list = await openPicker()
    expect(optionTexts(list)).toEqual(expect.arrayContaining(['a', 'b', 'c']))
    const b = within(list)
      .getAllByRole('option')
      .find((o) => (o.textContent ?? '').replace(/✓/g, '') === 'b')!
    expect(b.getAttribute('aria-selected')).toBe('true')
  })

  test('toggling an option appends it via onChange', async () => {
    mockAgents([fakeAgent('a'), fakeAgent('b')])
    const onChange = vi.fn()
    wrap(<AgentDependsPicker value={['existing']} onChange={onChange} />)
    const list = await openPicker()
    fireEvent.mouseDown(within(list).getByText('b'))
    expect(onChange).toHaveBeenCalledWith(['existing', 'b'])
  })

  test('load failure keeps the combobox and surfaces the muted error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, code: 'boom' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      }),
    )
    wrap(<AgentDependsPicker value={[]} onChange={() => {}} />)
    await waitFor(() => screen.getByText(/Failed to load agent list/i))
    expect(screen.queryByRole('combobox')).toBeTruthy()
  })
})
