// RFC-159 T7 — the "Run now" button on the scheduled-task detail route.
// Locks: the button renders, clicking it POSTs to /:id/run-now, and on success
// the page navigates to the freshly-launched task. We bypass the real router by
// rendering the page component in a mini-router (mirrors distill-job-detail-route)
// and stub fetch + the WS hook.
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

vi.mock('../src/hooks/useScheduledTaskWs', () => ({ useScheduledTaskWs: () => undefined }))

interface FetchCall {
  url: string
  method: string
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})
afterEach(() => {
  cleanup() // unmount React trees (incl. Dialog portals) before clearing the DOM
  vi.restoreAllMocks()
})

const SCHEDULE = {
  id: 'sched-1',
  name: 'nightly audit',
  ownerUserId: 'bob',
  launchPayload: { workflowId: 'wf', name: 'nightly', repoPath: '/r', baseBranch: 'main' },
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

function installFetch(
  schedule: Record<string, unknown> = SCHEDULE,
  runNowResponse?: () => Response | Promise<Response>,
): FetchCall[] {
  const calls: FetchCall[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString()
      const method = init?.method ?? 'GET'
      calls.push({ url, method })
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      if (url.includes('/run-now')) {
        return runNowResponse?.() ?? json({ taskId: 'task-xyz' }, 201)
      }
      if (url.includes('/api/tasks')) return json([]) // run history
      if (url.includes('/api/scheduled-tasks/sched-1')) return json(schedule)
      return json({})
    },
  )
  return calls
}

async function renderDetail() {
  const mod = await import('../src/routes/scheduled.$id')
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const detail = createRoute({
    getParentRoute: () => rootRoute,
    path: '/scheduled/$id',
    component: mod.Route.options.component,
  })
  // Stub target so navigate({ to: '/tasks/$id' }) resolves to something renderable.
  const taskPage = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks/$id',
    component: () => <div data-testid="task-page" />,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([detail, taskPage]),
    history: createMemoryHistory({ initialEntries: ['/scheduled/sched-1'] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('RFC-159 T7 — Run now button', () => {
  test('uses the same two-click confirmation as the list, then navigates on success', async () => {
    const calls = installFetch()
    await renderDetail()

    const btn = await screen.findByTestId('scheduled-run-now')
    expect(btn.textContent).toBe('Run now')

    fireEvent.click(btn)
    expect(calls.some((call) => call.url.includes('/run-now'))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }))

    await waitFor(() => {
      expect(
        calls.some(
          (c) => c.method === 'POST' && c.url.endsWith('/api/scheduled-tasks/sched-1/run-now'),
        ),
      ).toBe(true)
    })
    // On success it navigates to the new task page.
    await waitFor(() => {
      expect(screen.getByTestId('task-page')).toBeTruthy()
    })
  })

  test('keeps the detail action in place on definitive rejection and explicitly retries', async () => {
    let attempt = 0
    const calls = installFetch(SCHEDULE, () => {
      attempt += 1
      if (attempt === 1) {
        return new Response(JSON.stringify({ code: 'launch-rejected', message: 'cannot launch' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ taskId: 'task-xyz' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
    })
    await renderDetail()

    fireEvent.click(await screen.findByTestId('scheduled-run-now'))
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }))
    const error = await screen.findByTestId('scheduled-run-now-error')
    expect(screen.getByTestId('scheduled-run-now')).toBeTruthy()
    fireEvent.click(error.querySelector('button')!)

    await waitFor(() => expect(attempt).toBe(2))
    expect(
      calls.filter(
        (call) =>
          call.method === 'POST' && call.url.endsWith('/api/scheduled-tasks/sched-1/run-now'),
      ),
    ).toHaveLength(2)
    await waitFor(() => expect(screen.getByTestId('task-page')).toBeTruthy())
  })

  test('locks the detail action after a 5xx outcome and directs inventory inspection without retry', async () => {
    let attempt = 0
    installFetch(SCHEDULE, () => {
      attempt += 1
      return new Response(JSON.stringify({ code: 'launch-failed', message: 'response lost' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })
    })
    await renderDetail()

    fireEvent.click(await screen.findByTestId('scheduled-run-now'))
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }))

    const feedback = await screen.findByTestId('scheduled-run-now-error')
    expect(feedback.textContent).toContain('may already have started a task')
    expect(feedback.textContent).toContain('Do not send the request again')
    expect(within(feedback).queryByRole('button', { name: /retry/i })).toBeNull()
    expect(within(feedback).getByRole('link', { name: 'Inspect tasks' }).getAttribute('href')).toBe(
      '/tasks',
    )

    const action = screen.getByTestId('scheduled-run-now') as HTMLButtonElement
    expect(action.disabled).toBe(true)
    fireEvent.click(action)
    expect(attempt).toBe(1)
  })

  test('a disabled but structurally valid schedule remains manually runnable', async () => {
    installFetch({ ...SCHEDULE, enabled: false })
    await renderDetail()

    expect(((await screen.findByTestId('scheduled-run-now')) as HTMLButtonElement).disabled).toBe(
      false,
    )
  })

  test.each([
    {
      name: 'migration-needed',
      schedule: { ...SCHEDULE, migrationNeeded: true },
      reason: 'repair the legacy schedule',
    },
    {
      name: 'payload-missing',
      schedule: { ...SCHEDULE, migrationNeeded: false, launchPayload: null },
      reason: 'restore the task launch configuration',
    },
    {
      name: 'spec-missing',
      schedule: { ...SCHEDULE, migrationNeeded: false, scheduleSpec: null },
      reason: 'restore the schedule definition',
    },
  ])('blocks detail run-now for $name with its specific reason', async ({ schedule, reason }) => {
    installFetch(schedule)
    await renderDetail()

    const button = (await screen.findByTestId('scheduled-run-now')) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.parentElement?.getAttribute('title')).toContain(reason)
    const descriptionId = button.getAttribute('aria-describedby')
    expect(descriptionId).not.toBeNull()
    expect(document.getElementById(descriptionId!)?.textContent).toContain(reason)
  })

  // RFC-159 — edit entry (user feedback 2026-07-10): the detail page must expose an
  // editor for the trigger period, pre-filled with the schedule's current values.
  test('Edit opens the schedule dialog pre-filled with the current schedule', async () => {
    installFetch()
    await renderDetail()

    fireEvent.click(await screen.findByTestId('scheduled-edit'))

    await waitFor(() => {
      expect(screen.getByTestId('schedule-dialog')).toBeTruthy()
    })
    expect((screen.getByTestId('schedule-name') as HTMLInputElement).value).toBe('nightly audit')
  })
})
