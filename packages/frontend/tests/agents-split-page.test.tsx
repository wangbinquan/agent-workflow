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
  outputKinds?: Record<string, string>
  outputWrapperPortNames?: Record<string, string>
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

function chooseSelectOption(comboboxName: RegExp, optionName: string) {
  fireEvent.click(screen.getByRole('combobox', { name: comboboxName }))
  fireEvent.mouseDown(screen.getByRole('option', { name: optionName }))
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
    expect(screen.getAllByTestId('split-new-button')).toHaveLength(1)
    expect(screen.queryByTestId('agents-mobile-back')).toBeNull()
    expect(screen.getAllByRole('link', { name: '+ New agent' })).toHaveLength(1)
    expect(
      screen.getByTestId('split-detail').closest('.page--split')?.getAttribute('data-mobile-view'),
    ).toBe('list')
    fireEvent.click(screen.getByTestId('split-card-alpha'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents/alpha'))
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'alpha' }))
    const back = screen.getByTestId('agents-mobile-back')
    expect(back.getAttribute('href')).toBe('/agents')
    expect(screen.getAllByTestId('agents-mobile-back')).toHaveLength(1)
    expect(
      screen.getByTestId('split-detail').closest('.page--split')?.getAttribute('data-mobile-view'),
    ).toBe('detail')
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

  test('duplicate output blocks Save with one live explanation and repairs in Ports', async () => {
    agents = [{ ...makeAgent('broken'), outputs: ['result', 'result'] }]
    renderAgents('/agents/broken')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'broken' }))

    const save = screen.getByTestId('agent-save-button') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    const alert = screen.getByRole('alert', { name: /Port configuration needs attention/ })
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(alert.textContent).toContain('result')

    fireEvent.click(
      screen.getByRole('button', { name: /^Fix in Ports: Output port result is duplicated/ }),
    )
    expect(screen.getByRole('tab', { name: /Ports/ }).getAttribute('aria-selected')).toBe('true')
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: /Ports/ })),
    )

    fireEvent.click(screen.getByRole('button', { name: /^Edit output port result.*item 1/i }))
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    fireEvent.click(screen.getByTestId('agent-output-port-cancel'))

    fireEvent.click(screen.getByRole('button', { name: /^Delete output port result.*item 2/i }))
    fireEvent.click(
      screen.getByRole('button', { name: /^Confirm deletion of output port result.*item 2/i }),
    )
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(save.disabled).toBe(false)
  })

  test('opening a declared invalid kind keeps one route alert and associates a non-live field error', async () => {
    agents = [
      {
        ...makeAgent('invalid-kind'),
        outputs: ['report'],
        outputKinds: { report: 'not a kind' },
      },
    ]
    renderAgents('/agents/invalid-kind')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'invalid-kind' }))

    expect(screen.getAllByRole('alert')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: /^Fix in Ports:/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Edit output port report/ }))

    const advanced = screen.getByTestId('agent-output-port-kind-advanced-input')
    expect(advanced.getAttribute('aria-invalid')).toBe('true')
    const error = document.querySelector('.kind-select__error')
    expect(error).toBeTruthy()
    expect(advanced.getAttribute('aria-describedby')).toBe(error?.id)
    expect(screen.getAllByRole('alert')).toHaveLength(1)

    // Continuing to type an invalid local value must not create a second
    // alert while the uncommitted route draft still owns the compact one.
    fireEvent.change(advanced, { target: { value: 'still not a kind' } })
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(advanced.getAttribute('aria-invalid')).toBe('true')
  })

  test('reserved port sidecar in extra frontmatter directs repair to Advanced', async () => {
    agents = [
      {
        ...makeAgent('reserved-extra'),
        frontmatterExtra: { outputKinds: { report: 'markdown' } },
      },
    ]
    renderAgents('/agents/reserved-extra')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'reserved-extra' }))

    expect((screen.getByTestId('agent-save-button') as HTMLButtonElement).disabled).toBe(true)
    const alert = screen.getByRole('alert', { name: /Port configuration needs attention/ })
    expect(alert.textContent).toContain('outputKinds')
    fireEvent.click(screen.getByRole('button', { name: /^Fix in Advanced:/ }))
    expect(screen.getByRole('tab', { name: 'Advanced' }).getAttribute('aria-selected')).toBe('true')
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Advanced' })),
    )
  })

  test('normal retained wrapper collision stays savable; Aggregator blocks until Ports repair', async () => {
    agents = [
      {
        ...makeAgent('role-collision'),
        outputs: ['left', 'right'],
        outputWrapperPortNames: { right: 'left' },
      },
    ]
    renderAgents('/agents/role-collision')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'role-collision' }))

    const save = screen.getByTestId('agent-save-button') as HTMLButtonElement
    expect(save.disabled).toBe(false)
    expect(screen.queryByRole('alert', { name: /Port configuration needs attention/ })).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Advanced' }))
    chooseSelectOption(/^Role$/, 'Aggregator')
    await waitFor(() => expect(save.disabled).toBe(true))
    expect(screen.getByRole('alert', { name: /Port configuration needs attention/ })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /^Fix in Ports:/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Edit output port right/ }))
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    const wrapper = screen.getByTestId('agent-output-port-wrapper')
    fireEvent.change(wrapper, { target: { value: 'published_right' } })
    fireEvent.click(screen.getByTestId('agent-output-port-save'))
    await waitFor(() => expect(save.disabled).toBe(false))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  test('unique schema-readable legacy port names do not block Save', async () => {
    agents = [
      {
        ...makeAgent('legacy-ports'),
        inputs: [{ name: 'Legacy Input', kind: 'string' }],
        outputs: ['Legacy Output'],
        outputKinds: { 'Legacy Output': 'markdown' },
      },
    ]
    renderAgents('/agents/legacy-ports')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'legacy-ports' }))

    expect((screen.getByTestId('agent-save-button') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByRole('alert', { name: /Port configuration needs attention/ })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: /Ports/ }))
    expect(screen.getAllByText('legacy name')).toHaveLength(2)
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
    expect(screen.getByTestId('agents-mobile-back').getAttribute('href')).toBe('/agents')
    expect(screen.getAllByTestId('agents-mobile-back')).toHaveLength(1)
    expect(screen.getAllByTestId('split-new-button')).toHaveLength(1)
    expect(
      screen.getByTestId('split-detail').closest('.page--split')?.getAttribute('data-mobile-view'),
    ).toBe('detail')
    const name = screen.getByRole('textbox', { name: /Name/ }) as HTMLInputElement
    fireEvent.change(name, { target: { value: 'gamma' } })
    fireEvent.click(screen.getByTestId('agent-create-button'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents/gamma'))
    await waitFor(() =>
      expect(screen.getByTestId('split-card-gamma').className).toContain('is-selected'),
    )
  })

  test('imported duplicate inputs and outputs block Create until both are repaired', async () => {
    const router = renderAgents('/agents/new')
    await waitFor(() => screen.getByTestId('agent-create-button'))
    fireEvent.click(screen.getByTestId('agent-import-open'))
    fireEvent.click(screen.getByRole('tab', { name: /paste/i }))
    fireEvent.change(screen.getByTestId('agent-import-textarea'), {
      target: {
        value: [
          '---',
          'name: imported-duplicate',
          'inputs:',
          '  - name: source',
          '    kind: string',
          '  - name: source',
          '    kind: markdown',
          'outputs: [result, result]',
          '---',
        ].join('\n'),
      },
    })
    fireEvent.click(screen.getByTestId('agent-import-parse'))
    fireEvent.click(screen.getByTestId('agent-import-apply'))
    fireEvent.click(screen.getByTestId('agent-import-view-form'))

    const create = screen.getByTestId('agent-create-button') as HTMLButtonElement
    expect(create.disabled).toBe(true)
    const duplicateAlert = screen.getByRole('alert', {
      name: /Port configuration needs attention/,
    })
    expect(duplicateAlert.textContent).toContain('source')
    expect(duplicateAlert.textContent).toContain('result')
    fireEvent.click(
      screen.getByRole('button', { name: /^Fix in Ports: Output port result is duplicated/ }),
    )
    fireEvent.click(screen.getByRole('button', { name: /^Delete output port result.*item 2/i }))
    fireEvent.click(
      screen.getByRole('button', { name: /^Confirm deletion of output port result.*item 2/i }),
    )
    fireEvent.click(screen.getByRole('button', { name: /^Delete input port source.*item 2/i }))
    fireEvent.click(
      screen.getByRole('button', { name: /^Confirm deletion of input port source.*item 2/i }),
    )

    await waitFor(() => expect(create.disabled).toBe(false))
    fireEvent.click(create)
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents/imported-duplicate'))
  })

  test('outputs-only re-import cannot turn an existing orphan kind into a live mapping', async () => {
    renderAgents('/agents/new')
    await waitFor(() => screen.getByTestId('agent-create-button'))

    fireEvent.click(screen.getByTestId('agent-import-open'))
    fireEvent.click(screen.getByRole('tab', { name: /paste/i }))
    fireEvent.change(screen.getByTestId('agent-import-textarea'), {
      target: {
        value: ['---', 'name: orphan-import', 'outputKinds:', '  future: markdown', '---'].join(
          '\n',
        ),
      },
    })
    fireEvent.click(screen.getByTestId('agent-import-parse'))
    fireEvent.click(screen.getByTestId('agent-import-apply'))
    fireEvent.click(screen.getByTestId('agent-import-view-form'))

    fireEvent.click(screen.getByTestId('agent-import-open'))
    fireEvent.click(screen.getByRole('tab', { name: /paste/i }))
    fireEvent.change(screen.getByTestId('agent-import-textarea'), {
      target: { value: ['---', 'outputs: [future]', '---'].join('\n') },
    })
    fireEvent.click(screen.getByTestId('agent-import-parse'))

    expect(screen.getByTestId('agent-import-port-conflict').textContent).toContain(
      'outputKinds:future',
    )
    expect((screen.getByTestId('agent-import-apply') as HTMLButtonElement).disabled).toBe(true)
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
