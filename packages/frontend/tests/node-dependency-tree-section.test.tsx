// RFC-022: `<NodeDependencyTreeSection>` is the read-only twin rendered in
// the node-detail drawer's Stats tab. Sanity-test the happy path (closure
// fetch → tree renders) and the empty-closure short-circuit (no tree, hint
// instead — saves a paint pass when an agent has no dependsOn).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { NodeDependencyTreeSection } from '../src/components/agents/NodeDependencyTreeSection'
import { setBaseUrl, setToken } from '../src/stores/auth'

function wrap(node: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('<NodeDependencyTreeSection>', () => {
  test('renders the closure tree when /closure resolves with dependents', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          agents: [
            { name: 'orch', description: '', skillCount: 0, readonly: false, dependsOn: ['leaf'] },
            { name: 'leaf', description: '', skillCount: 1, readonly: true, dependsOn: [] },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    wrap(<NodeDependencyTreeSection agentName="orch" />)
    await waitFor(() => screen.getByRole('treeitem', { name: 'leaf' }), { timeout: 2000 })
  })

  test('renders the empty-hint when the closure has no dependents', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          agents: [
            { name: 'lonely', description: '', skillCount: 0, readonly: false, dependsOn: [] },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    wrap(<NodeDependencyTreeSection agentName="lonely" />)
    await waitFor(() => screen.getByText(/No dependent agents declared/i), { timeout: 2000 })
  })
})
