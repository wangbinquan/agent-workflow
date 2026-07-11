// RFC-168 — workgroup detail STUDIO: context-panel interaction contract
// (design §9). The sibling workgroups-pages.test.tsx keeps the RFC-164-era
// PUT-body locks (adapted to the panel); THIS file locks the panel-specific
// behaviors the redesign introduced:
//   §9.1  three-state switching: config ↔ member (same-card toggle, close
//         button, panel-scoped Esc)
//   §9.3  set-leader hidden outside leader_worker; dyn hides add-human
//   §9.4  member PUTs REGENERATE ids (backend §1.2) — save/add re-resolve the
//         selection by wire-normalized content (F4: padded alias still selects)
//   §9.5  human add flow: picker → alias auto-follow → hand-edit stops it
//   §9.6  capability summary: port chips, +n truncation, dangling-agent warn,
//         no summary on humans, agents-query failure degrades gracefully (F6)
//   §9.7/9.8  config save stays on the page; the "saved" flash never lies
//         about edits made while the PUT was in flight (F2)
//   §9.9  member PUT failure: panel error + draft kept + retry works; the
//         error resets when switching panels (F5)
//   §9.11 Esc layering: rename-dialog Esc never closes the panel (F9)
//   §9.12 dyn-mode draft with human members surfaces the mode error (F3)

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router'
import type { Workgroup } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import '../src/i18n'

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function wg(name: string, overrides: Partial<Workgroup> = {}): Workgroup {
  return {
    id: `wg_${name}`,
    name,
    description: 'audits PRs',
    instructions: '',
    mode: 'leader_worker',
    leaderMemberId: 'mem_1',
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 20,
    completionGate: false,
    members: [
      {
        id: 'mem_1',
        memberType: 'agent',
        agentName: 'coder',
        userId: null,
        displayName: 'Coder',
        roleDesc: 'writes code',
        sortOrder: 0,
      },
      {
        id: 'mem_2',
        memberType: 'human',
        agentName: null,
        userId: 'u1',
        displayName: 'Alice',
        roleDesc: 'reviews',
        sortOrder: 1,
      },
      {
        id: 'mem_3',
        memberType: 'agent',
        agentName: 'auditor',
        userId: null,
        displayName: 'Auditor',
        roleDesc: '',
        sortOrder: 2,
      },
    ],
    ownerUserId: null,
    visibility: 'public',
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 1_720_000_000_000,
    ...overrides,
  }
}

/** Agents with declared ports — feeds the capability summary/card. */
const RICH_AGENTS = [
  {
    name: 'coder',
    description: 'implements features',
    role: 'normal',
    inputs: [{ name: 'spec', kind: 'string', required: true }],
    outputs: ['code', 'notes'],
    outputKinds: { code: 'string' },
  },
  {
    name: 'auditor',
    description: 'audits diffs',
    role: 'normal',
    inputs: [
      { name: 'diff', kind: 'string' },
      { name: 'rules', kind: 'string' },
      { name: 'context', kind: 'string' },
      { name: 'history', kind: 'string' },
      { name: 'budget', kind: 'number' },
    ],
    outputs: ['report'],
    outputKinds: {},
  },
]

interface Recorded {
  calls: Array<{ url: string; method: string; body: unknown }>
}

interface FetchOpts {
  /** Override the /api/agents response ([] default RICH_AGENTS); a number is
   *  served as an HTTP status (e.g. 500 → query failure). */
  agents?: unknown[] | number
  /** Override PUT handling (sync or deferred); return null to fall through
   *  to the id-regenerating synthesizer. */
  putImpl?: (name: string, body: Record<string, unknown>) => Response | Promise<Response> | null
}

let memberIdSeq = 100

/** Mirrors the backend contract: full-replace PUT REGENERATES member ids. */
function synthesizePutRow(base: Workgroup, body: Record<string, unknown>): Workgroup {
  const members = (body.members as Array<Record<string, unknown>>).map((m, i) => ({
    id: `mem_g${memberIdSeq++}`,
    memberType: m.memberType as 'agent' | 'human',
    agentName: (m.agentName as string | undefined) ?? null,
    userId: (m.userId as string | undefined) ?? null,
    displayName: m.displayName as string,
    roleDesc: (m.roleDesc as string | undefined) ?? '',
    sortOrder: i,
  }))
  const leaderName = body.leaderDisplayName as string | undefined
  return {
    ...base,
    description: (body.description as string | undefined) ?? base.description,
    mode: (body.mode as Workgroup['mode'] | undefined) ?? base.mode,
    members,
    leaderMemberId:
      leaderName !== undefined
        ? (members.find((m) => m.displayName === leaderName)?.id ?? null)
        : null,
    updatedAt: base.updatedAt + 1,
  }
}

function installFetch(state: { workgroups: Workgroup[] } & Recorded, opts: FetchOpts = {}): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (req: RequestInfo | URL, init?: RequestInit) => {
      const url = req.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      state.calls.push({ url, method, body })
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        })

      if (url.includes('/api/agents')) {
        if (typeof opts.agents === 'number') return json({ code: 'boom' }, opts.agents)
        return json(opts.agents ?? RICH_AGENTS)
      }
      if (url.includes('/api/users/search')) {
        return json([
          { id: 'u2', username: 'bob', displayName: 'Bob Li', role: 'user', status: 'active' },
        ])
      }
      if (url.includes('/api/users/lookup')) {
        return json([
          {
            id: 'u1',
            username: 'alice',
            displayName: 'Alice Wang',
            role: 'user',
            status: 'active',
          },
        ])
      }
      const one = url.match(/\/api\/workgroups\/([^/]+)$/)
      if (one !== null) {
        const name = decodeURIComponent(one[1]!)
        const row = state.workgroups.find((w) => w.name === name)
        if (method === 'GET') {
          return row !== undefined ? json(row) : json({ code: 'workgroup-not-found' }, 404)
        }
        if (method === 'PUT') {
          const custom = opts.putImpl?.(name, body as Record<string, unknown>)
          if (custom !== null && custom !== undefined) return custom
          const fresh = synthesizePutRow(row ?? wg(name), body as Record<string, unknown>)
          const idx = state.workgroups.findIndex((w) => w.name === name)
          if (idx >= 0) state.workgroups[idx] = fresh
          return json(fresh)
        }
        if (method === 'DELETE') return new Response(null, { status: 204 })
      }
      if (url.endsWith('/api/workgroups') && method === 'GET') return json(state.workgroups)
      return json({})
    },
  )
}

async function renderPage(initialEntry: string) {
  const list = await import('../src/routes/workgroups')
  const detail = await import('../src/routes/workgroups.detail')
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/workgroups',
    component: list.Route.options.component,
  })
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/workgroups/$name',
    component: detail.Route.options.component,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([listRoute, detailRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
  return router
}

const panelEl = () => screen.getByTestId('workgroup-context-panel')

describe('panel three-state switching (§9.1)', () => {
  test('config by default → member on card click (field focused) → close / same-card toggle / Esc return to config', async () => {
    installFetch({ workgroups: [wg('squad')], calls: [] })
    await renderPage('/workgroups/squad')

    // config state: the config form renders inside the panel.
    await screen.findByTestId('workgroup-card-Coder')
    expect(within(panelEl()).getByTestId('workgroup-field-description')).toBeTruthy()

    // select a member → member editor with the alias prefilled and focused.
    fireEvent.click(screen.getByTestId('workgroup-card-open-Auditor'))
    const input = (await within(panelEl()).findByTestId(
      'workgroup-member-displayname-input',
    )) as HTMLInputElement
    expect(input.value).toBe('Auditor')
    await waitFor(() => expect(document.activeElement).toBe(input))
    // the open button reflects the expanded state (F10 aria contract)
    expect(screen.getByTestId('workgroup-card-open-Auditor').getAttribute('aria-expanded')).toBe(
      'true',
    )

    // close button → back to config, focus returns to the trigger card (F8).
    fireEvent.click(screen.getByTestId('workgroup-panel-close'))
    expect(within(panelEl()).getByTestId('workgroup-field-description')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByTestId('workgroup-card-open-Auditor'))

    // same-card toggle: select then click the same card again.
    fireEvent.click(screen.getByTestId('workgroup-card-open-Auditor'))
    await within(panelEl()).findByTestId('workgroup-member-displayname-input')
    fireEvent.click(screen.getByTestId('workgroup-card-open-Auditor'))
    expect(within(panelEl()).getByTestId('workgroup-field-description')).toBeTruthy()

    // Esc inside the panel closes it.
    fireEvent.click(screen.getByTestId('workgroup-card-open-Auditor'))
    const again = await within(panelEl()).findByTestId('workgroup-member-displayname-input')
    fireEvent.keyDown(again, { key: 'Escape' })
    expect(within(panelEl()).getByTestId('workgroup-field-description')).toBeTruthy()

    // Clicking BLANK gallery space deselects too (desktop selection grammar);
    // clicks landing on a card never do (stretched hit-area swallows them).
    fireEvent.click(screen.getByTestId('workgroup-card-open-Auditor'))
    await within(panelEl()).findByTestId('workgroup-member-displayname-input')
    fireEvent.click(document.querySelector('.workgroup-studio__main')!)
    expect(within(panelEl()).getByTestId('workgroup-field-description')).toBeTruthy()
  })

  test('rename-dialog Esc closes ONLY the dialog — the panel selection survives (§9.11, F9)', async () => {
    installFetch({ workgroups: [wg('squad')], calls: [] })
    await renderPage('/workgroups/squad')
    fireEvent.click(await screen.findByTestId('workgroup-card-open-Auditor'))
    await within(panelEl()).findByTestId('workgroup-member-displayname-input')

    fireEvent.click(screen.getByTestId('workgroup-rename-button'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // panel still shows the member editor
    expect(within(panelEl()).getByTestId('workgroup-member-displayname-input')).toBeTruthy()
  })
})

describe('mode-specific controls (§9.3)', () => {
  test('free_collab member panel offers no set-leader; dynamic_workflow hides add-human', async () => {
    installFetch({
      workgroups: [
        wg('fc', { mode: 'free_collab', leaderMemberId: null }),
        wg('dyn', {
          mode: 'dynamic_workflow',
          leaderMemberId: null,
          members: [
            {
              id: 'mem_1',
              memberType: 'agent',
              agentName: 'coder',
              userId: null,
              displayName: 'Coder',
              roleDesc: '',
              sortOrder: 0,
            },
          ],
        }),
      ],
      calls: [],
    })
    await renderPage('/workgroups/fc')
    fireEvent.click(await screen.findByTestId('workgroup-card-open-Auditor'))
    await within(panelEl()).findByTestId('workgroup-member-displayname-input')
    expect(within(panelEl()).queryByTestId('workgroup-set-leader-Auditor')).toBeNull()

    cleanup()
    document.body.innerHTML = ''
    await renderPage('/workgroups/dyn')
    await screen.findByTestId('workgroup-card-Coder')
    expect(screen.getByTestId('workgroup-add-agent-member')).toBeTruthy()
    expect(screen.queryByTestId('workgroup-add-human-member')).toBeNull()
  })
})

describe('selection survives id-regenerating PUTs (§9.4, F4)', () => {
  test('member-save keeps the member selected even though the PUT regenerated every id', async () => {
    const state = { workgroups: [wg('squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    await renderPage('/workgroups/squad')
    fireEvent.click(await screen.findByTestId('workgroup-card-open-Auditor'))
    const input = (await within(panelEl()).findByTestId(
      'workgroup-member-displayname-input',
    )) as HTMLInputElement
    fireEvent.change(input, { target: { value: '审计员' } })
    fireEvent.click(within(panelEl()).getByTestId('workgroup-member-save'))
    // Panel stays a member editor for the renamed member (fresh id resolved
    // by content), never collapsing back to config.
    await waitFor(() => {
      expect(
        (within(panelEl()).getByTestId('workgroup-member-displayname-input') as HTMLInputElement)
          .value,
      ).toBe('审计员')
    })
    expect(screen.getByTestId('workgroup-card-open-审计员').getAttribute('aria-expanded')).toBe(
      'true',
    )
  })

  test('add keeps the NEW member selected — a padded alias is matched by its trimmed wire form', async () => {
    const state = { workgroups: [wg('squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    await renderPage('/workgroups/squad')
    fireEvent.click(await screen.findByTestId('workgroup-add-agent-member'))
    await screen.findByTestId('workgroup-panel-add')
    fireEvent.change(screen.getByTestId('workgroup-agent-name-input'), {
      target: { value: 'reviewer' },
    })
    // hand-edit the alias to a PADDED value — trim()s pass validation and the
    // wire sends the trimmed form (F4).
    fireEvent.change(screen.getByTestId('workgroup-member-displayname-input'), {
      target: { value: ' rev ' },
    })
    fireEvent.click(screen.getByTestId('workgroup-add-agent-confirm'))
    await waitFor(() => {
      // panel switched to the new member's editor (trimmed alias)
      expect(
        (within(panelEl()).getByTestId('workgroup-member-displayname-input') as HTMLInputElement)
          .value,
      ).toBe('rev')
    })
    expect(screen.getByTestId('workgroup-card-open-rev').getAttribute('aria-expanded')).toBe('true')
  })
})

describe('human add flow (§9.5)', () => {
  test('picker → alias auto-follows the picked user → hand-edit stops following → PUT body', async () => {
    const state = { workgroups: [wg('squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    await renderPage('/workgroups/squad')
    fireEvent.click(await screen.findByTestId('workgroup-add-human-member'))
    await screen.findByTestId('workgroup-panel-add')

    fireEvent.focus(screen.getByTestId('workgroup-member-user-input'))
    fireEvent.click(await screen.findByTestId('workgroup-member-user-option-bob'))
    // alias auto-followed the picked user's display name (sanitized)
    const alias = screen.getByTestId('workgroup-member-displayname-input') as HTMLInputElement
    expect(alias.value).toBe('BobLi')
    // hand-edit stops the follow
    fireEvent.change(alias, { target: { value: 'Bobby' } })
    fireEvent.change(screen.getByTestId('workgroup-member-role-input'), {
      target: { value: 'PM' },
    })
    fireEvent.click(screen.getByTestId('workgroup-add-human-confirm'))
    await waitFor(() => {
      const put = state.calls.find((c) => c.method === 'PUT')
      expect(put).toBeTruthy()
      const members = (put?.body as { members: Array<Record<string, unknown>> }).members
      expect(members[members.length - 1]).toEqual({
        memberType: 'human',
        userId: 'u2',
        displayName: 'Bobby',
        roleDesc: 'PM',
      })
    })
  })
})

describe('capability summary (§9.6, F6)', () => {
  test('agent cards render port chips with +n truncation; humans get none; the panel shows the full card + edit link', async () => {
    installFetch({ workgroups: [wg('squad')], calls: [] })
    await renderPage('/workgroups/squad')
    const coder = await screen.findByTestId('workgroup-card-Coder')
    await waitFor(() => {
      expect(within(coder).getByText('spec')).toBeTruthy()
      expect(within(coder).getByText('code')).toBeTruthy()
    })
    // auditor declares 5 inputs → 3 shown + "+2"
    const auditor = screen.getByTestId('workgroup-card-Auditor')
    expect(within(auditor).getByText('+2')).toBeTruthy()
    // human card carries no ports row
    const alice = screen.getByTestId('workgroup-card-Alice')
    expect(within(alice).queryByText('spec')).toBeNull()
    expect(alice.querySelector('.workgroup-card__ports')).toBeNull()
    // member-type tinting mirrors the canvas palette (user 2026-07-11):
    // agent cards ↔ canvas-node--agent accent, human cards ↔ the amber
    // human-in-the-loop family.
    expect(coder.classList.contains('workgroup-card--agent')).toBe(true)
    expect(alice.classList.contains('workgroup-card--human')).toBe(true)

    // panel: full capability card + the edit-agent-definition jump link
    fireEvent.click(screen.getByTestId('workgroup-card-open-Coder'))
    await within(panelEl()).findByTestId('capability-card-coder')
    const link = within(panelEl()).getByTestId('workgroup-edit-agent-link')
    expect(link.getAttribute('href')).toBe('/agents/coder')
  })

  test('a dangling agent reference warns on the card; an agents-query failure degrades to no summary (F6)', async () => {
    installFetch({
      workgroups: [
        wg('squad', {
          leaderMemberId: null,
          members: [
            {
              id: 'mem_9',
              memberType: 'agent',
              agentName: 'ghost',
              userId: null,
              displayName: 'Ghost',
              roleDesc: '',
              sortOrder: 0,
            },
          ],
        }),
      ],
      calls: [],
    })
    await renderPage('/workgroups/squad')
    const card = await screen.findByTestId('workgroup-card-Ghost')
    await waitFor(() =>
      expect(within(card).getByTestId('workgroup-card-agent-missing')).toBeTruthy(),
    )

    cleanup()
    document.body.innerHTML = ''
    installFetch({ workgroups: [wg('squad')], calls: [] }, { agents: 500 })
    await renderPage('/workgroups/squad')
    const coder = await screen.findByTestId('workgroup-card-Coder')
    // degraded: no warn chip, no ports — but the member editor still works
    expect(within(coder).queryByTestId('workgroup-card-agent-missing')).toBeNull()
    expect(coder.querySelector('.workgroup-card__ports')).toBeNull()
    fireEvent.click(screen.getByTestId('workgroup-card-open-Coder'))
    await within(panelEl()).findByTestId('workgroup-member-displayname-input')
  })

  test('a MALFORMED /api/agents payload (non-array object) never crashes the page (useAgentsList shield)', async () => {
    // Regression: the gallery consumed `agentsQ.data.map` directly and an
    // object payload (e.g. a fall-through `{}` stub or a proxy error body)
    // crashed the whole route — caught via workgroup-launch-page.test.tsx.
    installFetch(
      { workgroups: [wg('squad')], calls: [] },
      { agents: { unexpected: 'shape' } as unknown as unknown[] },
    )
    await renderPage('/workgroups/squad')
    // The page renders (no error boundary), cards degrade to no summary and
    // no dangling-agent warning (the list never "loaded" as an array).
    const coder = await screen.findByTestId('workgroup-card-Coder')
    expect(within(coder).queryByTestId('workgroup-card-agent-missing')).toBeNull()
    expect(coder.querySelector('.workgroup-card__ports')).toBeNull()
  })
})

describe('config save stays on the page; the saved flash never lies (§9.7/9.8, F2)', () => {
  test('save keeps the route; the button flashes Saved and an edit clears it immediately', async () => {
    const state = { workgroups: [wg('squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    const router = await renderPage('/workgroups/squad')
    await waitFor(() => {
      expect((screen.getByTestId('workgroup-field-description') as HTMLInputElement).value).toBe(
        'audits PRs',
      )
    })
    fireEvent.change(screen.getByTestId('workgroup-field-description'), {
      target: { value: 'v2' },
    })
    fireEvent.click(screen.getByTestId('workgroup-save-button'))
    await waitFor(() => {
      expect(screen.getByTestId('workgroup-save-button').textContent).toBe('Saved')
    })
    expect(router.state.location.pathname).toBe('/workgroups/squad') // §9.7 — no navigate-away
    // any edit clears the flash immediately
    fireEvent.change(screen.getByTestId('workgroup-field-description'), {
      target: { value: 'v3' },
    })
    expect(screen.getByTestId('workgroup-save-button').textContent).toBe('Save')
  })

  test('editing while the PUT is in flight suppresses the Saved flash (F2)', async () => {
    const state = { workgroups: [wg('squad')], calls: [] as Recorded['calls'] }
    let releasePut: ((r: Response) => void) | null = null
    installFetch(state, {
      // Deferred PUT — the test releases it manually mid-flight.
      putImpl: () =>
        new Promise<Response>((resolve) => {
          releasePut = resolve
        }),
    })

    await renderPage('/workgroups/squad')
    await waitFor(() => {
      expect((screen.getByTestId('workgroup-field-description') as HTMLInputElement).value).toBe(
        'audits PRs',
      )
    })
    fireEvent.change(screen.getByTestId('workgroup-field-description'), {
      target: { value: 'v2' },
    })
    fireEvent.click(screen.getByTestId('workgroup-save-button'))
    await waitFor(() => expect(releasePut).not.toBeNull())
    // edit WHILE the PUT is pending
    fireEvent.change(screen.getByTestId('workgroup-field-description'), {
      target: { value: 'v3-during-flight' },
    })
    releasePut!(
      new Response(JSON.stringify(wg('squad', { description: 'v2' })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    // The flash must NOT appear — the on-screen draft (v3) was never saved.
    await waitFor(() => {
      const label = screen.getByTestId('workgroup-save-button').textContent
      expect(label).toBe('Save')
    })
  })
})

describe('member PUT failure keeps the draft and resets on panel switch (§9.9, F5)', () => {
  test('409 → panel error + draft kept → retry succeeds; switching members clears the error', async () => {
    const state = { workgroups: [wg('squad')], calls: [] as Recorded['calls'] }
    let failNext = true
    installFetch(state, {
      putImpl: () => {
        if (failNext) {
          failNext = false
          return new Response(JSON.stringify({ code: 'conflict', message: 'concurrent edit' }), {
            status: 409,
            headers: { 'content-type': 'application/json' },
          })
        }
        return null // fall through to the synthesizer
      },
    })
    await renderPage('/workgroups/squad')
    fireEvent.click(await screen.findByTestId('workgroup-card-open-Auditor'))
    const input = (await within(panelEl()).findByTestId(
      'workgroup-member-displayname-input',
    )) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Auditrix' } })
    fireEvent.click(within(panelEl()).getByTestId('workgroup-member-save'))

    // failure: error line in the panel, draft preserved
    await within(panelEl()).findByTestId('workgroup-panel-error')
    expect(
      (within(panelEl()).getByTestId('workgroup-member-displayname-input') as HTMLInputElement)
        .value,
    ).toBe('Auditrix')

    // switching to another member resets the error (F5 ownership)
    fireEvent.click(screen.getByTestId('workgroup-card-open-Coder'))
    await waitFor(() => expect(within(panelEl()).queryByTestId('workgroup-panel-error')).toBeNull())

    // back to the member; retry now succeeds and the selection survives
    fireEvent.click(screen.getByTestId('workgroup-card-open-Auditor'))
    const again = (await within(panelEl()).findByTestId(
      'workgroup-member-displayname-input',
    )) as HTMLInputElement
    fireEvent.change(again, { target: { value: 'Auditrix' } })
    fireEvent.click(within(panelEl()).getByTestId('workgroup-member-save'))
    await waitFor(() => {
      expect(screen.getByTestId('workgroup-card-open-Auditrix')).toBeTruthy()
    })
  })
})

describe('mode-transition error (§9.12, F3)', () => {
  test('switching the draft to dynamic_workflow with human members surfaces the mode error and disables Save', async () => {
    installFetch({ workgroups: [wg('squad')], calls: [] })
    await renderPage('/workgroups/squad')
    await waitFor(() => {
      expect((screen.getByTestId('workgroup-field-description') as HTMLInputElement).value).toBe(
        'audits PRs',
      )
    })
    fireEvent.click(screen.getByTestId('workgroup-mode-dynamic_workflow'))
    expect(
      screen.getByText(
        'Dynamic-workflow groups allow agent members only — remove the human members before saving.',
      ),
    ).toBeTruthy()
    expect((screen.getByTestId('workgroup-save-button') as HTMLButtonElement).disabled).toBe(true)
    // switching back clears it
    fireEvent.click(screen.getByTestId('workgroup-mode-leader_worker'))
    expect(
      screen.queryByText(
        'Dynamic-workflow groups allow agent members only — remove the human members before saving.',
      ),
    ).toBeNull()
    expect((screen.getByTestId('workgroup-save-button') as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('Codex impl-gate P1/P2 — lost-update and draft-loss guards', () => {
  test('P1: while a member PUT is in flight the panel is FROZEN (no switch, no second write)', async () => {
    const state = { workgroups: [wg('squad')], calls: [] as Recorded['calls'] }
    let releasePut: ((r: Response) => void) | null = null
    installFetch(state, {
      putImpl: () =>
        new Promise<Response>((resolve) => {
          releasePut = resolve
        }),
    })
    await renderPage('/workgroups/squad')
    fireEvent.click(await screen.findByTestId('workgroup-card-open-Auditor'))
    const input = (await within(panelEl()).findByTestId(
      'workgroup-member-displayname-input',
    )) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Auditrix' } })
    fireEvent.click(within(panelEl()).getByTestId('workgroup-member-save'))
    await waitFor(() => expect(releasePut).not.toBeNull())

    // Mid-flight: clicking another card must NOT switch the panel (reset()
    // would clear isPending and re-arm a second concurrent full-replace).
    fireEvent.click(screen.getByTestId('workgroup-card-open-Coder'))
    expect(
      (within(panelEl()).getByTestId('workgroup-member-displayname-input') as HTMLInputElement)
        .value,
    ).toBe('Auditrix')

    const lastPut = state.calls.filter((c) => c.method === 'PUT').at(-1)
    const freshRow = synthesizePutRow(wg('squad'), lastPut!.body as Record<string, unknown>)
    // Write the synthesized row back so the invalidation refetch agrees with
    // the PUT response (the auto-synthesizer path does this itself).
    state.workgroups[0] = freshRow
    releasePut!(
      new Response(JSON.stringify(freshRow), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    // Settled: the rename survives and switching works again.
    await waitFor(() => expect(screen.getByTestId('workgroup-card-open-Auditrix')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workgroup-card-open-Coder'))
    await waitFor(() => {
      expect(
        (within(panelEl()).getByTestId('workgroup-member-displayname-input') as HTMLInputElement)
          .value,
      ).toBe('Coder')
    })
  })

  test('P1: a header config save keeps the open member editor AND its unsaved draft (id churn re-resolved)', async () => {
    const state = { workgroups: [wg('squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    await renderPage('/workgroups/squad')
    // edit the config draft FIRST (the config form yields the panel to the
    // member editor on selection, but the pending draft keeps its edits)…
    await waitFor(() => {
      expect((screen.getByTestId('workgroup-field-description') as HTMLInputElement).value).toBe(
        'audits PRs',
      )
    })
    fireEvent.change(screen.getByTestId('workgroup-field-description'), {
      target: { value: 'v2' },
    })
    // …then open a member editor and edit WITHOUT saving
    fireEvent.click(screen.getByTestId('workgroup-card-open-Auditor'))
    const input = (await within(panelEl()).findByTestId(
      'workgroup-member-displayname-input',
    )) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'DraftName' } })

    // header Save fires the config channel; the synthesized PUT response
    // regenerates every member id
    fireEvent.click(screen.getByTestId('workgroup-save-button'))
    await waitFor(() => {
      expect(state.calls.some((c) => c.method === 'PUT')).toBe(true)
    })
    // The member editor survived (no collapse to config) and the unsaved
    // draft is intact (content-keyed body never remounted).
    await waitFor(() => {
      expect(
        (within(panelEl()).getByTestId('workgroup-member-displayname-input') as HTMLInputElement)
          .value,
      ).toBe('DraftName')
    })
  })

  test('P2: set-leader does not clobber a dirty alias draft (content-keyed body survives id churn)', async () => {
    const state = { workgroups: [wg('squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    await renderPage('/workgroups/squad')
    fireEvent.click(await screen.findByTestId('workgroup-card-open-Auditor'))
    const input = (await within(panelEl()).findByTestId(
      'workgroup-member-displayname-input',
    )) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'DirtyAlias' } })

    fireEvent.click(within(panelEl()).getByTestId('workgroup-set-leader-Auditor'))
    await waitFor(() => {
      const put = state.calls.find((c) => c.method === 'PUT')
      // The wire carries the SERVER alias (unsaved edits are not submitted)…
      expect((put?.body as Record<string, unknown>).leaderDisplayName).toBe('Auditor')
    })
    // …and the dirty draft is still on screen for the user to save later.
    await waitFor(() => {
      expect(within(panelEl()).getByTestId('workgroup-leader-badge')).toBeTruthy()
    })
    expect(
      (within(panelEl()).getByTestId('workgroup-member-displayname-input') as HTMLInputElement)
        .value,
    ).toBe('DirtyAlias')
  })
})

describe('remove hands focus to the neighbor card (§9.3, F8)', () => {
  test('removing the selected member returns to config and focuses the next card', async () => {
    const state = { workgroups: [wg('squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    await renderPage('/workgroups/squad')
    fireEvent.click(await screen.findByTestId('workgroup-card-open-Alice'))
    const panel = panelEl()
    const remove = await within(panel).findByRole('button', { name: 'Remove' })
    fireEvent.click(remove)
    fireEvent.click(within(panel).getByRole('button', { name: 'Confirm?' }))
    await waitFor(() => {
      expect(within(panelEl()).getByTestId('workgroup-field-description')).toBeTruthy()
    })
    // Alice was index 1 → the (new) index-1 member is Auditor.
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('workgroup-card-open-Auditor'))
    })
  })
})
