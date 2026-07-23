// RFC-002 → RFC-173 T3 → RFC-223 (PR-1) — SkillsPicker over <MultiSelect>.
// RFC-223: the picker's value is a typed union (AgentSkillRef): a MANAGED ref
// (skillId, chosen from /api/skills) or a PROJECT ref (name, free-text). Managed
// options are keyed by skill id but labelled by name; free-text commits a
// project ref. Load failure keeps the combobox usable (free-text).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { AgentSkillRef, Skill } from '@agent-workflow/shared'
import { SkillsPicker, encodeSkillRef, decodeSkillToken } from '../src/components/SkillsPicker'
import { setBaseUrl, setToken } from '../src/stores/auth'

function wrap(node: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

// id is DISTINCT from name so the tests prove managed refs carry the skill id.
function fakeSkill(name: string, description = ''): Skill {
  return {
    id: `sid-${name}`,
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
const managed = (skillId: string): AgentSkillRef => ({ kind: 'managed', skillId })
const project = (name: string): AgentSkillRef => ({ kind: 'project', name })

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

async function openPicker() {
  const input = (await waitFor(() => screen.getByRole('combobox'))) as HTMLInputElement
  fireEvent.focus(input)
  const list = screen.getByRole('listbox')
  await waitFor(() => within(list).getAllByRole('option'))
  return list
}

function optionTexts(list: HTMLElement): string[] {
  return within(list)
    .getAllByRole('option')
    .map((o) => (o.textContent ?? '').replace(/✓/g, ''))
}

describe('SkillsPicker token codec', () => {
  test('managed round-trips through its id; project through its name', () => {
    expect(encodeSkillRef(managed('sid-lint'))).toBe('managed:sid-lint')
    expect(encodeSkillRef(project('local'))).toBe('project:local')
    expect(decodeSkillToken('managed:sid-lint')).toEqual(managed('sid-lint'))
    expect(decodeSkillToken('project:local')).toEqual(project('local'))
    // Un-prefixed (a raw custom commit) → project ref.
    expect(decodeSkillToken('typed-name')).toEqual(project('typed-name'))
  })
})

describe('SkillsPicker', () => {
  test('lists all skills by name; none selected → none checked', async () => {
    mockSkills([fakeSkill('a'), fakeSkill('b'), fakeSkill('c')])
    wrap(<SkillsPicker value={[]} onChange={() => {}} />)
    const list = await openPicker()
    expect(optionTexts(list)).toEqual(expect.arrayContaining(['a', 'b', 'c']))
    for (const o of within(list).getAllByRole('option')) {
      expect(o.getAttribute('aria-selected')).toBe('false')
    }
  })

  test('toggling an option appends a MANAGED ref (by skill id) via onChange', async () => {
    mockSkills([fakeSkill('a'), fakeSkill('b')])
    const onChange = vi.fn()
    wrap(<SkillsPicker value={[managed('sid-existing')]} onChange={onChange} />)
    const list = await openPicker()
    fireEvent.mouseDown(within(list).getByText('b'))
    expect(onChange).toHaveBeenCalledWith([managed('sid-existing'), managed('sid-b')])
  })

  test('already-selected managed skill stays in the dropdown, CHECKED', async () => {
    mockSkills([fakeSkill('a'), fakeSkill('b'), fakeSkill('c')])
    wrap(<SkillsPicker value={[managed('sid-b')]} onChange={() => {}} />)
    const list = await openPicker()
    const b = within(list)
      .getAllByRole('option')
      .find((o) => (o.textContent ?? '').replace(/✓/g, '') === 'b')!
    expect(b.getAttribute('aria-selected')).toBe('true')
  })

  test('a project ref renders its name as a removable tag', async () => {
    mockSkills([fakeSkill('a')])
    wrap(<SkillsPicker value={[project('repo-local')]} onChange={() => {}} />)
    await waitFor(() => screen.getByRole('combobox'))
    // The tag shows the project name, not the raw token.
    expect(screen.getByText('repo-local')).toBeTruthy()
  })

  test('free-text commits a PROJECT ref', async () => {
    mockSkills([fakeSkill('a')])
    const onChange = vi.fn()
    wrap(<SkillsPicker value={[]} onChange={onChange} />)
    const input = (await waitFor(() => screen.getByRole('combobox'))) as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'my-local-skill' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith([project('my-local-skill')])
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
    expect(screen.queryByRole('combobox')).toBeTruthy()
  })
})
