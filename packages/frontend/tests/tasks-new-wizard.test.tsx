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

    // Step 1 — Next gated until an object is picked; builtin workflows hidden (W8).
    expect((screen.getByTestId('stepper-next') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(await screen.findByTestId('wizard-object-workflow'))
    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).queryByText('__agent_host__')).toBeNull()
    fireEvent.mouseDown(within(listbox).getByRole('option', { name: /My WF/ }))
    expect((screen.getByTestId('stepper-next') as HTMLButtonElement).disabled).toBe(false)
    next()

    // Step 2 — remote by default; Next gated until the URL parses (W4).
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
    expect(post.body).toEqual({
      name: 'TA',
      description: 'fix the flaky test',
      scratch: true,
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
    fireEvent.mouseDown(within(listbox).getByRole('option', { name: /core/ }))
    next()

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
