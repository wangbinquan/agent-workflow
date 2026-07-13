// RFC-173 (T5, AC-1/6) — the "resources & deps" tab renders TWO labelled groups
// ("Capabilities" = skills/MCP/plugins, "Dependencies" = agents + autodetect +
// tree), each field carries a distinct icon, and all six icons (2 group + 4
// type) are present and unique. Also a source-level AC-3 backstop: the picker
// no longer stacks a single <Select> over a <ChipsInput>.

import { fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { AgentForm, emptyAgent } from '../src/components/AgentForm'
import { setBaseUrl, setToken } from '../src/stores/auth'

function mount() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  })
  render(
    <QueryClientProvider client={qc}>
      <AgentForm value={emptyAgent()} onChange={() => {}} />
    </QueryClientProvider>,
  )
  // Reveal the resources panel (it's keep-mounted but hidden by default).
  fireEvent.click(screen.getByRole('tab', { name: /Resources/ }))
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

const groupOf = (title: string): HTMLElement =>
  screen.getByText(title).closest('.resource-group') as HTMLElement

describe('RFC-173 — resources tab two-group layout', () => {
  test('renders the Capabilities and Dependencies group titles', () => {
    mount()
    expect(screen.getByText('Capabilities')).toBeTruthy()
    expect(screen.getByText('Dependencies')).toBeTruthy()
  })

  test('skills / MCP / plugins live in Capabilities; depends + autodetect + tree in Dependencies', () => {
    mount()
    const cap = groupOf('Capabilities')
    expect(within(cap).getByRole('combobox', { name: 'Skills' })).toBeTruthy()
    expect(within(cap).getByRole('combobox', { name: 'MCP servers' })).toBeTruthy()
    expect(within(cap).getByRole('combobox', { name: 'Plugins' })).toBeTruthy()

    const dep = groupOf('Dependencies')
    expect(within(dep).getByRole('combobox', { name: 'Depends on agents' })).toBeTruthy()
    expect(within(dep).getByTestId('agent-dep-autodetect-button')).toBeTruthy()
    // The dependency-tree preview (empty hint for a fresh agent) is in this group.
    expect(dep.querySelector('.dep-tree__empty')).toBeTruthy()

    // Cross-check: the capabilities pickers are NOT in the dependencies group.
    expect(within(dep).queryByRole('combobox', { name: 'Skills' })).toBeNull()
  })

  test('all six resource icons render and are distinct (2 group + 4 type)', () => {
    mount()
    const icons = Array.from(document.querySelectorAll('[data-icon]')).map((el) =>
      el.getAttribute('data-icon'),
    )
    for (const name of ['cap', 'dep', 'skill', 'mcp', 'plugin', 'agent']) {
      expect(icons.filter((i) => i === name)).toHaveLength(1)
    }
  })
})

describe('RFC-173 — AC-3 source backstop', () => {
  const pickerSrc = readFileSync(
    join(__dirname, '..', 'src', 'components', 'ResourcePicker.tsx'),
    'utf8',
  )

  test('ResourcePicker renders MultiSelect, not a Select-over-ChipsInput stack', () => {
    expect(pickerSrc).toContain('MultiSelect')
    expect(pickerSrc).not.toContain("from './Select'")
    expect(pickerSrc).not.toContain("from './ChipsInput'")
  })
})
