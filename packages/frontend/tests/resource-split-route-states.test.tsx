// RFC-198 PR4 — rendered wiring gate for the four ResourceSplitPage routes.
// The shared component owns no-match behavior; each real route must still
// provide its contextual genuine-empty copy/icon and wire query refetch to the
// visible retry action. These assertions intentionally render the actual route
// layouts instead of source-scanning JSX props.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { Route as RootRoute } from '../src/routes/__root'
import { IndexRoute as agentsIndexRoute, Route as agentsRoute } from '../src/routes/agents'
import { IndexRoute as mcpsIndexRoute, Route as mcpsRoute } from '../src/routes/mcps'
import { IndexRoute as pluginsIndexRoute, Route as pluginsRoute } from '../src/routes/plugins'
import { IndexRoute as skillsIndexRoute, Route as skillsRoute } from '../src/routes/skills'
import '../src/i18n'

const listState = vi.hoisted(() => ({
  data: undefined as unknown[] | undefined,
  isLoading: false,
  error: null as unknown,
  owners: new Map(),
  refetch: vi.fn(),
}))

vi.mock('../src/hooks/useResourceList', () => ({
  useResourceList: () => listState,
}))

vi.mock('../src/lib/mcp-probe-query', () => ({
  useMcpProbes: () => ({ data: [] }),
}))

const routeTree = RootRoute.addChildren([
  agentsRoute.addChildren([agentsIndexRoute]),
  skillsRoute.addChildren([skillsIndexRoute]),
  mcpsRoute.addChildren([mcpsIndexRoute]),
  pluginsRoute.addChildren([pluginsIndexRoute]),
])

const CASES = [
  {
    path: '/agents',
    description: 'Define reusable roles, prompts, and ports for workflows and workgroups.',
    icon: 'agent',
    newLabel: '+ New agent',
  },
  {
    path: '/skills',
    description: 'Create or import reusable expertise, then assign it to an agent.',
    icon: 'skill',
    newLabel: '+ New skill',
  },
  {
    path: '/mcps',
    description: 'Register a local or remote MCP server so agents can use its tools.',
    icon: 'mcp',
    newLabel: '+ New MCP',
  },
  {
    path: '/plugins',
    description: 'Register an npm, local, or Git plugin, then assign it to an agent.',
    icon: 'plugin',
    newLabel: '+ New plugin',
  },
] as const

function renderList(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  render(
    <QueryClientProvider client={queryClient}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  listState.data = []
  listState.isLoading = false
  listState.error = null
  listState.owners = new Map()
  listState.refetch.mockReset()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    return new Response('not found', { status: 404 })
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('resource split route list states', () => {
  test.each(CASES)(
    '$path genuine empty has context and one persistent New action',
    async (item) => {
      renderList(item.path)

      const empty = await screen.findByTestId('split-empty')
      expect(empty.textContent).toContain(item.description)
      expect(empty.querySelector(`[data-icon="${item.icon}"]`)).not.toBeNull()
      expect(screen.getAllByRole('link', { name: item.newLabel })).toHaveLength(1)
      expect(empty.querySelector('a, button')).toBeNull()
    },
  )

  test.each(CASES)('$path initial error exposes the route query retry', async (item) => {
    listState.data = undefined
    listState.error = new Error('offline')
    renderList(item.path)

    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(listState.refetch).toHaveBeenCalledTimes(1)
  })
})
