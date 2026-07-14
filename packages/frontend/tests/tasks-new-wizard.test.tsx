// LOCKS: RFC-165 T12 (§11.22 / §11.25) — the /tasks/new unified wizard.
//
//   W1 workflow arm end-to-end: pick → remote URL → name+inputs → confirm →
//      POST /api/tasks with the composed body, then navigate to the task.
//   W2 agent deep link (?kind=agent&agent=…) lands on Step 2; scratch space;
//      POSTs /api/agents/:name/tasks with scratch:true + description.
//   W3 workgroup arm POSTs /api/workgroups/:name/tasks with goal; a not-ready
//      group renders as a disabled option (Step-1 filtering).
//   W4 gating: object/URL/name gates hold Next disabled per step.
//   W5 confirm-page backlinks jump to the owning step.
//   W6 ?schedule=1 swaps the primary/secondary actions and saving creates the
//      schedule with the agent kind envelope (launchKind + agentName).
//   W7 ?editScheduled seeds a kind-locked, fully pre-filled wizard and PUTs
//      the rebuilt payload back.
//   W8 Step-1 filtering: builtin workflows/agents never appear as options.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { setBaseUrl, setToken } from '../src/stores/auth'
import '../src/i18n'

vi.mock('../src/hooks/useActor', () => ({
  useActor: () => ({
    data: {
      user: { id: 'me', username: 'me', displayName: 'Me', role: 'user', status: 'active' },
      source: 'session',
      permissions: [],
      linkedIdentities: [],
      pats: [],
    },
  }),
  usePermission: () => false,
}))

interface FetchCall {
  url: string
  method: string
  body: unknown
}

const WF_DETAIL = {
  id: 'wf-1',
  name: 'My WF',
  definition: {
    inputs: [{ key: 'topic', label: 'Topic', kind: 'text', required: true }],
    nodes: [],
  },
}
const WORKFLOWS = [
  { id: 'wf-1', name: 'My WF' },
  { id: 'wf-host', name: '__agent_host__', builtin: true },
]
const AGENTS = [{ name: 'auditor' }, { name: '__sys_reviewer__', builtin: true }]
const WORKGROUPS = [
  {
    name: 'core',
    mode: 'free_collab',
    leaderMemberId: null,
    members: [{ id: 'm1', memberType: 'agent' }],
  },
  { name: 'hollow', mode: 'free_collab', leaderMemberId: null, members: [] },
  // RFC-187 TRAP-1 advisory tier — launchable but leader-only (Codex P2:
  // the wizard must surface the warning, not just the detail-page banner).
  {
    name: 'solo',
    mode: 'leader_worker',
    leaderMemberId: 'm1',
    members: [{ id: 'm1', memberType: 'agent' }],
  },
]

const SCHEDULE_AGENT = {
  id: 'sched-a',
  name: 'nightly audit',
  ownerUserId: 'me',
  launchKind: 'agent',
  launchPayload: {
    agentName: 'auditor',
    name: 'nightly',
    description: 'audit the repo',
    allowClarify: false,
    scratch: true,
    // Codex P2 lock: a NON-whole-minute limit must survive a no-op save
    // byte-exactly (the wizard keeps fractional minutes in state).
    maxDurationMs: 123456,
  },
  scheduleSpec: { kind: 'daily', at: '09:00', timezone: 'UTC' },
  enabled: true,
  nextRunAt: null,
  lastRunAt: null,
  lastStatus: null,
  lastError: null,
  lastTaskId: null,
  consecutiveFailures: 0,
  createdAt: 1,
  updatedAt: 1,
}

// RFC-175 relaunch source: a completed agent/scratch task whose params the
// wizard reconstructs from persisted columns (no schedule row involved).
const RELAUNCH_TASK = {
  id: 'relaunch-task',
  name: 'prior audit',
  status: 'done',
  spaceKind: 'scratch',
  repos: [],
  repoCount: 1,
  inputs: { description: 'audit the auth module' },
  sourceAgentName: 'auditor',
  sourceAgentId: null,
  workgroupId: null,
  workgroupName: null,
  goal: null,
  workflowId: null,
  workflowSnapshot: { nodes: [{ kind: 'agent-single' }] },
  errorSummary: null,
  errorMessage: null,
  failedNodeId: null,
  gitUserName: null,
  gitUserEmail: null,
  workingBranch: null,
  autoCommitPush: false,
  maxDurationMs: null,
  maxTotalTokens: null,
}
const RELAUNCH_MEMBERS = {
  owner: { id: 'me', username: 'me', displayName: 'Me', role: 'user', status: 'active' },
  users: [],
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  window.localStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function installFetch(): FetchCall[] {
  const calls: FetchCall[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString()
      const method = init?.method ?? 'GET'
      let body: unknown = undefined
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body)
        } catch {
          body = init.body
        }
      }
      calls.push({ url, method, body })
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      if (url.includes('/api/scheduled-tasks/sched-a') && method === 'PUT')
        return json({ ...SCHEDULE_AGENT, updatedAt: 2 })
      if (url.includes('/api/scheduled-tasks/sched-a')) return json(SCHEDULE_AGENT)
      if (url.includes('/api/scheduled-tasks') && method === 'POST')
        return json({ id: 'sched-new' }, 201)
      if (url.includes('/api/tasks/relaunch-task/members')) return json(RELAUNCH_MEMBERS)
      if (url.includes('/api/tasks/relaunch-task')) return json(RELAUNCH_TASK)
      if (url.includes('/api/users/lookup')) return json([])
      if (url.includes('/api/cached-repos')) return json({ items: [] })
      if (url.includes('/api/workflows/wf-1')) return json(WF_DETAIL)
      if (url.includes('/api/workflows')) return json(WORKFLOWS)
      if (url.includes('/api/agents/auditor/tasks') && method === 'POST')
        return json({ id: 'task-a' }, 201)
      if (url.includes('/api/agents')) return json(AGENTS)
      if (url.includes('/api/workgroups/core/tasks') && method === 'POST')
        return json({ id: 'task-g' }, 201)
      if (url.includes('/api/workgroups')) return json(WORKGROUPS)
      if (url.endsWith('/api/tasks') && method === 'POST') return json({ id: 'task-w' }, 201)
      return json({})
    },
  )
  return calls
}

async function renderWizard(initialUrl: string) {
  const mod = await import('../src/routes/tasks.new')
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const wizard = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks/new',
    component: mod.TaskWizardRoute.options.component,
    validateSearch: mod.TaskWizardRoute.options.validateSearch,
  })
  const taskPage = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks/$id',
    component: () => <div data-testid="task-page" />,
  })
  const scheduledDetail = createRoute({
    getParentRoute: () => rootRoute,
    path: '/scheduled/$id',
    component: () => <div data-testid="scheduled-detail-page" />,
  })
  const scheduledList = createRoute({
    getParentRoute: () => rootRoute,
    path: '/scheduled',
    component: () => <div data-testid="scheduled-list-page" />,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([wizard, taskPage, scheduledDetail, scheduledList]),
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  // Router mount is async — wait for the wizard shell before interacting.
  await screen.findByTestId('task-wizard')
}

const next = () => fireEvent.click(screen.getByTestId('stepper-next'))

describe('RFC-165 T12 — /tasks/new wizard', () => {
  test('W1+W4+W5: workflow arm — gating, backlink, launch POST /api/tasks', async () => {
    const calls = installFetch()
    await renderWizard('/tasks/new')

    // Step 1 — the default kind is now AGENT (用户 2026-07-11); switch to
    // workflow first. Next gated until an object is picked; builtin
    // workflows hidden (W8).
    fireEvent.click(await screen.findByTestId('wizard-kind-workflow'))
    expect((screen.getByTestId('stepper-next') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(await screen.findByTestId('wizard-object-workflow'))
    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).queryByText('__agent_host__')).toBeNull()
    fireEvent.mouseDown(within(listbox).getByRole('option', { name: /My WF/ }))
    expect((screen.getByTestId('stepper-next') as HTMLButtonElement).disabled).toBe(false)
    next()

    // Step 2 — scratch is the default space now; pick remote, then Next is
    // gated until the URL parses (W4).
    fireEvent.click(await screen.findByTestId('wizard-space-remote'))
    expect((screen.getByTestId('stepper-next') as HTMLButtonElement).disabled).toBe(true)
    const urlInput = await screen.findByTestId('repo-source-url-0')
    fireEvent.change(urlInput, { target: { value: 'https://github.com/o/r.git' } })
    expect((screen.getByTestId('stepper-next') as HTMLButtonElement).disabled).toBe(false)
    next()

    // Step 3 — name + required input gate Next.
    expect((screen.getByTestId('stepper-next') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(await screen.findByTestId('wizard-task-name'), { target: { value: 'T1' } })
    // The required 'topic' input — Field wraps children in <label>.
    fireEvent.change(await screen.findByLabelText(/Topic \(topic\)/), {
      target: { value: 'hello' },
    })
    await waitFor(() =>
      expect((screen.getByTestId('stepper-next') as HTMLButtonElement).disabled).toBe(false),
    )
    next()

    // Step 4 — summary shows the picks; backlink returns to Step 2 (W5).
    expect(screen.getByTestId('wizard-summary-space').textContent).toContain(
      'https://github.com/o/r.git',
    )
    fireEvent.click(screen.getByTestId('wizard-summary-edit-1'))
    expect(await screen.findByTestId('wizard-space-remote')).toBeTruthy()
    fireEvent.click(screen.getByTestId('stepper-step-confirm')) // visited → clickable
    fireEvent.click(await screen.findByTestId('wizard-launch'))

    await waitFor(() => expect(screen.queryByTestId('task-page')).toBeTruthy())
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/tasks'))!
    expect(post.body).toEqual({
      workflowId: 'wf-1',
      name: 'T1',
      inputs: { topic: 'hello' },
      repoUrl: 'https://github.com/o/r.git',
      // RFC-075 pref default: auto commit&push starts ON.
      autoCommitPush: true,
    })
  })

  test('W2: agent deep link lands on Step 2; scratch launch hits the agent endpoint', async () => {
    const calls = installFetch()
    await renderWizard('/tasks/new?kind=agent&agent=auditor')

    // Deep link (D9): starts on the space step with the object pre-picked.
    const spaceStep = await screen.findByTestId('stepper-step-space')
    expect(spaceStep.getAttribute('aria-current')).toBe('step')

    fireEvent.click(screen.getByTestId('wizard-space-scratch'))
    expect(await screen.findByTestId('wizard-scratch-hint')).toBeTruthy()
    next()

    fireEvent.change(await screen.findByTestId('wizard-task-name'), { target: { value: 'TA' } })
    expect((screen.getByTestId('stepper-next') as HTMLButtonElement).disabled).toBe(true) // description required
    fireEvent.change(screen.getByTestId('wizard-description'), {
      target: { value: 'fix the flaky test' },
    })
    next()

    // Scratch + defaults: the advanced summary row must NOT render just
    // because the autoCommitPush pref defaults ON (it is remote-only).
    expect(screen.queryByTestId('wizard-summary-advanced')).toBeNull()

    fireEvent.click(await screen.findByTestId('wizard-launch'))
    await waitFor(() => expect(screen.queryByTestId('task-page')).toBeTruthy())
    const post = calls.find(
      (c) => c.method === 'POST' && c.url.includes('/api/agents/auditor/tasks'),
    )!
    // 单 agent 全新启动默认「不允许反问」（用户 2026-07-14, tasks.new.tsx allowClarify=false）：
    // the fresh clarify switch is OFF, so buildAgentStartBody stamps allowClarify:false on the
    // wire (the switch was never touched here). Locks the flipped default at the wire level.
    expect(post.body).toEqual({
      name: 'TA',
      description: 'fix the flaky test',
      scratch: true,
      allowClarify: false,
    })
  })

  // RFC-175 (impl-gate F1-followup-2): a relaunch (?relaunchFrom=) reconstructs
  // the full launch params from the SOURCE TASK's persisted columns and can
  // re-fire. The submit gate opens only after the seed effect applies
  // (relaunchApplied) — so a successful launch here proves the seed reached the
  // wire, not the empty default form.
  test('W13: relaunch (?relaunchFrom) reconstructs the source task and re-launches with the seeded body', async () => {
    const calls = installFetch()
    await renderWizard('/tasks/new?relaunchFrom=relaunch-task')

    // Seed lands the wizard on Step 1 with agent + scratch + description
    // pre-filled; Next only enables once the object seeds in (relaunchApplied).
    await waitFor(() =>
      expect((screen.getByTestId('stepper-next') as HTMLButtonElement).disabled).toBe(false),
    )
    next() // mode → space (scratch seeded)
    next() // space → content (name + description seeded)
    next() // content → confirm
    fireEvent.click(await screen.findByTestId('wizard-launch'))
    await waitFor(() => expect(screen.queryByTestId('task-page')).toBeTruthy())

    const post = calls.find(
      (c) => c.method === 'POST' && c.url.includes('/api/agents/auditor/tasks'),
    )!
    // Reconstructed from the task: name + description + scratch, and allowClarify
    // false (the agent-single snapshot proves clarify was off). No expectedAgentId
    // — a historical task (sourceAgentId null) launches by name.
    expect(post.body).toEqual({
      name: 'prior audit',
      description: 'audit the auth module',
      scratch: true,
      allowClarify: false,
    })
  })

  test('W3: workgroup arm — not-ready group disabled; goal launch hits the group endpoint', async () => {
    const calls = installFetch()
    await renderWizard('/tasks/new')

    fireEvent.click(screen.getByTestId('wizard-kind-workgroup'))
    fireEvent.click(await screen.findByTestId('wizard-object-workgroup'))
    const listbox = await screen.findByRole('listbox')
    const hollow = within(listbox).getByRole('option', { name: /hollow/ })
    expect(hollow.getAttribute('aria-disabled')).toBe('true')
    // RFC-187 TRAP-1 (Codex P2): leader-only roster stays SELECTABLE but the
    // option carries the advisory copy — the wizard shares the same readiness
    // oracle as the detail-page banner.
    const solo = within(listbox).getByRole('option', { name: /solo/ })
    expect(solo.getAttribute('aria-disabled')).not.toBe('true')
    expect(solo.textContent).toContain('Roster is leader-only')
    fireEvent.mouseDown(within(listbox).getByRole('option', { name: /core/ }))
    next()

    fireEvent.click(await screen.findByTestId('wizard-space-remote'))
    fireEvent.change(await screen.findByTestId('repo-source-url-0'), {
      target: { value: 'https://github.com/o/r.git' },
    })
    next()

    fireEvent.change(await screen.findByTestId('wizard-task-name'), { target: { value: 'TG' } })
    fireEvent.change(screen.getByTestId('wizard-goal'), { target: { value: 'ship the feature' } })
    next()

    fireEvent.click(await screen.findByTestId('wizard-launch'))
    await waitFor(() => expect(screen.queryByTestId('task-page')).toBeTruthy())
    const post = calls.find(
      (c) => c.method === 'POST' && c.url.includes('/api/workgroups/core/tasks'),
    )!
    expect(post.body).toEqual({
      name: 'TG',
      goal: 'ship the feature',
      repoUrl: 'https://github.com/o/r.git',
      autoCommitPush: true,
    })
  })

  test('W6: ?schedule=1 makes save-as-scheduled primary and stamps the agent envelope', async () => {
    const calls = installFetch()
    await renderWizard('/tasks/new?schedule=1&kind=agent&agent=auditor')

    // Deep link lands on Step 2 — pick scratch and move on.
    fireEvent.click(await screen.findByTestId('wizard-space-scratch'))
    next()
    fireEvent.change(await screen.findByTestId('wizard-task-name'), { target: { value: 'TS' } })
    fireEvent.change(screen.getByTestId('wizard-description'), { target: { value: 'poll it' } })
    next()

    // Primary (btn--primary) is save-as-scheduled; launch is secondary.
    const saveBtn = await screen.findByTestId('wizard-save-scheduled')
    expect(saveBtn.className).toContain('btn--primary')
    expect(screen.getByTestId('wizard-launch').className).not.toContain('btn--primary')

    fireEvent.click(saveBtn)
    fireEvent.change(await screen.findByTestId('schedule-name'), { target: { value: 'poller' } })
    fireEvent.click(screen.getByTestId('schedule-save'))

    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/scheduled-tasks'))
      expect(post).toBeTruthy()
      expect(post!.body).toMatchObject({
        name: 'poller',
        launchKind: 'agent',
        launchPayload: { agentName: 'auditor', name: 'TS', description: 'poll it', scratch: true },
        enabled: true,
      })
    })
  })

  test('W7: ?editScheduled seeds a kind-locked wizard and PUTs the rebuilt payload', async () => {
    const calls = installFetch()
    await renderWizard('/tasks/new?editScheduled=sched-a')

    // Seeds land: kind locked to agent, fields pre-filled, all steps reachable.
    expect(await screen.findByText(/编辑定时任务配置|Edit schedule config/)).toBeTruthy()
    // Seeding lands on Step 2 — go back to Step 1 to check the lock.
    fireEvent.click(await screen.findByTestId('stepper-step-mode'))
    const kindSeg = await screen.findByTestId('wizard-kind-agent')
    await waitFor(() => expect(kindSeg.getAttribute('aria-checked')).toBe('true'))
    expect((kindSeg as HTMLButtonElement).disabled).toBe(true)
    // Codex P1: only the KIND locks — the object selector stays usable so a
    // degraded seed can be repaired / repointed within the same kind.
    expect((screen.getByTestId('wizard-object-agent') as HTMLButtonElement).disabled).toBe(false)

    // Jump straight to confirm (fully seeded → reachable) and save.
    fireEvent.click(screen.getByTestId('stepper-step-confirm'))
    const save = await screen.findByTestId('wizard-save-config')
    fireEvent.click(save)

    await waitFor(() => {
      const put = calls.find(
        (c) => c.method === 'PUT' && c.url.endsWith('/api/scheduled-tasks/sched-a'),
      )
      expect(put).toBeTruthy()
      expect((put!.body as { launchPayload: unknown }).launchPayload).toEqual({
        agentName: 'auditor',
        name: 'nightly',
        description: 'audit the repo',
        allowClarify: false,
        scratch: true,
        maxDurationMs: 123456,
      })
    })
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/tasks'))).toBe(false)
    await waitFor(() => expect(screen.queryByTestId('scheduled-detail-page')).toBeTruthy())
  })

  test('W8: builtin agents are filtered out of the object picker', async () => {
    installFetch()
    await renderWizard('/tasks/new?kind=agent')

    // kind param without an object → still Step 1, agent pre-selected.
    expect((await screen.findByTestId('wizard-kind-agent')).getAttribute('aria-checked')).toBe(
      'true',
    )
    fireEvent.click(await screen.findByTestId('wizard-object-agent'))
    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).queryByText('__sys_reviewer__')).toBeNull()
    expect(within(listbox).getByRole('option', { name: /auditor/ })).toBeTruthy()
  })

  test('W11: invalid numeric limits gate the content step (Codex P2)', async () => {
    installFetch()
    await renderWizard('/tasks/new?kind=agent&agent=auditor')
    fireEvent.click(await screen.findByTestId('wizard-space-scratch'))
    next()
    fireEvent.change(await screen.findByTestId('wizard-task-name'), { target: { value: 'T' } })
    fireEvent.change(screen.getByTestId('wizard-description'), { target: { value: 'd' } })
    expect((screen.getByTestId('stepper-next') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.change(screen.getByTestId('wizard-max-tokens'), { target: { value: '2.5' } })
    expect(screen.getByTestId('wizard-limits-error')).toBeTruthy()
    expect((screen.getByTestId('stepper-next') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByTestId('wizard-max-tokens'), { target: { value: '2000' } })
    expect((screen.getByTestId('stepper-next') as HTMLButtonElement).disabled).toBe(false)
  })

  test('W12: defaults — agent kind pre-selected, scratch space, clarify switch outside the advanced fold (用户 2026-07-11)', async () => {
    installFetch()
    await renderWizard('/tasks/new')

    // Agent is the default kind and the first option.
    const agentSeg = await screen.findByTestId('wizard-kind-agent')
    expect(agentSeg.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(await screen.findByTestId('wizard-object-agent'))
    fireEvent.mouseDown(await screen.findByRole('option', { name: /auditor/ }))
    next()

    // Scratch is the default space.
    expect(await screen.findByTestId('wizard-scratch-hint')).toBeTruthy()
    next()

    // The clarify switch renders in the main content block, NOT inside the
    // advanced <details> fold.
    const clarify = await screen.findByText(/允许反问|Allow follow-up questions/)
    expect(clarify.closest('details')).toBeNull()

    // 单 agent 全新启动默认「不允许反问」（用户 2026-07-14）——开关默认未勾选，用户可按需打开。
    const clarifySwitch = screen.getByRole('checkbox', {
      name: /允许反问|Allow follow-up questions/,
    })
    expect((clarifySwitch as HTMLInputElement).checked).toBe(false)
  })

  // 单 agent 反问默认关（用户 2026-07-14）后，确认页「高级」摘要改为「偏离默认才提示」：
  // 默认关 → 不显示（W2 断言 scratch+默认无高级行）；用户「打开」反问才显示「Follow-up
  // questions on」。同时验证 ON ⇒ buildAgentStartBody 省略 allowClarify（omit-on-true 契约，
  // 后端 default(true) 承接），与 W2 的 OFF ⇒ 显式 false 互为镜像。
  test('W14: opting INTO clarify surfaces in the confirm summary + omits allowClarify on the wire', async () => {
    const calls = installFetch()
    await renderWizard('/tasks/new?kind=agent&agent=auditor')

    fireEvent.click(await screen.findByTestId('wizard-space-scratch'))
    next()

    fireEvent.change(await screen.findByTestId('wizard-task-name'), { target: { value: 'TC' } })
    fireEvent.change(screen.getByTestId('wizard-description'), { target: { value: 'ask me' } })
    // Turn the (now-off-by-default) clarify switch ON.
    const clarifySwitch = screen.getByRole('checkbox', {
      name: /允许反问|Allow follow-up questions/,
    })
    fireEvent.click(clarifySwitch)
    expect((clarifySwitch as HTMLInputElement).checked).toBe(true)
    next()

    // The advanced summary row now renders BECAUSE clarify was opted into.
    const advanced = await screen.findByTestId('wizard-summary-advanced')
    expect(advanced.textContent).toMatch(/反问已开启|Follow-up questions on/)

    fireEvent.click(await screen.findByTestId('wizard-launch'))
    await waitFor(() => expect(screen.queryByTestId('task-page')).toBeTruthy())
    const post = calls.find(
      (c) => c.method === 'POST' && c.url.includes('/api/agents/auditor/tasks'),
    )!
    // ON ⇒ omitted (RFC-175 wire anchor: absent ⟺ true; backend default(true) applies).
    expect(post.body).toEqual({ name: 'TC', description: 'ask me', scratch: true })
    expect('allowClarify' in (post.body as object)).toBe(false)
  })

  test('W10: a 422 workgroup-not-ready launch renders the friendly reason copy', async () => {
    const calls = installFetch()
    // Override just the workgroup launch POST with a 422 (migrated from the
    // retired /workgroups/launch page test — same copy contract).
    const base = vi.mocked(globalThis.fetch).getMockImplementation()!
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = input.toString()
      if (url.includes('/api/workgroups/core/tasks') && (init?.method ?? 'GET') === 'POST') {
        calls.push({ url, method: 'POST', body: JSON.parse(String(init?.body)) })
        return new Response(
          JSON.stringify({
            ok: false,
            code: 'workgroup-not-ready',
            message: 'workgroup is not launch-ready',
            details: { reasons: ['leader-missing'] },
          }),
          { status: 422, headers: { 'content-type': 'application/json' } },
        )
      }
      return base(input, init)
    })
    await renderWizard('/tasks/new?kind=workgroup&workgroup=core')

    fireEvent.click(await screen.findByTestId('wizard-space-scratch'))
    next()
    fireEvent.change(await screen.findByTestId('wizard-task-name'), { target: { value: 'TG' } })
    fireEvent.change(screen.getByTestId('wizard-goal'), { target: { value: 'g' } })
    next()
    fireEvent.click(await screen.findByTestId('wizard-launch'))

    const errorEl = await screen.findByTestId('wizard-submit-error')
    // Friendly localized copy, not the raw code.
    expect(errorEl.textContent).not.toContain('workgroup-not-ready')
    expect(errorEl.textContent?.length ?? 0).toBeGreaterThan(0)
  })
})
