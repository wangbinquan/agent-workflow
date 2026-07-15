// RFC-164 PR-1 → RFC-168 — /workgroups {list, detail} route pages + wiring
// locks.
//
// Locks:
//   1. List page: empty state, row rendering (name link / mode chip / leader
//      displayName with fc em dash), delete via the shared <Dialog> confirm.
//   2. Quick create: the "+ New workgroup" button opens a name+description
//      dialog; Create stays disabled while the name is invalid and POSTs
//      EXACTLY {name, description} (backend defaults the rest), then
//      navigates to the detail page.
//   3. Detail page: launch-readiness banner renders per reason
//      ('no-agent-member' / 'leader-missing') and hides when ready; the config
//      save PUTs the draft with the CURRENT members AND server description
//      passed through (description left the config form 2026-07-13);
//      leaderless lw groups still save (决策 #21); the rename dialog edits
//      name + description together and POSTs {newName, description} to /rename.
//   4. Member gallery + context panel (RFC-168): one card per member, leader
//      badge; selecting a card opens the member editor in the PANEL (no
//      dialogs) — set-leader / remove / member-save / add-agent flows each
//      fire a full-document PUT identical to the RFC-164 dialog-era bodies.
//      (Panel-specific behaviors — focus, Esc, saved-flash, failure paths —
//      live in workgroup-studio-panel.test.tsx.)
//   5. Wiring: router registers list + detail only (no /new route), nav
//      lists /workgroups in the workflows group, zh/en bundles carry the
//      RFC-164/168 keys (and dropped the dialog-era memberEdit /
//      editMemberTitle keys).

import { readFileSync } from 'node:fs'
import path, { resolve } from 'node:path'
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
import { zhCN } from '../src/i18n/zh-CN'
import { enUS } from '../src/i18n/en-US'
import '../src/i18n'

const TEST_DIR = path.dirname(new URL(import.meta.url).pathname)
const FRONTEND_SRC = resolve(TEST_DIR, '..', 'src')

function readSrc(rel: string): string {
  return readFileSync(resolve(FRONTEND_SRC, rel), 'utf-8')
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  // Unmount React BEFORE clearing the body: an open <Dialog> portals into
  // document.body, and blowing the DOM away first makes React's portal
  // removal throw (happy-dom removeChild DOMException).
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

interface Recorded {
  calls: Array<{ url: string; method: string; body: unknown }>
}

function installFetch(state: { workgroups: Workgroup[] } & Recorded): void {
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

      if (url.includes('/api/agents'))
        return json([{ name: 'coder' }, { name: 'auditor' }, { name: 'reviewer' }])
      if (url.includes('/api/users/search')) return json([])
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
      const rename = url.match(/\/api\/workgroups\/([^/]+)\/rename$/)
      if (rename !== null && method === 'POST') {
        const from = decodeURIComponent(rename[1]!)
        const idx = state.workgroups.findIndex((w) => w.name === from)
        // Atomic rename + description edit (2026-07-13): echo the new name and,
        // when provided, the new description; persist so a follow-up GET agrees.
        const b = body as { newName: string; description?: string }
        const base = idx >= 0 ? state.workgroups[idx]! : wg(from)
        const next = {
          ...base,
          name: b.newName,
          ...(b.description !== undefined ? { description: b.description } : {}),
        }
        if (idx >= 0) state.workgroups[idx] = next
        return json(next)
      }
      const one = url.match(/\/api\/workgroups\/([^/]+)$/)
      if (one !== null) {
        const name = decodeURIComponent(one[1]!)
        if (method === 'GET') {
          const row = state.workgroups.find((w) => w.name === name)
          return row !== undefined ? json(row) : json({ code: 'workgroup-not-found' }, 404)
        }
        if (method === 'PUT') {
          const row = state.workgroups.find((w) => w.name === name)
          return json(row ?? wg(name))
        }
        if (method === 'DELETE') return new Response(null, { status: 204 })
      }
      if (url.endsWith('/api/workgroups') && method === 'GET') return json(state.workgroups)
      if (url.endsWith('/api/workgroups') && method === 'POST') {
        return json(wg((body as { name: string }).name), 201)
      }
      return json({})
    },
  )
}

/** Drive the shared agent <Select> (RFC-168): open the combobox and pick an
 *  existing agent by its option label. The former datalist free-text box is
 *  gone, so tests select from /api/agents rather than typing a raw name. */
async function pickAgent(name: string): Promise<void> {
  fireEvent.click(screen.getByTestId('workgroup-agent-name-input'))
  const listbox = await screen.findByRole('listbox')
  fireEvent.mouseDown(within(listbox).getByRole('option', { name }))
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

describe('/workgroups list page', () => {
  test('renders the shared EmptyState when no workgroups exist', async () => {
    installFetch({ workgroups: [], calls: [] })
    await renderPage('/workgroups')
    await screen.findByTestId('workgroups-empty')
    expect(screen.getByTestId('workgroup-new-button')).toBeTruthy()
  })

  // RFC-191 — the list is a card gallery: mode as a semantic StatusChip,
  // member count / leader / autonomous folded into meta chips, whole card
  // links into the room, and「启动」is gated on workgroupLaunchReadiness.
  test('renders cards: name link, semantic mode chip, member/leader chips', async () => {
    installFetch({
      workgroups: [
        wg('review-squad'),
        wg('brainstorm', {
          mode: 'free_collab',
          leaderMemberId: null,
          members: [],
          description: '',
        }),
      ],
      calls: [],
    })
    await renderPage('/workgroups')
    const link = await screen.findByRole('link', { name: 'review-squad' })
    expect(link.getAttribute('href')).toBe('/workgroups/review-squad')

    const lwCard = screen.getByTestId('workgroup-card-review-squad')
    expect(lwCard.textContent).toContain('Leader-Worker')
    expect(lwCard.textContent).toContain('Leader · Coder')
    expect(lwCard.textContent).toContain('3 members')
    // Semantic mode chip (WORKGROUP_MODE_KIND: leader_worker → info).
    expect(lwCard.querySelector('.status-chip--info')).toBeTruthy()
    expect(lwCard.textContent).toContain('audits PRs')

    const fcCard = screen.getByTestId('workgroup-card-brainstorm')
    expect(fcCard.textContent).toContain('Free collaboration')
    expect(fcCard.querySelector('.status-chip--neutral')).toBeTruthy()
    // No leader chip in fc mode; empty description renders the placeholder.
    expect(fcCard.textContent).not.toContain('Leader ·')
    expect(fcCard.textContent).toContain(enUS.workgroups.noDescription)

    // The search index follows visible facts, including the leader summary.
    fireEvent.change(screen.getByTestId('gallery-search'), { target: { value: 'Coder' } })
    expect(screen.getByTestId('workgroup-card-review-squad')).toBeTruthy()
    expect(screen.queryByTestId('workgroup-card-brainstorm')).toBeNull()
  })

  test('launch deep-link renders only for READY groups (shared readiness oracle)', async () => {
    const solo = wg('solo-squad')
    solo.members = solo.members.slice(0, 1)
    installFetch({
      workgroups: [
        wg('review-squad'), // agent members + resolvable leader → ready
        wg('empty-room', { leaderMemberId: null, members: [] }), // no agent → not ready
        wg('leaderless', { leaderMemberId: null }), // agents exist, but no leader selected
        solo, // ready, but advisory: the leader has nobody to dispatch to
      ],
      calls: [],
    })
    await renderPage('/workgroups')
    const launch = await screen.findByTestId('workgroup-card-review-squad-launch')
    const href = launch.getAttribute('href') ?? ''
    expect(href).toContain('/tasks/new')
    expect(href).toContain('kind=workgroup')
    expect(href).toContain('workgroup=review-squad')
    // Not-ready group: card renders, launch does not (same gate as the
    // detail header — the deep link must not dead-end at workgroup-not-ready).
    expect(screen.getByTestId('workgroup-card-empty-room')).toBeTruthy()
    expect(screen.queryByTestId('workgroup-card-empty-room-launch')).toBeNull()
    expect(screen.getByTestId('workgroup-card-empty-room').textContent).toContain(
      'Add an agent to launch',
    )
    expect(screen.queryByTestId('workgroup-card-leaderless-launch')).toBeNull()
    expect(screen.getByTestId('workgroup-card-leaderless').textContent).toContain(
      'Choose a leader to launch',
    )
    // Advisory is visible but never blocks the launch action. This also locks
    // the English singleton member label.
    expect(screen.getByTestId('workgroup-card-solo-squad-launch')).toBeTruthy()
    expect(screen.getByTestId('workgroup-card-solo-squad').textContent).toContain(
      'Leader has no workers',
    )
    expect(screen.getByTestId('workgroup-card-solo-squad').textContent).toContain('1 member')
    expect(screen.getByTestId('workgroup-card-solo-squad').textContent).not.toContain('1 members')
  })

  test('the list page has NO delete affordance (delete lives in the detail header)', async () => {
    installFetch({ workgroups: [wg('review-squad')], calls: [] })
    await renderPage('/workgroups')
    await screen.findByTestId('workgroup-card-review-squad')
    expect(screen.queryByTestId('workgroup-delete-review-squad')).toBeNull()
    // Source lock: the list route composes the shared gallery and never
    // renders a data-table or its own delete Dialog.
    const list = readSrc('routes/workgroups.tsx')
    expect(list).toContain('ResourceGalleryPage')
    expect(list).not.toContain('className="data-table"')
    expect(list).not.toContain('workgroup-delete-')
  })
})

describe('/workgroups quick-create dialog', () => {
  test('invalid name disables Create; a valid draft POSTs {name, description} and navigates', async () => {
    const state = { workgroups: [], calls: [] as Recorded['calls'] }
    installFetch(state)
    const router = await renderPage('/workgroups')

    fireEvent.click(await screen.findByTestId('workgroup-new-button'))
    const confirm = (await screen.findByTestId('workgroup-create-confirm')) as HTMLButtonElement
    expect(confirm.disabled).toBe(true) // empty name

    fireEvent.change(screen.getByTestId('workgroup-create-name'), {
      target: { value: 'Bad Name!' },
    })
    expect((screen.getByTestId('workgroup-create-confirm') as HTMLButtonElement).disabled).toBe(
      true,
    )
    // Malformed (non-empty) name earns the inline error.
    expect(
      screen.getByText(
        'Name must start with a lowercase letter / digit, only [a-z0-9_-], at most 128 chars.',
      ),
    ).toBeTruthy()

    fireEvent.change(screen.getByTestId('workgroup-create-name'), {
      target: { value: 'review-squad' },
    })
    fireEvent.change(screen.getByTestId('workgroup-create-description'), {
      target: { value: 'audits PRs' },
    })
    const enabled = screen.getByTestId('workgroup-create-confirm') as HTMLButtonElement
    expect(enabled.disabled).toBe(false)
    fireEvent.click(enabled)

    await waitFor(() => {
      const post = state.calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/workgroups'))
      expect(post).toBeTruthy()
      // EXACTLY the two quick-create fields — everything else is a backend default.
      expect(post?.body).toEqual({ name: 'review-squad', description: 'audits PRs' })
    })
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/workgroups/review-squad')
    })
  })
})

describe('/workgroups/$name — readiness banner', () => {
  test('a memberless leader_worker group shows BOTH reasons', async () => {
    installFetch({
      workgroups: [wg('empty-squad', { members: [], leaderMemberId: null })],
      calls: [],
    })
    await renderPage('/workgroups/empty-squad')
    const banner = await screen.findByTestId('workgroup-readiness-banner')
    expect(banner.textContent).toContain('No agent members yet — the group cannot launch.')
    expect(banner.textContent).toContain(
      'Leader-Worker mode needs one agent member designated as leader.',
    )
  })

  test('a memberless free_collab group shows only the no-agent reason', async () => {
    installFetch({
      workgroups: [wg('brainstorm', { mode: 'free_collab', members: [], leaderMemberId: null })],
      calls: [],
    })
    await renderPage('/workgroups/brainstorm')
    const banner = await screen.findByTestId('workgroup-readiness-banner')
    expect(banner.textContent).toContain('No agent members yet')
    expect(banner.textContent).not.toContain('Leader-Worker mode needs')
  })

  test('a ready group renders no banner', async () => {
    installFetch({ workgroups: [wg('review-squad')], calls: [] })
    await renderPage('/workgroups/review-squad')
    await screen.findByRole('heading', { name: 'review-squad' })
    expect(screen.queryByTestId('workgroup-readiness-banner')).toBeNull()
  })

  // RFC-187 TRAP-1 — the ADVISORY tier: a leader-only roster is launchable
  // (ready) yet renders the warning line from the same shared oracle. Before
  // this, such a group sailed through readiness and died as an opaque
  // protocol failure (workgroup-e2e-audit TRAP-1).
  test('a leader-only leader_worker roster shows the advisory warning (still launchable)', async () => {
    installFetch({
      workgroups: [
        wg('solo-squad', {
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
          ],
        }),
      ],
      calls: [],
    })
    await renderPage('/workgroups/solo-squad')
    const banner = await screen.findByTestId('workgroup-readiness-banner')
    expect(banner.textContent).toContain('The roster only contains the leader')
    // Advisory ≠ blocking: neither blocking reason is present.
    expect(banner.textContent).not.toContain('No agent members yet')
    expect(banner.textContent).not.toContain('Leader-Worker mode needs')
  })
})

describe('/workgroups/$name — config editing', () => {
  test('config save PUTs the draft with members + server description passed through (no name)', async () => {
    const state = { workgroups: [wg('review-squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    await renderPage('/workgroups/review-squad')

    // Description moved to the rename dialog (2026-07-13); edit the config
    // instructions. The PUT carries the SERVER description through unchanged.
    const instr = (await screen.findByTestId('workgroup-field-instructions')) as HTMLTextAreaElement
    fireEvent.change(instr, { target: { value: 'be thorough' } })
    fireEvent.click(screen.getByTestId('workgroup-save-button'))
    await waitFor(() => {
      const put = state.calls.find(
        (c) => c.method === 'PUT' && c.url.endsWith('/api/workgroups/review-squad'),
      )
      expect(put).toBeTruthy()
      const body = put?.body as Record<string, unknown>
      expect(body.description).toBe('audits PRs') // server value passed through, not edited here
      expect(body.instructions).toBe('be thorough')
      expect(body.name).toBeUndefined()
      expect(body.leaderDisplayName).toBe('Coder')
      expect(body.members).toEqual([
        { memberType: 'agent', agentName: 'coder', displayName: 'Coder', roleDesc: 'writes code' },
        { memberType: 'human', userId: 'u1', displayName: 'Alice', roleDesc: 'reviews' },
        { memberType: 'agent', agentName: 'auditor', displayName: 'Auditor', roleDesc: '' },
      ])
    })
  })

  test('a leaderless leader_worker group keeps Save ENABLED (lenient save contract)', async () => {
    installFetch({
      workgroups: [wg('review-squad', { leaderMemberId: null })],
      calls: [],
    })
    await renderPage('/workgroups/review-squad')
    await screen.findByTestId('workgroup-field-instructions')
    expect((screen.getByTestId('workgroup-save-button') as HTMLButtonElement).disabled).toBe(false)
  })

  test('rename dialog seeds name + description and POSTs /rename with both', async () => {
    const state = { workgroups: [wg('review-squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    await renderPage('/workgroups/review-squad')

    fireEvent.click(await screen.findByTestId('workgroup-rename-button'))
    const nameInput = (await screen.findByTestId('workgroup-rename-name')) as HTMLInputElement
    const descInput = screen.getByTestId('workgroup-rename-description') as HTMLInputElement
    expect(nameInput.value).toBe('review-squad')
    expect(descInput.value).toBe('audits PRs') // seeded from the group
    // Nothing changed yet → confirm disabled.
    expect((screen.getByTestId('workgroup-rename-confirm') as HTMLButtonElement).disabled).toBe(
      true,
    )

    fireEvent.change(nameInput, { target: { value: 'audit-squad' } })
    fireEvent.change(descInput, { target: { value: 'audits merged PRs' } })
    fireEvent.click(screen.getByTestId('workgroup-rename-confirm'))

    await waitFor(() => {
      const post = state.calls.find(
        (c) => c.method === 'POST' && c.url.endsWith('/api/workgroups/review-squad/rename'),
      )
      expect(post).toBeTruthy()
      expect(post?.body).toEqual({ newName: 'audit-squad', description: 'audits merged PRs' })
    })
  })

  test('a description-only edit still saves (newName echoes the current name)', async () => {
    const state = { workgroups: [wg('review-squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    await renderPage('/workgroups/review-squad')

    fireEvent.click(await screen.findByTestId('workgroup-rename-button'))
    const descInput = (await screen.findByTestId(
      'workgroup-rename-description',
    )) as HTMLInputElement
    fireEvent.change(descInput, { target: { value: 'new blurb' } })
    // Name untouched but description changed → confirm enabled.
    expect((screen.getByTestId('workgroup-rename-confirm') as HTMLButtonElement).disabled).toBe(
      false,
    )
    fireEvent.click(screen.getByTestId('workgroup-rename-confirm'))
    await waitFor(() => {
      const post = state.calls.find(
        (c) => c.method === 'POST' && c.url.endsWith('/api/workgroups/review-squad/rename'),
      )
      expect(post?.body).toEqual({ newName: 'review-squad', description: 'new blurb' })
    })
  })
})

describe('/workgroups/$name — member gallery + context panel (RFC-168)', () => {
  test('renders one card per member with title / type chip / leader badge / reference', async () => {
    installFetch({ workgroups: [wg('review-squad')], calls: [] })
    await renderPage('/workgroups/review-squad')

    await screen.findByTestId('workgroup-card-Coder')
    const cards = screen.getAllByRole('listitem')
    expect(cards).toHaveLength(3)
    expect(screen.getByRole('heading', { name: 'Coder', level: 3 })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Alice', level: 3 })).toBeTruthy()

    const coder = screen.getByTestId('workgroup-card-Coder')
    expect(within(coder).getByTestId('workgroup-leader-badge')).toBeTruthy()
    const alice = screen.getByTestId('workgroup-card-Alice')
    // Human card shows the resolved platform user name, never the raw id.
    await waitFor(() => expect(alice.textContent).toContain('Alice Wang'))
    // Cards carry no action buttons anymore — actions live in the panel.
    expect(within(coder).queryByRole('button', { name: 'Remove' })).toBeNull()
  })

  test('selecting a NON-leader agent card offers set-leader in the panel; PUT carries the new leaderDisplayName', async () => {
    const state = { workgroups: [wg('review-squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    await renderPage('/workgroups/review-squad')
    fireEvent.click(await screen.findByTestId('workgroup-card-open-Auditor'))
    fireEvent.click(await screen.findByTestId('workgroup-set-leader-Auditor'))
    await waitFor(() => {
      const put = state.calls.find((c) => c.method === 'PUT')
      expect(put).toBeTruthy()
      const body = put?.body as Record<string, unknown>
      expect(body.leaderDisplayName).toBe('Auditor')
      expect((body.members as unknown[]).length).toBe(3)
    })
  })

  test('selecting the leader card shows the badge but no set-leader; human cards never offer it', async () => {
    installFetch({ workgroups: [wg('review-squad')], calls: [] })
    await renderPage('/workgroups/review-squad')
    fireEvent.click(await screen.findByTestId('workgroup-card-open-Coder'))
    const panel = await screen.findByTestId('workgroup-context-panel')
    expect(within(panel).getByTestId('workgroup-leader-badge')).toBeTruthy()
    expect(within(panel).queryByTestId('workgroup-set-leader-Coder')).toBeNull()
    fireEvent.click(screen.getByTestId('workgroup-card-open-Alice'))
    await waitFor(() => {
      expect(within(panel).queryByTestId('workgroup-set-leader-Alice')).toBeNull()
      expect(within(panel).getByTestId('workgroup-member-displayname-input')).toBeTruthy()
    })
  })

  test('remove confirms (two-click) in the panel then PUTs without the member; removing the leader clears it', async () => {
    const state = { workgroups: [wg('review-squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    await renderPage('/workgroups/review-squad')
    fireEvent.click(await screen.findByTestId('workgroup-card-open-Coder'))
    const panel = await screen.findByTestId('workgroup-context-panel')
    const remove = await within(panel).findByRole('button', { name: 'Remove' })
    fireEvent.click(remove) // arm
    fireEvent.click(within(panel).getByRole('button', { name: 'Confirm?' }))
    await waitFor(() => {
      const put = state.calls.find((c) => c.method === 'PUT')
      expect(put).toBeTruthy()
      const body = put?.body as Record<string, unknown>
      expect(body.leaderDisplayName).toBeUndefined() // leader removed → flag cleared
      expect(body.members).toEqual([
        { memberType: 'human', userId: 'u1', displayName: 'Alice', roleDesc: 'reviews' },
        { memberType: 'agent', agentName: 'auditor', displayName: 'Auditor', roleDesc: '' },
      ])
    })
  })

  test('panel edit patches displayName/roleDesc via the member-save button and PUTs', async () => {
    const state = { workgroups: [wg('review-squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    await renderPage('/workgroups/review-squad')
    fireEvent.click(await screen.findByTestId('workgroup-card-open-Alice'))
    const input = (await screen.findByTestId(
      'workgroup-member-displayname-input',
    )) as HTMLInputElement
    expect(input.value).toBe('Alice')
    fireEvent.change(input, { target: { value: 'Alicia' } })
    fireEvent.click(screen.getByTestId('workgroup-member-save'))
    await waitFor(() => {
      const put = state.calls.find((c) => c.method === 'PUT')
      expect(put).toBeTruthy()
      const members = (put?.body as { members: Array<{ displayName: string }> }).members
      expect(members.map((m) => m.displayName)).toEqual(['Coder', 'Alicia', 'Auditor'])
    })
  })

  test('add-agent panel defaults the alias to the agent name and PUTs the appended member', async () => {
    const state = { workgroups: [wg('review-squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    await renderPage('/workgroups/review-squad')
    fireEvent.click(await screen.findByTestId('workgroup-add-agent-member'))

    // The panel (not a dialog) hosts the add form now.
    await screen.findByTestId('workgroup-panel-add')
    expect(screen.queryByTestId('workgroup-add-agent-dialog')).toBeNull()
    const confirm = screen.getByTestId('workgroup-add-agent-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(true) // empty draft

    await pickAgent('reviewer')
    // Alias followed the agent name (editable default).
    expect(
      (screen.getByTestId('workgroup-member-displayname-input') as HTMLInputElement).value,
    ).toBe('reviewer')
    expect((screen.getByTestId('workgroup-add-agent-confirm') as HTMLButtonElement).disabled).toBe(
      false,
    )
    fireEvent.click(screen.getByTestId('workgroup-add-agent-confirm'))

    await waitFor(() => {
      const put = state.calls.find((c) => c.method === 'PUT')
      expect(put).toBeTruthy()
      const body = put?.body as Record<string, unknown>
      expect(body.leaderDisplayName).toBe('Coder') // preserved
      expect(body.members).toEqual([
        { memberType: 'agent', agentName: 'coder', displayName: 'Coder', roleDesc: 'writes code' },
        { memberType: 'human', userId: 'u1', displayName: 'Alice', roleDesc: 'reviews' },
        { memberType: 'agent', agentName: 'auditor', displayName: 'Auditor', roleDesc: '' },
        { memberType: 'agent', agentName: 'reviewer', displayName: 'reviewer', roleDesc: '' },
      ])
    })
  })

  test('duplicate alias in the add panel blocks the confirm with an inline error', async () => {
    installFetch({ workgroups: [wg('review-squad')], calls: [] })
    await renderPage('/workgroups/review-squad')
    fireEvent.click(await screen.findByTestId('workgroup-add-agent-member'))
    await screen.findByTestId('workgroup-panel-add')
    await pickAgent('coder')
    fireEvent.change(screen.getByTestId('workgroup-member-displayname-input'), {
      target: { value: 'Coder' },
    })
    expect(screen.getByText('Display names must be unique within the group.')).toBeTruthy()
    expect((screen.getByTestId('workgroup-add-agent-confirm') as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  // RFC-168 UI 一致性回归锁 — the agent picker must be the shared Select
  // combobox (searchable, existing-agents-only), never the former native
  // <datalist> free-text box (previously the ONLY datalist in the frontend,
  // which clashed with every other dropdown). Locks both the source (no
  // datalist reintroduced) and the runtime affordance (combobox + option list
  // sourced from /api/agents).
  test('add-agent picker is the shared Select combobox, not a datalist text box', async () => {
    // The concrete datalist wiring (its shared id) is gone from the source;
    // the runtime combobox assertions below lock out any reintroduction.
    expect(readSrc('components/workgroup/MemberFields.tsx')).not.toContain('workgroup-agent-names')
    installFetch({ workgroups: [wg('review-squad')], calls: [] })
    await renderPage('/workgroups/review-squad')
    fireEvent.click(await screen.findByTestId('workgroup-add-agent-member'))
    await screen.findByTestId('workgroup-panel-add')
    const trigger = screen.getByTestId('workgroup-agent-name-input')
    expect(trigger.tagName).toBe('BUTTON')
    expect(trigger.getAttribute('role')).toBe('combobox')
    // Opening reveals exactly the agents from /api/agents — no free typing.
    fireEvent.click(trigger)
    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getByRole('option', { name: 'coder' })).toBeTruthy()
    expect(within(listbox).getByRole('option', { name: 'auditor' })).toBeTruthy()
    expect(within(listbox).getByRole('option', { name: 'reviewer' })).toBeTruthy()
  })
})

describe('RFC-164 /workgroups wiring', () => {
  test('sidebar nav exposes /workgroups inside the workflows group', () => {
    const nav = readSrc('lib/nav.ts')
    expect(nav).toContain("{ to: '/workgroups', i18nKey: 'nav.workgroups', icon: 'workgroup' }")
    const workflowsGroup = nav.slice(nav.indexOf("key: 'workflows'"), nav.indexOf("key: 'tasks'"))
    expect(workflowsGroup).toContain("to: '/workgroups'")
  })

  test('router registers list + detail routes only (creation is a dialog, no /new route)', () => {
    const router = readSrc('router.tsx')
    expect(router).toContain("import { Route as workgroupsRoute } from '@/routes/workgroups'")
    expect(router).toContain(
      "import { Route as workgroupDetailRoute } from '@/routes/workgroups.detail'",
    )
    expect(router).not.toContain('workgroups.new')
    const detailIdx = router.indexOf('workgroupDetailRoute,')
    const listIdx = router.indexOf('workgroupsRoute,')
    expect(detailIdx).toBeGreaterThan(0)
    expect(listIdx).toBeGreaterThan(detailIdx)
  })

  test('detail page composes the gallery + context panel + header actions (RFC-168)', () => {
    const edit = readSrc('routes/workgroups.detail.tsx')
    expect(edit).toContain(
      "import { WorkgroupMemberGallery } from '@/components/workgroup/WorkgroupMemberGallery'",
    )
    expect(edit).toContain('WorkgroupContextPanel')
    expect(edit).toContain('DetailHeaderActions')
    expect(edit).toContain('workgroupLaunchReadiness')
    // The config form lives INSIDE the panel now, not on the page directly.
    const panel = readSrc('components/workgroup/WorkgroupContextPanel.tsx')
    expect(panel).toContain("import { WorkgroupForm } from './WorkgroupForm'")
    const list = readSrc('routes/workgroups.tsx')
    expect(list).toContain('buildQuickCreatePayload')
    expect(list).toContain('btn btn--primary')
  })

  test('zh-CN and en-US both define the RFC-164/168 keys (and dropped the dialog-era keys)', () => {
    const mustExist = [
      'title',
      'newButton',
      'emptyList',
      // RFC-191 — gallery card meta keys (the col*/deleteTitle table-era keys
      // retired with the data-table list).
      'cardMembers_one',
      'cardMembers_other',
      'cardLeader',
      'autonomousChip',
      'cardAddAgent',
      'cardSelectLeader',
      'cardNoWorkers',
      'noDescription',
      'modeLeaderWorker',
      'modeFreeCollab',
      'renameTitle',
      'membersEmpty',
      'memberRemove',
      'setLeaderButton',
      'leaderBadge',
      'addAgentMember',
      'addHumanMember',
      'addAgentTitle',
      'addHumanTitle',
      'fcSwitchesNotice',
      'fieldMaxRounds',
      'fieldCompletionGate',
      // RFC-168 — context panel keys.
      'panelConfigTitle',
      'panelAria',
      'panelClose',
      'memberSave',
      'editAgentDefinition',
      'agentMissing',
      'portsIn',
      'portsOut',
      'configSaved',
    ] as const
    for (const key of mustExist) {
      expect(zhCN.workgroups[key].length, `zh-CN workgroups.${key}`).toBeGreaterThan(0)
      expect(enUS.workgroups[key].length, `en-US workgroups.${key}`).toBeGreaterThan(0)
    }
    expect(zhCN.workgroups.readiness.noAgentMember.length).toBeGreaterThan(0)
    expect(zhCN.workgroups.readiness.leaderMissing.length).toBeGreaterThan(0)
    expect(enUS.workgroups.readiness.noAgentMember.length).toBeGreaterThan(0)
    expect(enUS.workgroups.readiness.leaderMissing.length).toBeGreaterThan(0)
    const errorKeys = [
      'nameRequired',
      'nameInvalid',
      'agentNameRequired',
      'userRequired',
      'displayNameRequired',
      'displayNameInvalid',
      'displayNameTooLong',
      'displayNameDuplicate',
      'leaderMustBeAgent',
      'maxRoundsInvalid',
      'dynamicNoHumanMembers',
    ] as const
    for (const key of errorKeys) {
      expect(zhCN.workgroups.errors[key].length, `zh-CN errors.${key}`).toBeGreaterThan(0)
      expect(enUS.workgroups.errors[key].length, `en-US errors.${key}`).toBeGreaterThan(0)
    }
    // 决策 #21: the strict-save error keys are GONE — leaderless lw groups
    // and empty member sets are save-valid now.
    expect('leaderRequired' in zhCN.workgroups.errors).toBe(false)
    expect('membersRequired' in zhCN.workgroups.errors).toBe(false)
    // RFC-168: the edit-member dialog is gone (panel edits in place).
    expect('memberEdit' in zhCN.workgroups).toBe(false)
    expect('editMemberTitle' in zhCN.workgroups).toBe(false)
    expect(zhCN.nav.workgroups).toBe('工作组')
    expect(enUS.nav.workgroups).toBe('Workgroups')
  })
})
