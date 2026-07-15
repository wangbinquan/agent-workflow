// RFC-169 (T9) — the /agents split page end-to-end (real routes + mocked API):
//   - /agents shows the empty pane; a card click opens the detail form;
//   - editing marks the card dirty; Save stays in place, clears the dot, and
//     refreshes the card subtitle (no navigate — D2);
//   - switching agents via a card click remounts the detail (remountDeps) so the
//     new agent's data shows, not the previous draft (T-D11, also fixes a latent
//     cross-agent bug);
//   - creating a new agent navigates to it and selects its card.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { Route as RootRoute } from '../src/routes/__root'
import { IndexRoute as agentsIndexRoute, Route as agentsRoute } from '../src/routes/agents'
import { Route as agentDetailRoute } from '../src/routes/agents.detail'
import { Route as agentNewRoute } from '../src/routes/agents.new'
import '../src/i18n'

interface AgentRow {
  id: string
  name: string
  description: string
  outputs: string[]
  syncOutputsOnIterate: boolean
  permission: Record<string, unknown>
  skills: string[]
  dependsOn: string[]
  mcp: string[]
  plugins: string[]
  frontmatterExtra: Record<string, unknown>
  bodyMd: string
  visibility: 'public' | 'private'
  ownerUserId: string | null
  inputs: unknown[]
  runtime?: string | null
  role?: 'worker' | 'aggregator'
  builtin?: boolean
}

function makeAgent(name: string, description = ''): AgentRow {
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
    visibility: 'public',
    ownerUserId: null,
    inputs: [],
  }
}

let agents: AgentRow[]

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function installFetch(opts: { failList?: boolean; ownerName?: string } = {}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : null
      const path = url.replace(/^https?:\/\/[^/]+/, '')

      if (method === 'GET' && path.endsWith('/api/agents'))
        return opts.failList ? json({ error: 'boom' }, 500) : json(agents)
      if (method === 'GET' && path.includes('/api/agents/')) {
        const name = decodeURIComponent(path.split('/api/agents/')[1]!.split('?')[0]!)
        const a = agents.find((x) => x.name === name)
        return a ? json(a) : json({ error: 'not found' }, 404)
      }
      if (method === 'PUT' && path.includes('/api/agents/')) {
        const name = decodeURIComponent(path.split('/api/agents/')[1]!.split('?')[0]!)
        const i = agents.findIndex((x) => x.name === name)
        if (i < 0) return json({ error: 'not found' }, 404)
        agents[i] = { ...agents[i]!, ...(body as object) }
        return json(agents[i])
      }
      if (method === 'POST' && path.endsWith('/api/agents')) {
        const created = makeAgent(
          (body as { name: string }).name,
          (body as AgentRow).description ?? '',
        )
        agents.push(created)
        return json(created)
      }
      if (method === 'DELETE' && path.includes('/api/agents/')) {
        const name = decodeURIComponent(path.split('/api/agents/')[1]!.split('?')[0]!)
        agents = agents.filter((x) => x.name !== name)
        return json({ ok: true })
      }
      if (method === 'GET' && path.endsWith('/api/runtimes'))
        return json({
          runtimes: [{ name: 'opencode', protocol: 'opencode', enabled: true, isDefault: true }],
        })
      if (method === 'GET' && path.endsWith('/api/config'))
        return json({ defaultRuntime: 'opencode' })
      if (method === 'POST' && path.endsWith('/api/users/lookup'))
        return json(
          opts.ownerName === undefined
            ? []
            : [
                {
                  id: 'owner-1',
                  username: 'owner',
                  displayName: opts.ownerName,
                  role: 'user',
                  status: 'active',
                },
              ],
        )
      if (method === 'GET' && /\/api\/(skills|mcps|plugins)/.test(path)) return json([])
      return json({ error: 'unhandled' }, 404)
    },
  )
}

function renderAgents(initial: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tree = RootRoute.addChildren([
    agentsRoute.addChildren([agentNewRoute, agentDetailRoute, agentsIndexRoute]),
  ])
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: [initial] }),
  })
  render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
  return router
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  agents = [makeAgent('alpha', 'first'), makeAgent('beta', 'second')]
  installFetch()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('/agents split page', () => {
  test('empty pane at /agents; card click opens the detail form', async () => {
    const router = renderAgents('/agents')
    const alphaCard = await waitFor(() => screen.getByTestId('split-card-alpha'))
    expect(alphaCard.querySelector('[data-icon="agent"]')).not.toBeNull()
    expect(alphaCard.querySelector('.split-card__kind')).toBeNull()
    expect(screen.getByTestId('agent-runtime-alpha').textContent).toBe('opencode · default')
    expect(alphaCard.querySelectorAll('.agent-card__facts')).toHaveLength(1)
    expect(alphaCard.querySelectorAll('.status-chip--neutral')).toHaveLength(0)
    expect(alphaCard.querySelector('.split-card__updated')).toBeNull()
    fireEvent.change(screen.getByTestId('split-search'), { target: { value: 'opencode' } })
    expect(screen.getByTestId('split-card-alpha')).toBeTruthy()
    expect(screen.getByText('Nothing selected')).toBeTruthy()
    fireEvent.click(screen.getByTestId('split-card-alpha'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents/alpha'))
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'alpha' }))
    expect((screen.getByRole('textbox', { name: /Name/ }) as HTMLInputElement).value).toBe('alpha')
  })

  test('dense agent metadata stays in one quiet wrapping footer with long values titled', async () => {
    const runtimeName = `runtime-${'x'.repeat(80)}`
    const ownerName = `Owner ${'y'.repeat(122)}`
    agents = [
      {
        ...makeAgent('synthesizer', 'merges worker output'),
        runtime: runtimeName,
        role: 'aggregator',
        visibility: 'private',
        ownerUserId: 'owner-1',
        builtin: true,
        inputs: [{}],
        outputs: ['answer'],
      },
    ]
    vi.restoreAllMocks()
    installFetch({ ownerName })

    renderAgents('/agents')
    const card = await screen.findByTestId('split-card-synthesizer')
    await waitFor(() => expect(card.textContent).toContain(ownerName))

    expect(card.querySelectorAll('.agent-card__facts')).toHaveLength(1)
    expect(card.querySelector('.agent-card__capabilities')).toBeNull()
    expect(card.querySelector('.agent-card__access')).toBeNull()
    expect(screen.getByTestId('agent-runtime-synthesizer').getAttribute('title')).toBe(runtimeName)
    expect(card.querySelector('.agent-card__owner')?.getAttribute('title')).toContain(ownerName)
    expect(card.textContent).toContain('1 in · 1 out')
    expect(card.textContent?.toLowerCase()).toContain('aggregator')
    expect(card.textContent?.toLowerCase()).toContain('private')
    expect(card.textContent).toContain('built-in')
    expect(card.querySelector('.split-card__updated')).toBeNull()
  })

  test('edit → dirty dot; Save stays in place, clears dot, refreshes subtitle', async () => {
    const router = renderAgents('/agents/alpha')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'alpha' }))
    const desc = screen.getByRole('textbox', { name: /Description/ }) as HTMLInputElement
    fireEvent.change(desc, { target: { value: 'edited-desc' } })
    await waitFor(() => expect(screen.queryByTestId('split-card-dot-alpha')).not.toBeNull())

    fireEvent.click(screen.getByTestId('agent-save-button'))
    await waitFor(() => expect(screen.queryByTestId('split-card-dot-alpha')).toBeNull())
    // stayed in place (no navigate to /agents)
    expect(router.state.location.pathname).toBe('/agents/alpha')
    // card subtitle refreshed from the eager patch
    await waitFor(() =>
      expect(screen.getByTestId('split-card-alpha').textContent).toContain('edited-desc'),
    )
  })

  test('switching agents via a card click remounts the detail (T-D11)', async () => {
    const router = renderAgents('/agents/alpha')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'alpha' }))
    // clean draft → no guard; clicking beta shows beta, not alpha's stale draft
    fireEvent.click(screen.getByTestId('split-card-beta'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents/beta'))
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'beta' }))
    expect((screen.getByRole('textbox', { name: /Name/ }) as HTMLInputElement).value).toBe('beta')
  })

  test('creating a new agent navigates to it and selects its card', async () => {
    const router = renderAgents('/agents/new')
    await waitFor(() => screen.getByTestId('agent-create-button'))
    const name = screen.getByRole('textbox', { name: /Name/ }) as HTMLInputElement
    fireEvent.change(name, { target: { value: 'gamma' } })
    fireEvent.click(screen.getByTestId('agent-create-button'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents/gamma'))
    await waitFor(() =>
      expect(screen.getByTestId('split-card-gamma').className).toContain('is-selected'),
    )
  })

  test('deleting an agent navigates to the empty pane and removes its card', async () => {
    const router = renderAgents('/agents/alpha')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'alpha' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' })) // arm ConfirmButton
    fireEvent.click(screen.getByRole('button', { name: 'Confirm?' })) // confirm
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents'))
    await waitFor(() => expect(screen.queryByTestId('split-card-alpha')).toBeNull())
    expect(screen.getByText('Nothing selected')).toBeTruthy()
  })

  test('save succeeds when the collection cache is empty (deep-link, list failed) — matrix ⑰', async () => {
    vi.restoreAllMocks()
    installFetch({ failList: true })
    const router = renderAgents('/agents/alpha')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'alpha' }))
    const desc = screen.getByRole('textbox', { name: /Description/ }) as HTMLInputElement
    fireEvent.change(desc, { target: { value: 'edited-with-no-list' } })
    await waitFor(() => expect(screen.queryByTestId('split-card-dot-alpha')).toBeNull()) // no card exists
    fireEvent.click(screen.getByTestId('agent-save-button'))
    // The null-safe collection updater must not throw → the save still clears
    // dirty and stays in place.
    await waitFor(() =>
      expect((screen.getByRole('textbox', { name: /Name/ }) as HTMLInputElement).value).toBe(
        'alpha',
      ),
    )
    expect(router.state.location.pathname).toBe('/agents/alpha')
    // agent actually persisted server-side
    expect(agents.find((a) => a.name === 'alpha')?.description).toBe('edited-with-no-list')
  })
})
