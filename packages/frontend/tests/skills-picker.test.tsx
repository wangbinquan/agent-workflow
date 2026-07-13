// RFC-002 → RFC-173 T3 — SkillsPicker over <MultiSelect>. Selected skills are
// shown CHECKED in the dropdown (not filtered out); load failure keeps the
// combobox usable (free-text). Locks the wrapper's wiring to /api/skills.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Skill } from '@agent-workflow/shared'
import { SkillsPicker } from '../src/components/SkillsPicker'
import { setBaseUrl, setToken } from '../src/stores/auth'

function wrap(node: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

function fakeSkill(name: string, description = ''): Skill {
  return {
    id: name,
    name,
    description,
    sourceKind: 'managed',
    managedPath: `/x/${name}`,
    schemaVersion: 1,
    contentVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

function mockSkills(skills: Skill[]) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(skills), {
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

// MultiSelect: role=combobox <input> + portaled role=listbox. Focus opens it;
// wait for option rows so we don't assert against the loading placeholder.
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

describe('SkillsPicker', () => {
  test('lists all skills; none selected → none checked', async () => {
    mockSkills([fakeSkill('a'), fakeSkill('b'), fakeSkill('c')])
    wrap(<SkillsPicker value={[]} onChange={() => {}} />)
    const list = await openPicker()
    expect(optionTexts(list)).toEqual(expect.arrayContaining(['a', 'b', 'c']))
    for (const o of within(list).getAllByRole('option')) {
      expect(o.getAttribute('aria-selected')).toBe('false')
    }
  })

  test('toggling an option appends it via onChange', async () => {
    mockSkills([fakeSkill('a'), fakeSkill('b')])
    const onChange = vi.fn()
    wrap(<SkillsPicker value={['existing']} onChange={onChange} />)
    const list = await openPicker()
    fireEvent.mouseDown(within(list).getByText('b'))
    expect(onChange).toHaveBeenCalledWith(['existing', 'b'])
  })

  test('already-selected skills stay in the dropdown, CHECKED (not filtered out)', async () => {
    mockSkills([fakeSkill('a'), fakeSkill('b'), fakeSkill('c')])
    wrap(<SkillsPicker value={['b']} onChange={() => {}} />)
    const list = await openPicker()
    expect(optionTexts(list)).toEqual(expect.arrayContaining(['a', 'b', 'c']))
    const b = within(list)
      .getAllByRole('option')
      .find((o) => (o.textContent ?? '').replace(/✓/g, '') === 'b')!
    expect(b.getAttribute('aria-selected')).toBe('true')
  })

  test('empty skill list shows the empty row', async () => {
    mockSkills([])
    wrap(<SkillsPicker value={[]} onChange={() => {}} />)
    fireEvent.focus(await waitFor(() => screen.getByRole('combobox')))
    await waitFor(() => expect(screen.getByText(/No skills available/i)).toBeTruthy())
  })

  test('load failure keeps the combobox and shows the muted error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, code: 'boom' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      }),
    )
    wrap(<SkillsPicker value={[]} onChange={() => {}} />)
    await waitFor(() => screen.getByText(/Failed to load skill list/i))
    // MultiSelect stays usable (free-text) even when the list can't load.
    expect(screen.queryByRole('combobox')).toBeTruthy()
  })
})
