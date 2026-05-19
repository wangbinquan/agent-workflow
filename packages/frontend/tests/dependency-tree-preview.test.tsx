// RFC-022: integration tests for the `<DependencyTreePreview>` embedded in
// AgentForm. The preview hits POST /api/agents/closure-preview as the user
// edits chips; this test mocks fetch and asserts:
//
//   1. ok:true response → DependencyTree renders rows for each closure member
//   2. ok:false / agent-dependency-cycle → DependencyCycleHint renders the
//      cycle path
//   3. empty dependsOn + no name → idle hint, no fetch

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { DependencyTreePreview } from '../src/components/agents/DependencyTreePreview'
import { setBaseUrl, setToken } from '../src/stores/auth'

function wrap(node: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

function mockPreview(response: unknown) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(response), {
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
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('<DependencyTreePreview>', () => {
  test('ok:true closure renders a tree row per closure member', async () => {
    mockPreview({
      ok: true,
      agents: [
        {
          name: 'orchestrator',
          description: '',
          skills: [],
          skillCount: 0,
          readonly: false,
          dependsOn: ['auditor'],
          mcp: [],
          plugins: [],
        },
        {
          name: 'auditor',
          description: '',
          skills: ['s1'],
          skillCount: 1,
          readonly: true,
          dependsOn: [],
          mcp: [],
          plugins: [],
        },
      ],
    })
    wrap(<DependencyTreePreview name="orchestrator" dependsOn={['auditor']} />)
    // 200ms debounce — waitFor handles the wait.
    await waitFor(() => screen.getByRole('treeitem', { name: 'auditor' }), { timeout: 2000 })
    expect(screen.getByRole('treeitem', { name: 'orchestrator' })).toBeDefined()
  })

  test('ok:false cycle response renders DependencyCycleHint with the path', async () => {
    mockPreview({
      ok: false,
      code: 'agent-dependency-cycle',
      details: { cyclePath: ['c', 'a', 'b', 'c'] },
    })
    wrap(<DependencyTreePreview name="c" dependsOn={['a']} />)
    await waitFor(() => screen.getByRole('alert'), { timeout: 2000 })
    const alert = screen.getByRole('alert')
    expect(alert.textContent ?? '').toContain('c → a → b → c')
  })

  test('idle state when no name and no deps — no fetch fires', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    wrap(<DependencyTreePreview name="" dependsOn={[]} />)
    // Idle hint visible immediately; sit on it for a tick to confirm no fetch.
    await new Promise((r) => setTimeout(r, 400))
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(screen.getByText(/No dependent agents declared/i)).toBeDefined()
  })
})
