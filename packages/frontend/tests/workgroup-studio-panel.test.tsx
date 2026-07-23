// RFC-168 → RFC-225 — workgroup detail STUDIO: context-panel + autosave
// interaction contract
// (design §9). The sibling workgroups-pages.test.tsx keeps the RFC-164-era
// PUT-body locks (adapted to the panel); THIS file locks the panel-specific
// behaviors the redesign introduced:
//   §9.1  three-state switching: config ↔ member (same-card toggle, close
//         button, panel-scoped Esc)
//   §9.3  set-leader hidden outside leader_worker; dyn hides add-human
//   §9.4  roster-changing PUTs REGENERATE ids — receipts re-resolve the
//         selection by wire-normalized content (F4: padded alias still selects)
//   §9.5  human add flow: picker → alias auto-follow → hand-edit stops it
//   §9.6  capability summary: port chips, +n truncation, dangling-agent warn,
//         no summary on humans, agents-query failure degrades gracefully (F6)
//   §9.7/9.8 autosave stays on the page; persistent phase status never lies
//         about edits made while a PUT is in flight (F2)
//   §9.9  composite PUT failure: global error + draft kept + retry works
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
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path, { resolve } from 'node:path'
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
import '../src/i18n'

const FRONTEND_SRC = resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'src')
const readSrc = (rel: string): string => readFileSync(resolve(FRONTEND_SRC, rel), 'utf-8')

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
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

/** Agents with declared ports — feeds the capability summary/card. */
const RICH_AGENTS = [
  {
    id: 'agent-coder',
    name: 'coder',
    description: 'implements features',
    role: 'normal',
    inputs: [{ name: 'spec', kind: 'string', required: true }],
    outputs: ['code', 'notes'],
    outputKinds: { code: 'string' },
  },
  {
    id: 'agent-auditor',
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
  putImpl?: (id: string, snapshot: WorkgroupDraftSnapshot) => Response | Promise<Response> | null
}

let memberIdSeq = 100

/** Mirrors the backend contract: roster-changing PUTs regenerate member ids. */
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
  const regenerated = body.members.map((m, i) => ({
    id: `mem_g${memberIdSeq++}`,
    memberType: m.memberType,
    agentId: m.memberType === 'agent' ? (m.agentId ?? null) : null,
    agentName:
      m.memberType === 'agent'
        ? (RICH_AGENTS.find((agent) => agent.id === m.agentId)?.name ??
          base.members.find((member) => member.agentId === m.agentId)?.agentName ??
          null)
        : null,
    userId: m.memberType === 'human' ? (m.userId ?? null) : null,
    displayName: m.displayName,
    roleDesc: m.roleDesc,
    sortOrder: i,
  }))
  const members = rosterChanged ? regenerated : base.members
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
    members,
    leaderMemberId:
      leaderName !== undefined
        ? (members.find((m) => m.displayName === leaderName)?.id ?? null)
        : null,
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
  state: { workgroups: WorkgroupDetail[] } & Recorded,
  opts: FetchOpts = {},
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
        const id = decodeURIComponent(one[1]!)
        const row = state.workgroups.find((w) => w.id === id)
        if (method === 'GET') {
          return row !== undefined ? json(row) : json({ code: 'workgroup-not-found' }, 404)
        }
        if (method === 'PUT') {
          const input = body as UpdateWorkgroup
          const custom = await opts.putImpl?.(id, input.snapshot)
          if (custom !== null && custom !== undefined) {
            if (!custom.ok) return custom
            const payload = (await custom.json()) as WorkgroupDetail | SaveWorkgroupReceipt
            if ('revision' in payload) return json(payload, custom.status)
            const normalizedSnapshot = draftOf(payload)
            const normalized: WorkgroupDetail = {
              ...payload,
              version: payload.version ?? (row?.version ?? 0) + 1,
              snapshotHash: snapshotHashOf(normalizedSnapshot),
            }
            const idx = state.workgroups.findIndex((workgroup) => workgroup.id === id)
            if (idx >= 0) state.workgroups[idx] = normalized
            return json(saveReceipt(input, normalized), custom.status)
          }
          const fresh = synthesizePutRow(row ?? wg('missing', { id }), input.snapshot)
          const idx = state.workgroups.findIndex((w) => w.id === id)
          if (idx >= 0) state.workgroups[idx] = fresh
          return json(saveReceipt(input, fresh))
        }
        if (method === 'DELETE') return new Response(null, { status: 204 })
      }
      if (url.endsWith('/api/workgroups') && method === 'GET') return json(state.workgroups)
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

async function waitForPut(state: Recorded, count = 1): Promise<Recorded['calls'][number]> {
  await waitFor(
    () => expect(state.calls.filter((call) => call.method === 'PUT')).toHaveLength(count),
    { timeout: 3_000 },
  )
  return state.calls.filter((call) => call.method === 'PUT')[count - 1]!
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
    path: '/workgroups/$id',
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
    await renderPage('/workgroups/wg_squad')

    // config state: the config entry is selected by default (RFC-171) and the
    // config form renders inside the panel.
    await screen.findByTestId('workgroup-card-Coder')
    expect(within(panelEl()).getByTestId('workgroup-field-instructions')).toBeTruthy()
    const cfgEntry = screen.getByTestId('workgroup-config-entry')
    expect(cfgEntry.classList.contains('is-selected')).toBe(true)
    // 2026-07-13 用户「组配置改成蓝色按钮风格」— the config entry uses the shared
    // blue .btn--primary chrome now (a recognizable button), NOT the card-like
    // .split-card (and no longer full card width — auto width via CSS).
    expect(cfgEntry.classList.contains('btn')).toBe(true)
    expect(cfgEntry.classList.contains('btn--primary')).toBe(true)
    expect(cfgEntry.classList.contains('split-card')).toBe(false)

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
    expect(within(panelEl()).getByTestId('workgroup-field-instructions')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByTestId('workgroup-card-open-Auditor'))

    // same-card toggle: select then click the same card again.
    fireEvent.click(screen.getByTestId('workgroup-card-open-Auditor'))
    await within(panelEl()).findByTestId('workgroup-member-displayname-input')
    fireEvent.click(screen.getByTestId('workgroup-card-open-Auditor'))
    expect(within(panelEl()).getByTestId('workgroup-field-instructions')).toBeTruthy()

    // Esc inside the panel closes it.
    fireEvent.click(screen.getByTestId('workgroup-card-open-Auditor'))
    const again = await within(panelEl()).findByTestId('workgroup-member-displayname-input')
    fireEvent.keyDown(again, { key: 'Escape' })
    expect(within(panelEl()).getByTestId('workgroup-field-instructions')).toBeTruthy()

    // RFC-171: clicking BLANK space in the member scroll rail deselects too
    // (desktop selection grammar, kept from RFC-168); clicks landing on a card
    // ([data-member-key]) never do (the closest() guard swallows them).
    fireEvent.click(screen.getByTestId('workgroup-card-open-Auditor'))
    await within(panelEl()).findByTestId('workgroup-member-displayname-input')
    fireEvent.click(screen.getByTestId('workgroup-member-scroll'))
    expect(within(panelEl()).getByTestId('workgroup-field-instructions')).toBeTruthy()
  })

  test('rename-dialog Esc closes ONLY the dialog — the panel selection survives (§9.11, F9)', async () => {
    installFetch({ workgroups: [wg('squad')], calls: [] })
    await renderPage('/workgroups/wg_squad')
    fireEvent.click(await screen.findByTestId('workgroup-card-open-Auditor'))
    await within(panelEl()).findByTestId('workgroup-member-displayname-input')

    fireEvent.click(screen.getByTestId('workgroup-more-actions'))
    await screen.findByTestId('workgroup-actions-dialog')
    fireEvent.click(screen.getByTestId('workgroup-rename-button'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // panel still shows the member editor
    expect(within(panelEl()).getByTestId('workgroup-member-displayname-input')).toBeTruthy()
  })

  test('RFC-201: member edits survive card switch, Close and panel Escape', async () => {
    installFetch({ workgroups: [wg('squad')], calls: [] })
    await renderPage('/workgroups/wg_squad')
    fireEvent.click(await screen.findByTestId('workgroup-card-open-Auditor'))
    fireEvent.change(await within(panelEl()).findByTestId('workgroup-member-displayname-input'), {
      target: { value: 'DraftAuditor' },
    })

    fireEvent.click(screen.getByTestId('workgroup-card-open-Coder'))
    expect(
      (within(panelEl()).getByTestId('workgroup-member-displayname-input') as HTMLInputElement)
        .value,
    ).toBe('Coder')
    fireEvent.click(screen.getByTestId('workgroup-card-open-DraftAuditor'))
    expect(
      (within(panelEl()).getByTestId('workgroup-member-displayname-input') as HTMLInputElement)
        .value,
    ).toBe('DraftAuditor')

    fireEvent.click(screen.getByTestId('workgroup-panel-close'))
    fireEvent.click(screen.getByTestId('workgroup-card-open-DraftAuditor'))
    const reopened = within(panelEl()).getByTestId(
      'workgroup-member-displayname-input',
    ) as HTMLInputElement
    expect(reopened.value).toBe('DraftAuditor')
    fireEvent.keyDown(reopened, { key: 'Escape' })
    fireEvent.click(screen.getByTestId('workgroup-card-open-DraftAuditor'))
    expect(
      (within(panelEl()).getByTestId('workgroup-member-displayname-input') as HTMLInputElement)
        .value,
    ).toBe('DraftAuditor')
  })

  test('RFC-201: unfinished add draft survives Close and participates in route guard', async () => {
    installFetch({ workgroups: [wg('squad')], calls: [] })
    const router = await renderPage('/workgroups/wg_squad')
    fireEvent.click(await screen.findByTestId('workgroup-add-agent-member'))
    await pickAgent('coder')
    fireEvent.change(screen.getByTestId('workgroup-member-displayname-input'), {
      target: { value: 'pendingAgent' },
    })
    fireEvent.change(screen.getByTestId('workgroup-member-role-input'), {
      target: { value: 'pending specialist' },
    })
    fireEvent.click(screen.getByTestId('workgroup-panel-close'))
    fireEvent.click(screen.getByTestId('workgroup-add-agent-member'))
    expect(
      (screen.getByTestId('workgroup-member-displayname-input') as HTMLInputElement).value,
    ).toBe('pendingAgent')
    expect((screen.getByTestId('workgroup-member-role-input') as HTMLInputElement).value).toBe(
      'pending specialist',
    )

    void router.navigate({ to: '/workgroups' })
    await screen.findByTestId('unsaved-guard-dialog')
    fireEvent.click(screen.getByTestId('unsaved-stay'))
    await waitFor(() => expect(screen.queryByTestId('unsaved-guard-dialog')).toBeNull())
    expect(router.state.location.pathname).toBe('/workgroups/wg_squad')
    expect(
      (screen.getByTestId('workgroup-member-displayname-input') as HTMLInputElement).value,
    ).toBe('pendingAgent')
  })

  test('RFC-201: route leave offers Stay/Discard for the composite member draft', async () => {
    installFetch({ workgroups: [wg('squad')], calls: [] })
    const router = await renderPage('/workgroups/wg_squad')
    fireEvent.click(await screen.findByTestId('workgroup-card-open-Auditor'))
    fireEvent.change(await within(panelEl()).findByTestId('workgroup-member-role-input'), {
      target: { value: 'locally edited role' },
    })

    void router.navigate({ to: '/workgroups' })
    await screen.findByTestId('unsaved-guard-dialog')
    fireEvent.click(screen.getByTestId('unsaved-stay'))
    await waitFor(() => expect(screen.queryByTestId('unsaved-guard-dialog')).toBeNull())
    expect(router.state.location.pathname).toBe('/workgroups/wg_squad')
    expect((screen.getByTestId('workgroup-member-role-input') as HTMLInputElement).value).toBe(
      'locally edited role',
    )

    const secondNavigation = router.navigate({ to: '/workgroups' })
    await screen.findByTestId('unsaved-guard-dialog')
    fireEvent.click(screen.getByTestId('unsaved-discard'))
    await secondNavigation
    expect(router.state.location.pathname).toBe('/workgroups')
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
              agentId: 'agent-coder',
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
    await renderPage('/workgroups/wg_fc')
    fireEvent.click(await screen.findByTestId('workgroup-card-open-Auditor'))
    await within(panelEl()).findByTestId('workgroup-member-displayname-input')
    expect(within(panelEl()).queryByTestId('workgroup-set-leader-Auditor')).toBeNull()

    cleanup()
    document.body.innerHTML = ''
    await renderPage('/workgroups/wg_dyn')
    await screen.findByTestId('workgroup-card-Coder')
    expect(screen.getByTestId('workgroup-add-agent-member')).toBeTruthy()
    expect(screen.queryByTestId('workgroup-add-human-member')).toBeNull()
  })
})

describe('selection survives id-regenerating PUTs (§9.4, F4)', () => {
  test('member autosave keeps the member selected even though the PUT regenerated every id', async () => {
    const state = { workgroups: [wg('squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    await renderPage('/workgroups/wg_squad')
    fireEvent.click(await screen.findByTestId('workgroup-card-open-Auditor'))
    const input = (await within(panelEl()).findByTestId(
      'workgroup-member-displayname-input',
    )) as HTMLInputElement
    fireEvent.change(input, { target: { value: '审计员' } })
    expect(within(panelEl()).queryByTestId('workgroup-member-save')).toBeNull()
    await waitForPut(state)
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
    await renderPage('/workgroups/wg_squad')
    fireEvent.click(await screen.findByTestId('workgroup-add-agent-member'))
    await screen.findByTestId('workgroup-panel-add')
    await pickAgent('coder')
    // hand-edit the alias to a PADDED value — trim()s pass validation and the
    // wire sends the trimmed form (F4).
    fireEvent.change(screen.getByTestId('workgroup-member-displayname-input'), {
      target: { value: ' rev ' },
    })
    fireEvent.click(screen.getByTestId('workgroup-add-agent-confirm'))
    await waitForPut(state)
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
    await renderPage('/workgroups/wg_squad')
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
    const put = await waitForPut(state)
    const members = savedSnapshot(put).members
    expect(members[members.length - 1]).toEqual({
      memberType: 'human',
      userId: 'u2',
      displayName: 'Bobby',
      roleDesc: 'PM',
    })
  })
})

describe('capability summary (§9.6, F6)', () => {
  test('agent cards render an N-ports count badge + roleDesc; humans get no ports badge; the panel shows the full card + edit link', async () => {
    installFetch({ workgroups: [wg('squad')], calls: [] })
    await renderPage('/workgroups/wg_squad')
    const coder = await screen.findByTestId('workgroup-card-Coder')
    // RFC-171: the narrow rail card shows an "N ports" COUNT badge (the full
    // per-port list lives in the panel's capability card). coder = 1 input +
    // 2 outputs = 3 ports.
    await waitFor(() =>
      expect(within(coder).getByTestId('workgroup-card-ports-count').textContent).toContain(
        '3 ports',
      ),
    )
    // roleDesc is kept on the card (RFC-171 only collapsed the per-port chips).
    expect(within(coder).getByText('writes code')).toBeTruthy()
    // auditor = 5 inputs + 1 output = 6 ports
    const auditor = screen.getByTestId('workgroup-card-Auditor')
    expect(within(auditor).getByTestId('workgroup-card-ports-count').textContent).toContain(
      '6 ports',
    )
    // human card carries no ports badge
    const alice = screen.getByTestId('workgroup-card-Alice')
    expect(within(alice).queryByTestId('workgroup-card-ports-count')).toBeNull()
    // member-type tinting mirrors the canvas palette (user 2026-07-11):
    // agent cards ↔ canvas-node--agent accent, human cards ↔ the amber
    // human-in-the-loop family (RFC-171: `.workgroup-mcard--{type}`).
    expect(coder.classList.contains('workgroup-mcard--agent')).toBe(true)
    expect(alice.classList.contains('workgroup-mcard--human')).toBe(true)

    // panel: full capability card + the edit-agent-definition jump link
    fireEvent.click(screen.getByTestId('workgroup-card-open-Coder'))
    await within(panelEl()).findByTestId('capability-card-coder')
    const link = within(panelEl()).getByTestId('workgroup-edit-agent-link')
    expect(link.getAttribute('href')).toBe('/agents/agent-coder')
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
              agentId: 'agent-ghost',
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
    await renderPage('/workgroups/wg_squad')
    const card = await screen.findByTestId('workgroup-card-Ghost')
    await waitFor(() =>
      expect(within(card).getByTestId('workgroup-card-agent-missing')).toBeTruthy(),
    )

    cleanup()
    document.body.innerHTML = ''
    installFetch({ workgroups: [wg('squad')], calls: [] }, { agents: 500 })
    await renderPage('/workgroups/wg_squad')
    const coder = await screen.findByTestId('workgroup-card-Coder')
    // degraded: no warn chip, no ports — but the member editor still works
    expect(within(coder).queryByTestId('workgroup-card-agent-missing')).toBeNull()
    expect(within(coder).queryByTestId('workgroup-card-ports-count')).toBeNull()
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
    await renderPage('/workgroups/wg_squad')
    // The page renders (no error boundary), cards degrade to no summary and
    // no dangling-agent warning (the list never "loaded" as an array).
    const coder = await screen.findByTestId('workgroup-card-Coder')
    expect(within(coder).queryByTestId('workgroup-card-agent-missing')).toBeNull()
    expect(within(coder).queryByTestId('workgroup-card-ports-count')).toBeNull()
  })
})

describe('RFC-171 split skin — pinned config entry / mutual exclusion / plural / freeze', () => {
  test('the config entry is pinned ABOVE the member scroll area (never scrolls with cards)', async () => {
    installFetch({ workgroups: [wg('squad')], calls: [] })
    await renderPage('/workgroups/wg_squad')
    const entry = await screen.findByTestId('workgroup-config-entry')
    const scroll = screen.getByTestId('workgroup-member-scroll')
    // the config entry is a SIBLING that precedes the scroll container — it is
    // not a descendant of it, so it can never scroll away with the cards.
    expect(scroll.contains(entry)).toBe(false)
    expect(entry.compareDocumentPosition(scroll) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test('config ↔ member selection is mutually exclusive', async () => {
    installFetch({ workgroups: [wg('squad')], calls: [] })
    await renderPage('/workgroups/wg_squad')
    const entry = await screen.findByTestId('workgroup-config-entry')
    expect(entry.classList.contains('is-selected')).toBe(true)

    // select a member → the config entry deselects, the card selects
    fireEvent.click(screen.getByTestId('workgroup-card-open-Auditor'))
    await within(panelEl()).findByTestId('workgroup-member-displayname-input')
    expect(screen.getByTestId('workgroup-config-entry').classList.contains('is-selected')).toBe(
      false,
    )
    expect(screen.getByTestId('workgroup-card-Auditor').classList.contains('is-selected')).toBe(
      true,
    )

    // click the config entry → back to config, the member deselects
    fireEvent.click(screen.getByTestId('workgroup-config-entry'))
    expect(within(panelEl()).getByTestId('workgroup-field-instructions')).toBeTruthy()
    expect(screen.getByTestId('workgroup-config-entry').classList.contains('is-selected')).toBe(
      true,
    )
    expect(screen.getByTestId('workgroup-card-Auditor').classList.contains('is-selected')).toBe(
      false,
    )
  })

  test('a 1-port agent uses the SINGULAR badge; a 0-port agent renders none', async () => {
    installFetch(
      {
        workgroups: [
          wg('squad', {
            leaderMemberId: null,
            members: [
              {
                id: 'm1',
                memberType: 'agent',
                agentId: 'agent-solo',
                agentName: 'solo',
                userId: null,
                displayName: 'Solo',
                roleDesc: '',
                sortOrder: 0,
              },
              {
                id: 'm2',
                memberType: 'agent',
                agentId: 'agent-bare',
                agentName: 'bare',
                userId: null,
                displayName: 'Bare',
                roleDesc: '',
                sortOrder: 1,
              },
            ],
          }),
        ],
        calls: [],
      },
      {
        agents: [
          {
            id: 'agent-solo',
            name: 'solo',
            description: '',
            role: 'normal',
            inputs: [{ name: 'x', kind: 'string' }],
            outputs: [],
            outputKinds: {},
          },
          {
            id: 'agent-bare',
            name: 'bare',
            description: '',
            role: 'normal',
            inputs: [],
            outputs: [],
            outputKinds: {},
          },
        ],
      },
    )
    await renderPage('/workgroups/wg_squad')
    const solo = await screen.findByTestId('workgroup-card-Solo')
    await waitFor(() =>
      expect(within(solo).getByTestId('workgroup-card-ports-count').textContent).toContain(
        '1 port',
      ),
    )
    // singular: "1 port", never "1 ports"
    expect(within(solo).getByTestId('workgroup-card-ports-count').textContent).not.toContain(
      'ports',
    )
    const bare = screen.getByTestId('workgroup-card-Bare')
    expect(within(bare).queryByTestId('workgroup-card-ports-count')).toBeNull()
  })

  test('RFC-225: panel switching stays available while a member autosave is in flight', async () => {
    const state = { workgroups: [wg('squad')], calls: [] as Recorded['calls'] }
    let releasePut: ((r: Response) => void) | null = null
    let putCount = 0
    installFetch(state, {
      putImpl: () => {
        putCount += 1
        if (putCount > 1) return null
        return new Promise<Response>((resolve) => {
          releasePut = resolve
        })
      },
    })
    await renderPage('/workgroups/wg_squad')
    fireEvent.click(await screen.findByTestId('workgroup-card-open-Auditor'))
    const input = (await within(panelEl()).findByTestId(
      'workgroup-member-displayname-input',
    )) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Auditor2' } })
    const firstPut = await waitForPut(state)
    expect(releasePut).not.toBeNull()

    // Saving never freezes the editor: the user can inspect/configure another
    // panel while the single-flight controller owns the request.
    fireEvent.click(screen.getByTestId('workgroup-config-entry'))
    expect(within(panelEl()).getByTestId('workgroup-field-instructions')).toBeTruthy()
    expect(screen.getByTestId('workgroup-config-entry').classList.contains('is-selected')).toBe(
      true,
    )

    const freshRow = synthesizePutRow(wg('squad'), savedSnapshot(firstPut))
    state.workgroups[0] = freshRow
    releasePut!(
      new Response(JSON.stringify(freshRow), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await waitFor(() => expect(screen.getByTestId('workgroup-card-open-Auditor2')).toBeTruthy())
    await waitFor(() =>
      expect(screen.getByTestId('workgroup-draft-phase').textContent).toContain('Saved'),
    )
  })
})

describe('autosave stays on the page; persistent status never lies (§9.7/9.8, F2)', () => {
  test('debounced autosave keeps the route and every later edit returns to Unsaved', async () => {
    const state = { workgroups: [wg('squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    const router = await renderPage('/workgroups/wg_squad')
    const instr = (await screen.findByTestId('workgroup-field-instructions')) as HTMLTextAreaElement
    fireEvent.change(instr, { target: { value: 'v2' } })
    expect(screen.queryByTestId('workgroup-save-button')).toBeNull()
    expect(screen.getByTestId('workgroup-draft-phase').textContent).toContain('Unsaved')
    await waitForPut(state)
    await waitFor(() =>
      expect(screen.getByTestId('workgroup-draft-phase').textContent).toContain('Saved'),
    )
    expect(router.state.location.pathname).toBe('/workgroups/wg_squad')
    fireEvent.change(screen.getByTestId('workgroup-field-instructions'), {
      target: { value: 'v3' },
    })
    expect(screen.getByTestId('workgroup-draft-phase').textContent).toContain('Unsaved')
  })

  test('editing while a PUT is in flight queues only the latest snapshot', async () => {
    const state = { workgroups: [wg('squad')], calls: [] as Recorded['calls'] }
    let releasePut: ((r: Response) => void) | null = null
    let putCount = 0
    installFetch(state, {
      putImpl: () => {
        putCount += 1
        if (putCount > 1) return null
        return new Promise<Response>((resolve) => {
          releasePut = resolve
        })
      },
    })

    await renderPage('/workgroups/wg_squad')
    fireEvent.change(await screen.findByTestId('workgroup-field-instructions'), {
      target: { value: 'v2' },
    })
    const firstPut = await waitForPut(state)
    expect(releasePut).not.toBeNull()
    fireEvent.change(screen.getByTestId('workgroup-field-instructions'), {
      target: { value: 'v3-during-flight' },
    })

    const firstRow = synthesizePutRow(wg('squad'), savedSnapshot(firstPut))
    releasePut!(
      new Response(JSON.stringify(firstRow), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const secondPut = await waitForPut(state, 2)
    expect(savedSnapshot(secondPut).instructions).toBe('v3-during-flight')
    await waitFor(() =>
      expect(screen.getByTestId('workgroup-draft-phase').textContent).toContain('Saved'),
    )
  })

  test('a newer member edit made in flight is the queued-latest receipt', async () => {
    const state = { workgroups: [wg('squad')], calls: [] as Recorded['calls'] }
    let releasePut: ((response: Response) => void) | null = null
    let putCount = 0
    installFetch(state, {
      putImpl: () => {
        putCount += 1
        if (putCount > 1) return null
        return new Promise<Response>((resolve) => {
          releasePut = resolve
        })
      },
    })
    await renderPage('/workgroups/wg_squad')
    fireEvent.click(await screen.findByTestId('workgroup-card-open-Auditor'))
    const input = (await within(panelEl()).findByTestId(
      'workgroup-member-displayname-input',
    )) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'SubmittedAlias' } })
    const firstPut = await waitForPut(state)
    expect(releasePut).not.toBeNull()

    fireEvent.change(input, { target: { value: 'NewerAlias' } })
    const response = synthesizePutRow(wg('squad'), savedSnapshot(firstPut))
    state.workgroups[0] = response
    releasePut!(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const secondPut = await waitForPut(state, 2)
    expect(savedSnapshot(secondPut).members.map((member) => member.displayName)).toContain(
      'NewerAlias',
    )
    await waitFor(() => expect(screen.getByTestId('workgroup-card-open-NewerAlias')).toBeTruthy())
    await waitFor(() =>
      expect(screen.getByTestId('workgroup-draft-phase').textContent).toContain('Saved'),
    )
  })

  test('a semantically mismatched 200 reconciles to an explicit version conflict', async () => {
    const state = { workgroups: [wg('squad')], calls: [] as Recorded['calls'] }
    installFetch(state, {
      putImpl: (_name, body) => {
        const mismatched = synthesizePutRow(wg('squad'), body)
        mismatched.members[2] = {
          ...mismatched.members[2]!,
          displayName: 'ForeignAlias',
        }
        return new Response(JSON.stringify(mismatched), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    const router = await renderPage('/workgroups/wg_squad')
    fireEvent.change(await screen.findByTestId('workgroup-field-instructions'), {
      target: { value: 'submitted charter' },
    })

    await waitForPut(state)
    await waitFor(
      () =>
        expect(screen.getByTestId('workgroup-draft-phase').textContent).toContain(
          'Version conflict',
        ),
      { timeout: 3_000 },
    )
    expect((screen.getByTestId('workgroup-field-instructions') as HTMLTextAreaElement).value).toBe(
      'submitted charter',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Load remote' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Load remote and discard local changes' }),
    )
    await waitFor(() => expect(screen.getByTestId('workgroup-card-ForeignAlias')).toBeTruthy())
    await waitFor(() =>
      expect(screen.getByTestId('workgroup-draft-phase').textContent).toContain('Saved'),
    )

    await router.navigate({ to: '/workgroups' })
    expect(screen.queryByTestId('unsaved-guard-dialog')).toBeNull()
  })
})

describe('composite PUT failure keeps every member draft (§9.9 / RFC-201)', () => {
  test('definitive error → global status + draft kept across member switch → retry succeeds', async () => {
    const state = { workgroups: [wg('squad')], calls: [] as Recorded['calls'] }
    let failNext = true
    installFetch(state, {
      putImpl: () => {
        if (failNext) {
          failNext = false
          return new Response(JSON.stringify({ code: 'invalid-draft', message: 'try again' }), {
            status: 422,
            headers: { 'content-type': 'application/json' },
          })
        }
        return null // fall through to the synthesizer
      },
    })
    await renderPage('/workgroups/wg_squad')
    fireEvent.click(await screen.findByTestId('workgroup-card-open-Auditor'))
    const input = (await within(panelEl()).findByTestId(
      'workgroup-member-displayname-input',
    )) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Auditrix' } })

    await waitForPut(state)
    await waitFor(() =>
      expect(screen.getByTestId('workgroup-draft-phase').textContent).toContain('Save failed'),
    )
    expect(
      (within(panelEl()).getByTestId('workgroup-member-displayname-input') as HTMLInputElement)
        .value,
    ).toBe('Auditrix')

    // The autosave status owns the complete document, so switching panels
    // never hides the failure or discards the route-owned draft.
    fireEvent.click(screen.getByTestId('workgroup-card-open-Coder'))
    expect(screen.getByTestId('workgroup-draft-phase').textContent).toContain('Save failed')

    fireEvent.click(screen.getByTestId('workgroup-card-open-Auditrix'))
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }))
    await waitForPut(state, 2)
    await waitFor(() => expect(screen.getByTestId('workgroup-card-open-Auditrix')).toBeTruthy())
    await waitFor(() =>
      expect(screen.getByTestId('workgroup-draft-phase').textContent).toContain('Saved'),
    )
  })
})

describe('mode-transition error (§9.12, F3)', () => {
  test('switching to dynamic_workflow with human members blocks autosave until corrected', async () => {
    const state = { workgroups: [wg('squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    await renderPage('/workgroups/wg_squad')
    await screen.findByTestId('workgroup-mode-dynamic_workflow')
    fireEvent.click(screen.getByTestId('workgroup-mode-dynamic_workflow'))
    expect(
      screen.getByText(
        'Dynamic-workflow groups allow agent members only — remove the human members before saving.',
      ),
    ).toBeTruthy()
    expect(screen.queryByTestId('workgroup-save-button')).toBeNull()
    expect(screen.getByTestId('workgroup-draft-phase').textContent).toContain(
      'Waiting for corrections',
    )
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    expect(state.calls.filter((call) => call.method === 'PUT')).toHaveLength(0)
    // switching back clears it
    fireEvent.click(screen.getByTestId('workgroup-mode-leader_worker'))
    expect(
      screen.queryByText(
        'Dynamic-workflow groups allow agent members only — remove the human members before saving.',
      ),
    ).toBeNull()
    await waitFor(() =>
      expect(screen.getByTestId('workgroup-draft-phase').textContent).toContain('Saved'),
    )
  })
})

describe('Codex impl-gate P1/P2 — lost-update and draft-loss guards', () => {
  test('P1: in-flight edits stay interactive but never produce concurrent full-replace PUTs', async () => {
    const state = { workgroups: [wg('squad')], calls: [] as Recorded['calls'] }
    let releasePut: ((r: Response) => void) | null = null
    let putCount = 0
    installFetch(state, {
      putImpl: () => {
        putCount += 1
        if (putCount > 1) return null
        return new Promise<Response>((resolve) => {
          releasePut = resolve
        })
      },
    })
    await renderPage('/workgroups/wg_squad')
    fireEvent.click(await screen.findByTestId('workgroup-card-open-Auditor'))
    fireEvent.change(await within(panelEl()).findByTestId('workgroup-member-displayname-input'), {
      target: { value: 'Auditrix' },
    })
    const firstPut = await waitForPut(state)
    expect(releasePut).not.toBeNull()

    fireEvent.click(screen.getByTestId('workgroup-card-open-Coder'))
    const coderInput = within(panelEl()).getByTestId(
      'workgroup-member-displayname-input',
    ) as HTMLInputElement
    expect(coderInput.value).toBe('Coder')
    fireEvent.change(coderInput, { target: { value: 'Builder' } })
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    expect(state.calls.filter((call) => call.method === 'PUT')).toHaveLength(1)

    const freshRow = synthesizePutRow(wg('squad'), savedSnapshot(firstPut))
    state.workgroups[0] = freshRow
    releasePut!(
      new Response(JSON.stringify(freshRow), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const secondPut = await waitForPut(state, 2)
    expect(savedSnapshot(secondPut).members.map((member) => member.displayName)).toEqual([
      'Builder',
      'Alice',
      'Auditrix',
    ])
    await waitFor(() => expect(screen.getByTestId('workgroup-card-open-Builder')).toBeTruthy())
  })

  test('RFC-225: config + member edits coalesce into one composite autosave', async () => {
    const state = { workgroups: [wg('squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    await renderPage('/workgroups/wg_squad')
    const instr = (await screen.findByTestId('workgroup-field-instructions')) as HTMLTextAreaElement
    fireEvent.change(instr, { target: { value: 'v2' } })
    fireEvent.click(screen.getByTestId('workgroup-card-open-Auditor'))
    const input = (await within(panelEl()).findByTestId(
      'workgroup-member-displayname-input',
    )) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'DraftName' } })

    const put = await waitForPut(state)
    expect(savedSnapshot(put).instructions).toBe('v2')
    expect(savedSnapshot(put).members.map((member) => member.displayName)).toEqual([
      'Coder',
      'Alice',
      'DraftName',
    ])
    await waitFor(() => {
      expect(
        (within(panelEl()).getByTestId('workgroup-member-displayname-input') as HTMLInputElement)
          .value,
      ).toBe('DraftName')
    })
    await waitFor(() =>
      expect(screen.getByTestId('workgroup-draft-phase').textContent).toContain('Saved'),
    )
  })

  test('P2: set-leader does not clobber a dirty alias draft (content-keyed body survives id churn)', async () => {
    const state = { workgroups: [wg('squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    await renderPage('/workgroups/wg_squad')
    fireEvent.click(await screen.findByTestId('workgroup-card-open-Auditor'))
    const input = (await within(panelEl()).findByTestId(
      'workgroup-member-displayname-input',
    )) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'DirtyAlias' } })

    fireEvent.click(within(panelEl()).getByTestId('workgroup-set-leader-DirtyAlias'))
    const put = await waitForPut(state)
    expect(savedSnapshot(put).leaderDisplayName).toBe('DirtyAlias')
    expect(savedSnapshot(put).members.map((member) => member.displayName)).toContain('DirtyAlias')
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
    await renderPage('/workgroups/wg_squad')
    fireEvent.click(await screen.findByTestId('workgroup-card-open-Alice'))
    const panel = panelEl()
    const remove = await within(panel).findByRole('button', { name: 'Remove' })
    fireEvent.click(remove)
    fireEvent.click(within(panel).getByRole('button', { name: 'Confirm?' }))
    await waitFor(() => {
      expect(within(panelEl()).getByTestId('workgroup-field-instructions')).toBeTruthy()
    })
    // Alice was index 1 → the (new) index-1 member is Auditor.
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('workgroup-card-open-Auditor'))
    })
  })
})

describe('RFC-171 split skin — source locks (design-gate Codex#1/#3 · R2 Nit A/B)', () => {
  test('the detail page uses the `.split` skin, not the retired `.workgroup-studio` layout', () => {
    const src = readSrc('routes/workgroups.detail.tsx')
    expect(src).toContain('page page--split')
    expect(src).toContain('split__list')
    expect(src).toContain('split__detail')
    // the studio layout is gone (prevents a silent regression back to it)
    expect(src).not.toContain('workgroup-studio')
    expect(src).not.toContain('page--studio')
    // blank-area deselect uses the robust [data-member-key] selector, not the
    // old `.workgroup-card` class it renamed away from (R2 Nit A)
    expect(src).toContain("closest('[data-member-key], button, a, input')")
  })

  test('the stretched hit-area mechanism is intact (position:relative + ::after inset:0)', () => {
    // happy-dom (css:false) cannot hit-test `::after`, so lock the MECHANISM at
    // the source (design-gate R2 Nit B): the card root is positioned and the
    // title button's ::after covers it.
    const css = readSrc('styles.css')
    expect(css).toMatch(/\.workgroup-mcard\s*\{[^}]*position:\s*relative/)
    expect(css).toMatch(/\.workgroup-card__open::after\s*\{[^}]*position:\s*absolute/)
    expect(css).toMatch(/\.workgroup-card__open::after\s*\{[^}]*inset:\s*0/)
  })

  test('the autosave labels and every notice bar share one spaced status stack above config', () => {
    const route = readSrc('routes/workgroups.detail.tsx')
    const css = readSrc('styles.css')

    expect(route).toContain('className="workgroup-editor-status-stack"')
    expect(route).toContain('data-testid="workgroup-status-stack"')
    expect(css).toMatch(
      /\.workgroup-editor-status-stack\s*\{[^}]*display:\s*grid;[^}]*gap:\s*var\(--space-2\);[^}]*margin-block-end:\s*var\(--space-3\);/s,
    )
    expect(css).toMatch(
      /\.workgroup-editor-status-stack\s*>\s*\.workflow-draft-status\s*\{[^}]*display:\s*grid;[^}]*gap:\s*var\(--space-2\);/s,
    )
  })
})
