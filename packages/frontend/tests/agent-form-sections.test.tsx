// RFC-169 (T7/T9) — AgentForm five-tab layout locks (replaced the RFC-155 six
// stacked FormSections). Contract:
//   1. five tabs render as a tablist: Basics / Prompt / Ports / Resources & deps
//      / Advanced; Basics is active on first render;
//   2. panels are keep-mounted (hidden, not unmounted) so a half-typed field
//      survives a tab switch; only the active panel's fields are accessible;
//   3. clicking a tab switches the active panel and reveals its fields;
//   4. the Ports / Resources tabs carry a count badge only when non-empty (the
//      RFC-155 "there's content here" affordance, now a badge not an auto-open);
//   5. agentToDraft still carries role / outputWrapperPortNames (RFC-155
//      companion bug fix — a persisted aggregator round-trips);
//   6. the raw-body fallback <details> is gone (source backstop).

import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Agent, CreateAgent } from '@agent-workflow/shared'
import { AgentForm, emptyAgent } from '../src/components/AgentForm'
import { agentToDraft } from '../src/routes/agents.detail'
import { setBaseUrl, setToken } from '../src/stores/auth'

function mount(initial: CreateAgent, onChange: (next: CreateAgent) => void = () => {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  })
  const ui = (value: CreateAgent) => (
    <QueryClientProvider client={qc}>
      <AgentForm value={value} onChange={onChange} />
    </QueryClientProvider>
  )
  const utils = render(ui(initial))
  return { ...utils, ui }
}

const TAB_NAMES = ['Basics', 'Prompt', 'Ports', 'Resources & deps', 'Advanced']

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

describe('RFC-169 — five-tab layout', () => {
  test('renders five tabs; Basics is active first', () => {
    mount(emptyAgent())
    for (const name of TAB_NAMES) {
      expect(screen.getByRole('tab', { name: new RegExp(name) })).toBeTruthy()
    }
    expect(screen.getByRole('tab', { name: 'Basics' }).getAttribute('aria-selected')).toBe('true')
    // Basics field is accessible; a Ports field (hidden panel) is not.
    expect(screen.getByRole('textbox', { name: /Name/ })).toBeTruthy()
    expect(screen.getByTestId('agent-panel-ports').hasAttribute('hidden')).toBe(true)
  })

  test('clicking a tab switches the active panel and reveals its fields', () => {
    mount(emptyAgent())
    expect(screen.getByTestId('agent-panel-advanced').hasAttribute('hidden')).toBe(true)
    fireEvent.click(screen.getByRole('tab', { name: 'Advanced' }))
    expect(screen.getByTestId('agent-panel-advanced').hasAttribute('hidden')).toBe(false)
    expect(screen.getByTestId('agent-panel-basics').hasAttribute('hidden')).toBe(true)
    // The role selector (Advanced) is now accessible.
    expect(screen.getByRole('combobox', { name: /Role/ })).toBeTruthy()
  })

  test('keep-mounted: all five panels stay in the DOM regardless of active tab', () => {
    mount(emptyAgent())
    for (const key of ['basics', 'prompt', 'ports', 'resources', 'advanced']) {
      expect(screen.getByTestId(`agent-panel-${key}`)).toBeTruthy()
    }
  })
})

describe('RFC-169 — tab count badges', () => {
  test('Ports badge counts inputs+outputs; absent when empty', () => {
    const { unmount } = mount(emptyAgent())
    expect(screen.queryByTestId('agent-tab-ports-badge')).toBeNull()
    unmount()
    mount({ ...emptyAgent(), inputs: [{ name: 'a', kind: 'string' }], outputs: ['x', 'y'] })
    expect(screen.getByTestId('agent-tab-ports-badge').textContent).toBe('3')
  })

  test('Resources badge counts skills+mcp+plugins+dependsOn; absent when empty', () => {
    const { unmount } = mount(emptyAgent())
    expect(screen.queryByTestId('agent-tab-resources-badge')).toBeNull()
    unmount()
    mount({ ...emptyAgent(), skills: ['s'], mcp: ['m'], dependsOn: ['d'] })
    expect(screen.getByTestId('agent-tab-resources-badge').textContent).toBe('3')
  })
})

describe('RFC-155 companion — agentToDraft carries aggregator fields', () => {
  const aggregator: Agent = {
    name: 'agg',
    description: '',
    outputs: ['report'],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
    role: 'aggregator',
    outputWrapperPortNames: { report: 'final' },
  } as unknown as Agent

  test('draft round-trips role + outputWrapperPortNames', () => {
    const draft = agentToDraft(aggregator)
    expect(draft.role).toBe('aggregator')
    expect(draft.outputWrapperPortNames).toEqual({ report: 'final' })
  })
})

describe('RFC-155 — source-level backstops', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'components', 'AgentForm.tsx'), 'utf8')

  test('AgentForm no longer contains the raw-body details block', () => {
    expect(src.includes('form-details')).toBe(false)
    expect(src.includes('rawBodySummary')).toBe(false)
  })
})
