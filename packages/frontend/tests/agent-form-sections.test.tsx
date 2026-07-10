// RFC-155 — AgentForm section layout locks.
//
// The flat form-grid became six FormSections; these tests lock the section
// contract the redesign promised:
//   1. visible sections (Basics / Prompt / Inputs & outputs / Dependency tree) render
//      as static headings; Resources & Advanced render as details, closed on
//      an empty draft;
//   2. a draft that already holds section content opens that section from the
//      first render (async /agents/$name loads land as a later value — see 3);
//   3. rising edge only: content arriving later (detail load, import merge)
//      auto-opens the section, but a same-value render never fights a manual
//      collapse;
//   4. the raw-body fallback <details> is gone (MarkdownEditor's edit pane IS
//      the raw textarea) — DOM level and source level;
//   5. agentToDraft carries role/outputWrapperPortNames so a persisted
//      aggregator opens Advanced (the RFC-155 companion bug fix).

import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Agent, CreateAgent } from '@agent-workflow/shared'
import {
  AgentForm,
  emptyAgent,
  hasAdvancedContent,
  hasResourceContent,
} from '../src/components/AgentForm'
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

function sectionEl(testid: string): HTMLDetailsElement {
  return screen.getByTestId(testid) as HTMLDetailsElement
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

describe('RFC-155 — section layout on an empty draft', () => {
  test('visible sections render; Resources & Advanced are closed details', () => {
    mount(emptyAgent())
    for (const title of [
      'Basics',
      'Prompt (body)',
      'Inputs & outputs',
      'Dependency tree (preview)',
    ]) {
      expect(screen.getByRole('heading', { level: 2, name: title })).toBeTruthy()
    }
    expect(sectionEl('agent-form-section-resources').open).toBe(false)
    expect(sectionEl('agent-form-section-advanced').open).toBe(false)
  })

  test('raw-body fallback details is gone', () => {
    mount(emptyAgent())
    expect(screen.queryByText('Raw body (no preview)')).toBeNull()
  })
})

describe('RFC-155 — auto-open on initial content', () => {
  test('skills content opens Resources from the first render', () => {
    mount({ ...emptyAgent(), skills: ['linting'] })
    expect(sectionEl('agent-form-section-resources').open).toBe(true)
    expect(sectionEl('agent-form-section-advanced').open).toBe(false)
  })

  test('permission / role / sync-off each open Advanced from the first render', () => {
    for (const patch of [
      { permission: { edit: 'deny' } },
      { role: 'aggregator' as const },
      { syncOutputsOnIterate: false },
    ]) {
      const { unmount } = mount({ ...emptyAgent(), ...patch })
      expect(sectionEl('agent-form-section-advanced').open).toBe(true)
      unmount()
    }
  })
})

describe('RFC-155 — rising-edge auto-open', () => {
  test('content arriving later opens the section; a manual collapse is not fought', () => {
    const { rerender, ui } = mount(emptyAgent())
    expect(sectionEl('agent-form-section-resources').open).toBe(false)

    // Async detail load / import merge lands as a new value → rising edge opens.
    const withMcp = { ...emptyAgent(), mcp: ['browser'] }
    rerender(ui(withMcp))
    expect(sectionEl('agent-form-section-resources').open).toBe(true)

    // Manual collapse…
    fireEvent.click(screen.getByRole('heading', { level: 2, name: 'Resources & references' }))
    expect(sectionEl('agent-form-section-resources').open).toBe(false)

    // …must survive a same-content render (no rising edge → no forced open).
    rerender(ui({ ...withMcp }))
    expect(sectionEl('agent-form-section-resources').open).toBe(false)
  })
})

describe('RFC-155 — hasResourceContent / hasAdvancedContent oracles', () => {
  test('resource oracle: any of skills/mcp/plugins/dependsOn', () => {
    expect(hasResourceContent(emptyAgent())).toBe(false)
    expect(hasResourceContent({ ...emptyAgent(), plugins: ['p'] })).toBe(true)
    expect(hasResourceContent({ ...emptyAgent(), dependsOn: ['a'] })).toBe(true)
  })

  test('advanced oracle: non-default advanced values only', () => {
    expect(hasAdvancedContent(emptyAgent())).toBe(false)
    expect(hasAdvancedContent({ ...emptyAgent(), outputWrapperPortNames: { r: 'f' } })).toBe(true)
    expect(hasAdvancedContent({ ...emptyAgent(), frontmatterExtra: { x: 1 } })).toBe(true)
    // role 'normal' and sync=true are the defaults — no content.
    expect(hasAdvancedContent({ ...emptyAgent(), role: 'normal' })).toBe(false)
  })
})

describe('RFC-155 — agentToDraft carries aggregator fields (companion bug fix)', () => {
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

  test('the loaded draft opens Advanced (the full oracle chain)', () => {
    expect(hasAdvancedContent(agentToDraft(aggregator))).toBe(true)
  })
})

describe('RFC-155 — source-level backstops', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'components', 'AgentForm.tsx'), 'utf8')

  test('AgentForm no longer contains the raw-body details block', () => {
    expect(src.includes('form-details')).toBe(false)
    expect(src.includes('rawBodySummary')).toBe(false)
  })
})
