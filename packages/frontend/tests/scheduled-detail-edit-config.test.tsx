// RFC-159 (edit-config) — the scheduled-task detail page exposes an
// "编辑任务配置 / Edit task config" entry that opens the wizard in edit
// mode (?editScheduled=<id>) targeting the schedule's workflow. Locks: the link
// renders and points at /tasks/new?editScheduled=<id> (RFC-165 wizard).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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

vi.mock('../src/hooks/useScheduledTaskWs', () => ({ useScheduledTaskWs: () => undefined }))

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const SCHEDULE = {
  id: 'sched-1',
  name: 'nightly audit',
  ownerUserId: 'bob',
  launchPayload: { workflowId: 'wf-42', name: 'nightly', repoUrl: 'https://h/o/r.git' },
  scheduleSpec: { kind: 'daily', at: '09:00', timezone: 'UTC' },
  enabled: true,
  nextRunAt: Date.now() + 1000,
  lastRunAt: null,
  lastStatus: null,
  lastError: null,
  lastTaskId: null,
  consecutiveFailures: 0,
  createdAt: 1,
  updatedAt: 1,
}

function installFetch(schedule: Record<string, unknown> = SCHEDULE) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = input.toString()
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    if (url.includes('/api/tasks')) return json([]) // run history
    if (url.includes('/api/scheduled-tasks/sched-1')) return json(schedule)
    return json({})
  })
}

async function renderDetail() {
  const mod = await import('../src/routes/scheduled.$id')
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const detail = createRoute({
    getParentRoute: () => rootRoute,
    path: '/scheduled/$id',
    component: mod.Route.options.component,
  })
  // Register the wizard route so the edit-config <Link> resolves a full href.
  const launch = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks/new',
    component: () => <div data-testid="launch-page" />,
    validateSearch: (raw: Record<string, unknown>) =>
      typeof raw.editScheduled === 'string' ? { editScheduled: raw.editScheduled } : {},
  })
  const taskPage = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks/$id',
    component: () => <div data-testid="task-page" />,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([detail, launch, taskPage]),
    history: createMemoryHistory({ initialEntries: ['/scheduled/sched-1'] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('RFC-159 — scheduled detail: edit task config entry', () => {
  test('renders and links to the wizard in edit mode for this schedule', async () => {
    installFetch()
    await renderDetail()

    const link = await screen.findByTestId('scheduled-edit-config')
    expect(link.textContent).toBe('Edit task config')
    const href = link.getAttribute('href') ?? ''
    expect(href).toContain('/tasks/new')
    expect(href).toContain('editScheduled=sched-1')
  })

  // 2026-07-10 user feedback: a generic "Edit" sitting next to "Edit task config"
  // didn't say WHAT it edits. The label must spell out its scope (name + schedule
  // spec — exactly what ScheduleDialog's edit mode can change).
  test('the name-&-schedule edit entry renders a non-generic label alongside it', async () => {
    installFetch()
    await renderDetail()
    await waitFor(() => {
      expect(screen.getByTestId('scheduled-edit').textContent).toBe('Edit name & schedule')
      expect(screen.getByTestId('scheduled-edit-config')).toBeTruthy()
    })
  })
})

describe('RFC-165 — degraded schedule repair affordance (implementation-gate P2)', () => {
  test('degraded payload keeps the edit-config REPAIR entry + banner', async () => {
    installFetch({
      ...SCHEDULE,
      launchPayload: null,
      launchPayloadWorkflowId: 'wf-42',
      migrationNeeded: true,
      migrationError: { launchPayload: 'legacy-shape: repoPath retired', scheduleSpec: null },
    })
    await renderDetail()

    const banner = await screen.findByTestId('scheduled-degraded-banner')
    expect(banner.textContent ?? '').toContain('legacy-shape: repoPath retired')

    const link = screen.getByTestId('scheduled-edit-config')
    const href = link.getAttribute('href') ?? ''
    expect(href).toContain('/tasks/new')
    expect(href).toContain('editScheduled=sched-1')
  })

  test('corrupt payload with NO recoverable workflowId still gets the repair entry (RFC-165: the wizard repairs via raw PUT, no workflowId needed)', async () => {
    installFetch({
      ...SCHEDULE,
      launchPayload: null,
      launchPayloadWorkflowId: null,
      migrationError: { launchPayload: 'invalid-json', scheduleSpec: null },
    })
    await renderDetail()

    await screen.findByTestId('scheduled-degraded-banner')
    const link = screen.getByTestId('scheduled-edit-config')
    expect(link.getAttribute('href') ?? '').toContain('editScheduled=sched-1')
  })
})
