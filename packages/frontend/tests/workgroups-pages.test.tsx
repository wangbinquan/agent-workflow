// RFC-164 PR-1 → RFC-168 → RFC-225 — /workgroups {list, detail} route
// pages + autosave wiring locks.
//
// Locks:
//   1. List page: empty state, row rendering (name link / mode chip / leader
//      displayName with fc em dash), delete via the shared <Dialog> confirm.
//   2. Quick create: the "+ New workgroup" button opens a name+description
//      dialog; Create stays disabled while the name is invalid and POSTs
//      EXACTLY {name, description} (backend defaults the rest), then
//      navigates to the detail page.
//   3. Detail page: launch-readiness banner renders per reason
//      ('no-agent-member' / 'leader-missing') and hides when ready; edits
//      autosave one version-fenced composite snapshot; leaderless lw groups
//      remain save-valid (决策 #21); rename + description share that same
//      autosave path while the immutable-id route stays stable across rename.
//   4. Member gallery + context panel (RFC-168): one card per member, leader
//      badge; selecting a card opens the member editor in the PANEL (no
//      dialogs) — set-leader / remove / member edit / add-agent flows each
//      feed the same full-document autosave controller.
//      (Panel-specific behaviors — focus, Esc, saved-flash, failure paths —
//      live in workgroup-studio-panel.test.tsx.)
//   5. Wiring: router registers list + detail only (no /new route), nav
//      lists /workgroups in the workflows group, zh/en bundles carry the
//      RFC-164/168 keys (and dropped the dialog-era memberEdit /
//      editMemberTitle keys).

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
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
import {
  serializeWorkgroupEditableSnapshotV1,
  type SaveWorkgroupReceipt,
  type UpdateWorkgroup,
  type Workgroup,
  type WorkgroupDetail,
  type WorkgroupDraftSnapshot,
  type WorkgroupSnapshotHash,
} from '@agent-workflow/shared'
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

function draftOf(group: Workgroup): WorkgroupDraftSnapshot {
  const ordered = [...group.members].sort((left, right) => left.sortOrder - right.sortOrder)
  const leader = ordered.find((member) => member.id === group.leaderMemberId)
  return {
    name: group.name,
    description: group.description,
    instructions: group.instructions,
    mode: group.mode,
    ...(group.mode === 'leader_worker' && leader !== undefined
      ? { leaderDisplayName: leader.displayName }
      : {}),
    switches: { ...group.switches },
    maxRounds: group.maxRounds,
    completionGate: group.completionGate,
    clarifyBudget: group.clarifyBudget ?? 3,
    fanOut: group.fanOut ?? false,
    members: ordered.map((member) =>
      member.memberType === 'agent'
        ? {
            memberType: 'agent' as const,
            agentId: member.agentId ?? '',
            displayName: member.displayName,
            roleDesc: member.roleDesc,
          }
        : {
            memberType: 'human' as const,
            userId: member.userId ?? '',
            displayName: member.displayName,
            roleDesc: member.roleDesc,
          },
    ),
  }
}

function snapshotHashOf(snapshot: WorkgroupDraftSnapshot): WorkgroupSnapshotHash {
  return createHash('sha256')
    .update(serializeWorkgroupEditableSnapshotV1(snapshot), 'utf8')
    .digest('hex') as WorkgroupSnapshotHash
}

function wg(name: string, overrides: Partial<Workgroup> = {}): WorkgroupDetail {
  const group: Workgroup = {
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
        agentId: 'agent-coder',
        agentName: 'coder',
        userId: null,
        displayName: 'Coder',
        roleDesc: 'writes code',
        sortOrder: 0,
      },
      {
        id: 'mem_2',
        memberType: 'human',
        agentId: null,
        agentName: null,
        userId: 'u1',
        displayName: 'Alice',
        roleDesc: 'reviews',
        sortOrder: 1,
      },
      {
        id: 'mem_3',
        memberType: 'agent',
        agentId: 'agent-auditor',
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
    version: 1,
    createdAt: 1,
    updatedAt: 1_720_000_000_000,
    ...overrides,
  }
  return { ...group, snapshotHash: snapshotHashOf(draftOf(group)) }
}

interface Recorded {
  calls: Array<{ url: string; method: string; body: unknown }>
}

let memberIdSeq = 500

/** Mirrors the real full-replace endpoint, including regenerated member ids. */
function synthesizePutRow(base: WorkgroupDetail, body: WorkgroupDraftSnapshot): WorkgroupDetail {
  const prior = draftOf(base)
  const rosterChanged =
    JSON.stringify({
      leaderDisplayName: prior.leaderDisplayName,
      members: prior.members,
    }) !==
    JSON.stringify({
      leaderDisplayName: body.leaderDisplayName,
      members: body.members,
    })
  const members = body.members.map((member, index) => ({
    id: `mem_p${memberIdSeq++}`,
    memberType: member.memberType,
    agentId: member.memberType === 'agent' ? (member.agentId ?? null) : null,
    agentName:
      member.memberType === 'agent'
        ? ({
            'agent-coder': 'coder',
            'agent-auditor': 'auditor',
            'agent-reviewer': 'reviewer',
          }[member.agentId ?? ''] ??
          base.members.find((existing) => existing.agentId === member.agentId)?.agentName ??
          null)
        : null,
    userId: member.memberType === 'human' ? (member.userId ?? null) : null,
    displayName: member.displayName,
    roleDesc: member.roleDesc,
    sortOrder: index,
  }))
  const persistedMembers = rosterChanged ? members : base.members
  const leaderName = body.leaderDisplayName
  return {
    ...base,
    name: body.name,
    description: body.description,
    instructions: body.instructions,
    mode: body.mode,
    switches: body.switches,
    maxRounds: body.maxRounds,
    completionGate: body.completionGate,
    clarifyBudget: body.clarifyBudget,
    fanOut: body.fanOut,
    members: persistedMembers,
    leaderMemberId:
      leaderName === undefined
        ? null
        : (persistedMembers.find((member) => member.displayName === leaderName)?.id ?? null),
    version: base.version + 1,
    updatedAt: base.updatedAt + 1,
    snapshotHash: snapshotHashOf(body),
  }
}

function saveReceipt(input: UpdateWorkgroup, workgroup: WorkgroupDetail): SaveWorkgroupReceipt {
  return {
    clientMutationId: input.clientMutationId,
    requestedBaseVersion: input.expectedVersion,
    revision: {
      workgroupId: workgroup.id,
      version: workgroup.version,
      snapshotHash: workgroup.snapshotHash,
      updatedAt: workgroup.updatedAt,
    },
    snapshot: input.snapshot,
    workgroup,
    outcome: 'committed',
  }
}

function installFetch(
  state: {
    workgroups: WorkgroupDetail[]
    failDetail?: boolean
    putStatus?: number
    renameGate?: Promise<void>
    deleteGate?: Promise<void>
  } & Recorded,
): void {
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
        return json([
          { id: 'agent-coder', name: 'coder' },
          { id: 'agent-auditor', name: 'auditor' },
          { id: 'agent-reviewer', name: 'reviewer' },
        ])
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
      const one = url.match(/\/api\/workgroups\/([^/]+)$/)
      if (one !== null) {
        const id = decodeURIComponent(one[1]!)
        if (method === 'GET') {
          if (state.failDetail === true)
            return json(
              { code: 'workgroup-detail-failed', message: 'workgroup detail unavailable' },
              500,
            )
          const row = state.workgroups.find((w) => w.id === id)
          return row !== undefined ? json(row) : json({ code: 'workgroup-not-found' }, 404)
        }
        if (method === 'PUT') {
          if (state.putStatus !== undefined) {
            return json(
              { code: 'workgroup-save-unavailable', message: 'workgroup save unavailable' },
              state.putStatus,
            )
          }
          const row = state.workgroups.find((w) => w.id === id)
          const input = body as UpdateWorkgroup
          if (row !== undefined && input.snapshot.name !== row.name) await state.renameGate
          const fresh = synthesizePutRow(row ?? wg('missing', { id }), input.snapshot)
          const index = state.workgroups.findIndex((workgroup) => workgroup.id === id)
          if (index >= 0) state.workgroups[index] = fresh
          return json(saveReceipt(input, fresh))
        }
        if (method === 'DELETE') {
          await state.deleteGate
          return new Response(null, { status: 204 })
        }
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

function savedSnapshot(call: Recorded['calls'][number] | undefined): WorkgroupDraftSnapshot {
  return (call?.body as UpdateWorkgroup).snapshot
}

async function waitForPut(
  state: Recorded,
  predicate: (call: Recorded['calls'][number]) => boolean = () => true,
): Promise<Recorded['calls'][number]> {
  let match: Recorded['calls'][number] | undefined
  await waitFor(
    () => {
      match = state.calls.find((call) => call.method === 'PUT' && predicate(call))
      expect(match).toBeTruthy()
    },
    { timeout: 3_000 },
  )
  return match!
}

async function openWorkgroupAction(testid: string): Promise<void> {
  fireEvent.click(await screen.findByTestId('workgroup-more-actions'))
  await screen.findByTestId('workgroup-actions-dialog')
  fireEvent.click(screen.getByTestId(testid))
}

async function renderPage(
  initialEntry: string,
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
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
    path: '/workgroups/$id',
    component: detail.Route.options.component,
    remountDeps: detail.Route.options.remountDeps,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([listRoute, detailRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
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
    const empty = await screen.findByTestId('workgroups-empty')
    expect(empty.textContent).toContain(enUS.workgroups.emptyDescription)
    expect(screen.getAllByTestId('workgroup-new-button')).toHaveLength(1)
    expect(within(empty).getByTestId('workgroup-new-button')).toBeTruthy()
    expect(within(screen.getByRole('banner')).queryByTestId('workgroup-new-button')).toBeNull()
    expect(empty.querySelector('[data-icon="workgroup"]')).not.toBeNull()
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
    expect(link.getAttribute('href')).toBe('/workgroups/wg_review-squad')

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

    // The primary stays in the header whenever real items exist, while the
    // filtered-empty state offers only the localized clear-search action.
    fireEvent.change(screen.getByTestId('gallery-search'), { target: { value: 'zzz' } })
    const noMatches = screen.getByTestId('gallery-no-matches')
    expect(within(screen.getByRole('banner')).getByTestId('workgroup-new-button')).toBeTruthy()
    expect(within(noMatches).queryByTestId('workgroup-new-button')).toBeNull()
    expect(within(noMatches).getAllByRole('button')).toHaveLength(1)
    fireEvent.click(within(noMatches).getByRole('button', { name: enUS.common.clearSearch }))
    expect(screen.getByTestId('workgroup-card-review-squad')).toBeTruthy()
    expect(screen.getByTestId('workgroup-card-brainstorm')).toBeTruthy()
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
    expect(href).toContain('workgroupId=wg_review-squad')
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
      expect(router.state.location.pathname).toBe('/workgroups/wg_review-squad')
    })
  })
})

describe('/workgroups/$id — readiness banner', () => {
  test('a memberless leader_worker group shows BOTH reasons', async () => {
    installFetch({
      workgroups: [wg('empty-squad', { members: [], leaderMemberId: null })],
      calls: [],
    })
    await renderPage('/workgroups/wg_empty-squad')
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
    await renderPage('/workgroups/wg_brainstorm')
    const banner = await screen.findByTestId('workgroup-readiness-banner')
    expect(banner.textContent).toContain('No agent members yet')
    expect(banner.textContent).not.toContain('Leader-Worker mode needs')
  })

  test('a ready group renders no banner', async () => {
    installFetch({ workgroups: [wg('review-squad')], calls: [] })
    await renderPage('/workgroups/wg_review-squad')
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
              agentId: 'agent-coder',
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
    await renderPage('/workgroups/wg_solo-squad')
    const banner = await screen.findByTestId('workgroup-readiness-banner')
    expect(banner.textContent).toContain('The roster only contains the leader')
    // Advisory ≠ blocking: neither blocking reason is present.
    expect(banner.textContent).not.toContain('No agent members yet')
    expect(banner.textContent).not.toContain('Leader-Worker mode needs')
  })
})

describe('/workgroups/$id — config editing', () => {
  test('header matches the workflow editor title/id/version and primary-action hierarchy', async () => {
    installFetch({ workgroups: [wg('review-squad')], calls: [] })
    await renderPage('/workgroups/wg_review-squad')

    await screen.findByTestId('workgroup-draft-status')
    const header = screen.getByRole('heading', { name: 'review-squad' }).closest('.page__header')
    expect(header?.classList.contains('editor-page-header')).toBe(true)
    expect(header?.querySelector('.page__meta')?.textContent).toContain('wg_review-squad')
    expect(header?.querySelector('.page__meta')?.textContent).toContain('v1')
    expect(header?.querySelectorAll('.btn--primary')).toHaveLength(1)
    expect(header?.querySelector('.btn--primary')?.textContent).toContain('Launch task')
    expect(screen.getByTestId('workgroup-more-actions').classList.contains('btn--sm')).toBe(false)
    expect(screen.queryByTestId('workgroup-rename-button')).toBeNull()
    expect(screen.queryByTestId('workgroup-delete-button')).toBeNull()

    fireEvent.click(screen.getByTestId('workgroup-more-actions'))
    expect(await screen.findByTestId('workgroup-actions-dialog')).toBeTruthy()
    expect(screen.getByTestId('workgroup-rename-button')).toBeTruthy()
    expect(screen.getByTestId('workgroup-delete-button')).toBeTruthy()
  })

  test('initial retry recovers; stale refetch preserves the draft; param switch reseeds', async () => {
    const state = {
      workgroups: [wg('review-squad'), wg('second-squad', { instructions: 'second instructions' })],
      calls: [] as Recorded['calls'],
      failDetail: true,
    }
    installFetch(state)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const router = await renderPage('/workgroups/wg_review-squad', qc)

    const retry = await screen.findByRole('button', { name: /retry/i })
    expect(screen.queryByTestId('workgroup-field-instructions')).toBeNull()
    state.failDetail = false
    fireEvent.click(retry)
    const instructions = (await screen.findByTestId(
      'workgroup-field-instructions',
    )) as HTMLTextAreaElement
    fireEvent.change(instructions, { target: { value: 'local unsaved instructions' } })

    state.failDetail = true
    await qc.refetchQueries({ queryKey: ['workgroups', 'wg_review-squad'], exact: true })
    const staleAlert = await screen.findByRole('alert')
    expect(staleAlert.textContent).toContain('workgroup detail unavailable')
    expect((screen.getByTestId('workgroup-field-instructions') as HTMLTextAreaElement).value).toBe(
      'local unsaved instructions',
    )

    state.failDetail = false
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect((screen.getByTestId('workgroup-field-instructions') as HTMLTextAreaElement).value).toBe(
      'local unsaved instructions',
    )

    const navigation = router.navigate({
      to: '/workgroups/$id',
      params: { id: 'wg_second-squad' },
    })
    const guard = await screen.findByTestId('unsaved-guard-dialog')
    expect(guard.textContent).toContain('Unsaved changes')
    fireEvent.click(screen.getByTestId('unsaved-discard'))
    await navigation
    await waitFor(() =>
      expect(
        (screen.getByTestId('workgroup-field-instructions') as HTMLTextAreaElement).value,
      ).toBe('second instructions'),
    )
  })

  test('text edits autosave one fenced composite snapshot after the debounce', async () => {
    const state = { workgroups: [wg('review-squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    await renderPage('/workgroups/wg_review-squad')

    const instr = (await screen.findByTestId('workgroup-field-instructions')) as HTMLTextAreaElement
    fireEvent.change(instr, { target: { value: 'be thorough' } })
    expect(screen.queryByTestId('workgroup-save-button')).toBeNull()
    expect(screen.getByTestId('workgroup-draft-phase').textContent).toContain('Unsaved')

    const put = await waitForPut(state, (call) =>
      call.url.endsWith('/api/workgroups/wg_review-squad'),
    )
    const input = put.body as UpdateWorkgroup
    expect(input.expectedVersion).toBe(1)
    expect(input.clientMutationId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
    expect(input.snapshot).toEqual({
      name: 'review-squad',
      description: 'audits PRs',
      instructions: 'be thorough',
      mode: 'leader_worker',
      leaderDisplayName: 'Coder',
      switches: { shareOutputs: true, directMessages: false, blackboard: false },
      maxRounds: 20,
      completionGate: false,
      clarifyBudget: 3,
      fanOut: false,
      members: [
        {
          memberType: 'agent',
          agentId: 'agent-coder',
          displayName: 'Coder',
          roleDesc: 'writes code',
        },
        { memberType: 'human', userId: 'u1', displayName: 'Alice', roleDesc: 'reviews' },
        {
          memberType: 'agent',
          agentId: 'agent-auditor',
          displayName: 'Auditor',
          roleDesc: '',
        },
      ],
    })
    await waitFor(() =>
      expect(screen.getByTestId('workgroup-draft-phase').textContent).toContain('Saved'),
    )
    expect(document.querySelector('.editor-page-header .page__meta')?.textContent).toContain('v2')
  })

  test('a definitive save error preserves the draft and Retry now resumes autosave', async () => {
    const state = {
      workgroups: [wg('review-squad')],
      calls: [] as Recorded['calls'],
      putStatus: 422 as number | undefined,
    }
    installFetch(state)
    await renderPage('/workgroups/wg_review-squad')

    fireEvent.change(await screen.findByTestId('workgroup-field-instructions'), {
      target: { value: 'local draft after uncertain save' },
    })
    await waitForPut(state)
    await waitFor(() =>
      expect(screen.getByTestId('workgroup-draft-phase').textContent).toContain('Save failed'),
    )
    expect((screen.getByTestId('workgroup-field-instructions') as HTMLTextAreaElement).value).toBe(
      'local draft after uncertain save',
    )

    state.putStatus = undefined
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }))
    await waitFor(
      () => expect(state.workgroups[0]?.instructions).toBe('local draft after uncertain save'),
      { timeout: 3_000 },
    )
    await waitFor(() =>
      expect(screen.getByTestId('workgroup-draft-phase').textContent).toContain('Saved'),
    )
  })

  test('a clean leaderless group is save-valid and autosaves after an edit', async () => {
    const state = {
      workgroups: [wg('review-squad', { leaderMemberId: null })],
      calls: [] as Recorded['calls'],
    }
    installFetch(state)
    await renderPage('/workgroups/wg_review-squad')
    await screen.findByTestId('workgroup-field-instructions')
    expect(screen.queryByTestId('workgroup-save-button')).toBeNull()
    expect(screen.getByTestId('workgroup-draft-phase').textContent).toContain('Saved')
    fireEvent.change(screen.getByTestId('workgroup-field-instructions'), {
      target: { value: 'leaderless remains save-valid' },
    })
    expect(screen.getByTestId('workgroup-draft-phase').textContent).toContain('Unsaved')
    await waitForPut(state)
    await waitFor(() =>
      expect(screen.getByTestId('workgroup-draft-phase').textContent).toContain('Saved'),
    )
  })

  test('rename dialog commits name + description while keeping the stable id route', async () => {
    const state = { workgroups: [wg('review-squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    const router = await renderPage('/workgroups/wg_review-squad')

    await openWorkgroupAction('workgroup-rename-button')
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

    const put = await waitForPut(state)
    expect(savedSnapshot(put)).toMatchObject({
      name: 'audit-squad',
      description: 'audits merged PRs',
    })
    expect(state.calls.some((call) => call.url.endsWith('/rename'))).toBe(false)
    await waitFor(() => expect(router.state.location.pathname).toBe('/workgroups/wg_review-squad'))
  })

  test('a description-only rename-dialog edit uses the same composite autosave', async () => {
    const state = { workgroups: [wg('review-squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    await renderPage('/workgroups/wg_review-squad')

    await openWorkgroupAction('workgroup-rename-button')
    const descInput = (await screen.findByTestId(
      'workgroup-rename-description',
    )) as HTMLInputElement
    fireEvent.change(descInput, { target: { value: 'new blurb' } })
    // Name untouched but description changed → confirm enabled.
    expect((screen.getByTestId('workgroup-rename-confirm') as HTMLButtonElement).disabled).toBe(
      false,
    )
    fireEvent.click(screen.getByTestId('workgroup-rename-confirm'))
    const put = await waitForPut(state)
    expect(savedSnapshot(put)).toMatchObject({
      name: 'review-squad',
      description: 'new blurb',
    })
  })

  test('rename is synchronously non-discardable and completion releases the guard', async () => {
    let releaseRename!: () => void
    const renameGate = new Promise<void>((resolve) => {
      releaseRename = resolve
    })
    const state = {
      workgroups: [wg('review-squad')],
      calls: [] as Recorded['calls'],
      renameGate,
    }
    installFetch(state)
    const router = await renderPage('/workgroups/wg_review-squad')

    await openWorkgroupAction('workgroup-rename-button')
    fireEvent.change(screen.getByTestId('workgroup-rename-name'), {
      target: { value: 'audit-squad' },
    })
    fireEvent.click(screen.getByTestId('workgroup-rename-confirm'))
    void router.navigate({ to: '/workgroups' })

    const guard = await screen.findByTestId('unsaved-guard-dialog')
    expect(guard.textContent).toMatch(/still in progress/i)
    expect(screen.queryByTestId('unsaved-discard')).toBeNull()
    expect(router.state.location.pathname).toBe('/workgroups/wg_review-squad')

    releaseRename()
    await waitFor(() => expect(router.state.location.pathname).toBe('/workgroups/wg_review-squad'))
    await waitFor(() => expect(screen.queryByTestId('unsaved-guard-dialog')).toBeNull())
  })

  test('delete is synchronously non-discardable and successful delete reaches the list', async () => {
    let releaseDelete!: () => void
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve
    })
    installFetch({
      workgroups: [wg('review-squad')],
      calls: [],
      deleteGate,
    })
    const router = await renderPage('/workgroups/wg_review-squad')

    // RFC-222 (D5): delete now opens a type-to-confirm dialog — type the name.
    await openWorkgroupAction('workgroup-delete-button')
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByTestId('confirm-input'), {
      target: { value: 'review-squad' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: /^Delete$/i }))
    void router.navigate({ to: '/workgroups' })

    const guard = await screen.findByTestId('unsaved-guard-dialog')
    expect(guard.textContent).toMatch(/still in progress/i)
    expect(screen.queryByTestId('unsaved-discard')).toBeNull()
    expect(router.state.location.pathname).toBe('/workgroups/wg_review-squad')

    releaseDelete()
    await waitFor(() => expect(router.state.location.pathname).toBe('/workgroups'))
    await waitFor(() => expect(screen.queryByTestId('unsaved-guard-dialog')).toBeNull())
  })
})

describe('/workgroups/$id — member gallery + context panel (RFC-168)', () => {
  test('renders one card per member with title / type chip / leader badge / reference', async () => {
    installFetch({ workgroups: [wg('review-squad')], calls: [] })
    await renderPage('/workgroups/wg_review-squad')

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
    await renderPage('/workgroups/wg_review-squad')
    fireEvent.click(await screen.findByTestId('workgroup-card-open-Auditor'))
    fireEvent.click(await screen.findByTestId('workgroup-set-leader-Auditor'))
    const put = await waitForPut(state)
    expect(savedSnapshot(put).leaderDisplayName).toBe('Auditor')
    expect(savedSnapshot(put).members).toHaveLength(3)
  })

  test('selecting the leader card shows the badge but no set-leader; human cards never offer it', async () => {
    installFetch({ workgroups: [wg('review-squad')], calls: [] })
    await renderPage('/workgroups/wg_review-squad')
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
    await renderPage('/workgroups/wg_review-squad')
    fireEvent.click(await screen.findByTestId('workgroup-card-open-Coder'))
    const panel = await screen.findByTestId('workgroup-context-panel')
    const remove = await within(panel).findByRole('button', { name: 'Remove' })
    fireEvent.click(remove) // arm
    fireEvent.click(within(panel).getByRole('button', { name: 'Confirm?' }))
    const put = await waitForPut(state)
    const snapshot = savedSnapshot(put)
    expect(snapshot.leaderDisplayName).toBeUndefined() // leader removed → flag cleared
    expect(snapshot.members).toEqual([
      { memberType: 'human', userId: 'u1', displayName: 'Alice', roleDesc: 'reviews' },
      {
        memberType: 'agent',
        agentId: 'agent-auditor',
        displayName: 'Auditor',
        roleDesc: '',
      },
    ])
  })

  test('panel text edits autosave without a member-save button', async () => {
    const state = { workgroups: [wg('review-squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    await renderPage('/workgroups/wg_review-squad')
    fireEvent.click(await screen.findByTestId('workgroup-card-open-Alice'))
    const input = (await screen.findByTestId(
      'workgroup-member-displayname-input',
    )) as HTMLInputElement
    expect(input.value).toBe('Alice')
    fireEvent.change(input, { target: { value: 'Alicia' } })
    expect(screen.queryByTestId('workgroup-member-save')).toBeNull()
    const put = await waitForPut(state)
    expect(savedSnapshot(put).members.map((member) => member.displayName)).toEqual([
      'Coder',
      'Alicia',
      'Auditor',
    ])
  })

  test('add-agent panel defaults the alias to the agent name and PUTs the appended member', async () => {
    const state = { workgroups: [wg('review-squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    await renderPage('/workgroups/wg_review-squad')
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

    const put = await waitForPut(state)
    const snapshot = savedSnapshot(put)
    expect(snapshot.leaderDisplayName).toBe('Coder') // preserved
    expect(snapshot.members).toEqual([
      {
        memberType: 'agent',
        agentId: 'agent-coder',
        displayName: 'Coder',
        roleDesc: 'writes code',
      },
      { memberType: 'human', userId: 'u1', displayName: 'Alice', roleDesc: 'reviews' },
      {
        memberType: 'agent',
        agentId: 'agent-auditor',
        displayName: 'Auditor',
        roleDesc: '',
      },
      {
        memberType: 'agent',
        agentId: 'agent-reviewer',
        displayName: 'reviewer',
        roleDesc: '',
      },
    ])
  })

  test('duplicate alias in the add panel blocks the confirm with an inline error', async () => {
    installFetch({ workgroups: [wg('review-squad')], calls: [] })
    await renderPage('/workgroups/wg_review-squad')
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
    await renderPage('/workgroups/wg_review-squad')
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

  test('detail page composes the gallery + context panel + workflow-aligned header', () => {
    const edit = readSrc('routes/workgroups.detail.tsx')
    expect(edit).toContain(
      "import { WorkgroupMemberGallery } from '@/components/workgroup/WorkgroupMemberGallery'",
    )
    expect(edit).toContain('WorkgroupContextPanel')
    expect(edit).toContain('className="editor-page-header editor-page-header--workgroup"')
    expect(edit).toContain('<code>{props.initial.id}</code>')
    expect(edit).toContain('controller.state.serverRevision.version')
    expect(edit).toContain('data-testid="workgroup-more-actions"')
    expect(edit).toContain('data-testid="workgroup-actions-dialog"')
    expect(edit).not.toContain('DetailHeaderActions')
    expect(edit).toContain('workgroupLaunchReadiness')
    expect(edit).toContain("path: '/workgroups/$id'")
    expect(edit).toContain("queryKey: ['workgroups', id]")
    expect(edit).toContain('<PageHeader title={id} />')
    expect(edit).toContain('error={query.error}')
    // RFC-214: loading-gate retry收编到 ErrorBanner.onRetry (was hand-written button onClick).
    expect(edit).toContain('onRetry={() => void query.refetch()}')
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
      'humanMemberChip',
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
      'actionsTitle',
      'renameActionHint',
      'aclActionHint',
      'deleteActionHint',
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
