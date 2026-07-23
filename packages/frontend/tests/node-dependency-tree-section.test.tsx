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
            {
              id: 'agent-orch',
              name: 'orch',
              description: '',
              skills: [],
              skillCount: 0,
              dependsOnIds: ['agent-leaf'],
              mcp: [],
              plugins: [],
              masked: false,
              missing: false,
            },
            {
              id: 'agent-leaf',
              name: 'leaf',
              description: '',
              skills: ['s1'],
              skillCount: 1,
              dependsOnIds: [],
              mcp: [],
              plugins: [],
              masked: false,
              missing: false,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    wrap(<NodeDependencyTreeSection agentId="agent-orch" />)
    await waitFor(() => screen.getByRole('treeitem', { name: 'leaf' }), { timeout: 2000 })
  })

  test('renders the empty-hint when the closure has no dependents', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          agents: [
            {
              id: 'agent-lonely',
              name: 'lonely',
              description: '',
              skills: [],
              skillCount: 0,
              dependsOnIds: [],
              mcp: [],
              plugins: [],
              masked: false,
              missing: false,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    wrap(<NodeDependencyTreeSection agentId="agent-lonely" />)
    await waitFor(() => screen.getByText(/No dependent agents declared/i), { timeout: 2000 })
  })

  test('consumes masked and missing as separate states without constructing a masked link', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          agents: [
            {
              id: 'agent-root',
              name: 'root',
              ownerUserId: null,
              description: '',
              skills: [],
              skillCount: 0,
              dependsOnIds: ['opaque-agent-id'],
              mcp: [],
              plugins: [],
              masked: false,
              missing: false,
            },
            {
              id: 'opaque-agent-id',
              name: 'opaque-agent-id',
              ownerUserId: null,
              description: '',
              skills: [],
              skillCount: 0,
              dependsOnIds: [],
              mcp: [],
              plugins: [],
              masked: true,
              missing: false,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    const onNodeClick = vi.fn()
    wrap(<NodeDependencyTreeSection agentId="agent-root" onNodeClick={onNodeClick} />)

    await waitFor(() => screen.getByText(/<restricted>|<无权访问>/i), { timeout: 2000 })
    expect(screen.queryByRole('button', { name: /opaque-agent-id/i })).toBeNull()
    expect(onNodeClick).not.toHaveBeenCalled()
  })
})
