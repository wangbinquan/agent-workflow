// RFC-192 (T4) — /scheduled inline operations locks.
//
//   1. The enable Switch PUTs {enabled} (the detail toggle's endpoint/body).
//   2.「立即运行」is a two-click ConfirmButton → POST run-now → navigate to
//      the NEW task (detail-page parity).
//   3. run-now disable predicate: migrationNeeded / null payload / null spec
//      block; a row whose LAST FIRE FAILED does NOT (it is run-now's primary
//      user — design §2.3, deliberately narrower than the repair badge).
//   4. Last-run cell: the task link renders ONLY for lastStatus==='launched'
//      (recordFailure never updates lastTaskId — a failure chip must not link
//      to the older successful task, Codex 设计门 P1);「连挂 ×N」only when
//      consecutiveFailures > 1.
//   5. Next-run: relative main line + short absolute subtitle; disabled → —.
//   6. Row click navigates; Switch clicks don't (shouldRowNavigate guard).
//   7. Every row ends with the shared `.data-table__chevron` affordance cell
//      (parity with /tasks rows — a clickable row must LOOK clickable), and
//      the thead column count matches the row cell count.

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
import type { ScheduledTask, ScheduledTaskListItem } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { scheduleRunNowEligibility } from '../src/lib/schedule-view'
import { enUS } from '../src/i18n/en-US'
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

function sched(id: string, overrides: Partial<ScheduledTaskListItem> = {}): ScheduledTaskListItem {
  return {
    id,
    name: `job-${id}`,
    ownerUserId: 'u1',
    owner: { id: 'u1', username: 'alice', displayName: 'Alice' },
    launchKind: 'workflow',
    launchPayload: { workflowId: 'wf1' } as unknown as ScheduledTask['launchPayload'],
    scheduleSpec: {
      kind: 'daily',
      hour: 2,
      minute: 30,
    } as unknown as ScheduledTask['scheduleSpec'],
    migrationNeeded: false,
    migrationError: null,
    launchPayloadWorkflowId: 'wf1',
    enabled: true,
    nextRunAt: Date.now() + 4 * 3_600_000,
    lastRunAt: Date.now() - 8 * 3_600_000,
    lastStatus: 'launched',
    lastError: null,
    lastTaskId: 'task_prev',
    consecutiveFailures: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

interface Recorded {
  calls: Array<{ url: string; method: string; body: unknown }>
}

function installFetch(
  rows: ScheduledTaskListItem[],
  runNowResponse?: () => Response | Promise<Response>,
): Recorded {
  const rec: Recorded = { calls: [] }
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (req: RequestInfo | URL, init?: RequestInit) => {
      const url = req.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      rec.calls.push({ url, method, body })
      const json = (payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      if (url.includes('/run-now') && method === 'POST') {
        return runNowResponse?.() ?? json({ taskId: 'task_new' })
      }
      if (url.includes('/api/scheduled-tasks') && method === 'PUT') return json(rows[0])
      if (url.includes('/api/scheduled-tasks')) return json(rows)
      return json([])
    },
  )
  return rec
}

async function renderPage(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const list = await import('../src/routes/scheduled')
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/scheduled',
    component: list.Route.options.component,
  })
  const stub = (path: string) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      component: () => <div data-testid="stub" />,
    })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      listRoute,
      stub('/scheduled/$id'),
      stub('/tasks/$id'),
      stub('/tasks/new'),
    ]),
    history: createMemoryHistory({ initialEntries: ['/scheduled'] }),
  })
  render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
  return router
}

describe('scheduleRunNowEligibility — shared list/detail predicate', () => {
  test('structural repair states block; disabled and failed-last-fire rows do NOT', () => {
    expect(scheduleRunNowEligibility(sched('ok'))).toEqual({ allowed: true })
    expect(scheduleRunNowEligibility(sched('m', { migrationNeeded: true }))).toEqual({
      allowed: false,
      reason: 'migration-needed',
    })
    expect(scheduleRunNowEligibility(sched('p', { launchPayload: null }))).toEqual({
      allowed: false,
      reason: 'payload-missing',
    })
    expect(scheduleRunNowEligibility(sched('s', { scheduleSpec: null }))).toEqual({
      allowed: false,
      reason: 'spec-missing',
    })
    expect(scheduleRunNowEligibility(sched('off', { enabled: false }))).toEqual({ allowed: true })
    expect(
      scheduleRunNowEligibility(sched('f', { lastStatus: 'failed', lastError: 'boom' })),
    ).toEqual({ allowed: true })
  })
})

describe('/scheduled — inline operations (RFC-192)', () => {
  test('RFC-246 business views, search, and launch-kind filter compose', async () => {
    installFetch([
      sched('healthy'),
      sched('paused', { enabled: false, launchKind: 'agent' }),
      sched('flaky-group', { launchKind: 'workgroup', lastStatus: 'failed' }),
    ])
    await renderPage()
    await screen.findByTestId('scheduled-row-healthy')

    fireEvent.click(screen.getByTestId('scheduled-view-paused'))
    expect(screen.getByTestId('scheduled-row-paused')).toBeTruthy()
    expect(screen.queryByTestId('scheduled-row-healthy')).toBeNull()

    fireEvent.click(screen.getByTestId('scheduled-view-all'))
    fireEvent.change(screen.getByTestId('scheduled-search'), { target: { value: 'flaky' } })
    expect(screen.getByTestId('scheduled-row-flaky-group')).toBeTruthy()
    expect(screen.queryByTestId('scheduled-row-paused')).toBeNull()

    fireEvent.change(screen.getByTestId('scheduled-search'), { target: { value: '' } })
    fireEvent.click(screen.getByTestId('scheduled-filter-button'))
    const dialog = await screen.findByTestId('scheduled-filter-dialog')
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Workgroup' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply filters' }))
    expect(screen.getByTestId('scheduled-row-flaky-group')).toBeTruthy()
    expect(screen.queryByTestId('scheduled-row-healthy')).toBeNull()
  })

  test('Owner column shows display name plus full username and stable-id fallback', async () => {
    installFetch([
      sched('resolved'),
      sched('missing', { ownerUserId: 'deleted-user-42', owner: null }),
    ])
    await renderPage()

    const resolved = await screen.findByTestId('scheduled-row-resolved')
    const resolvedOwner = resolved.querySelector('.data-table__owner-cell')
    expect(resolvedOwner?.textContent).toContain('Alice')
    expect(resolvedOwner?.textContent).toContain('@alice')

    const missing = screen.getByTestId('scheduled-row-missing')
    expect(missing.querySelector('.data-table__owner-cell')?.textContent).toContain(
      'deleted-user-42',
    )
    expect(resolved.closest('table')?.querySelector('th:nth-child(4)')?.textContent).toBe('Owner')
  })

  test('Switch PUTs {enabled:false} without navigating the row', async () => {
    const rec = installFetch([sched('s1')])
    const router = await renderPage()
    const sw = await screen.findByTestId('scheduled-enable-s1')
    fireEvent.click(sw)
    await waitFor(() => {
      const put = rec.calls.find((c) => c.method === 'PUT')
      expect(put?.url).toContain('/api/scheduled-tasks/s1')
      expect(put?.body).toEqual({ enabled: false })
    })
    expect(router.state.location.pathname).toBe('/scheduled')
  })

  test('run-now: two clicks → POST → navigate to the NEW task', async () => {
    const rec = installFetch([sched('s1')])
    const router = await renderPage()
    await screen.findByTestId('scheduled-row-s1')
    const btn = screen.getByRole('button', { name: 'Run now' })
    fireEvent.click(btn) // arm
    expect(rec.calls.some((c) => c.url.includes('/run-now'))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /confirm/i })) // fire
    await waitFor(() => {
      expect(
        rec.calls.some((c) => c.method === 'POST' && c.url.includes('/scheduled-tasks/s1/run-now')),
      ).toBe(true)
    })
    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks/task_new'))
  })

  test('run-now pending and definitive error are row-scoped; retry targets the same schedule', async () => {
    let attempt = 0
    let resolveFirst!: (response: Response) => void
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve
    })
    const rec = installFetch([sched('s1'), sched('s2')], () => {
      attempt += 1
      if (attempt === 1) return first
      return new Response(JSON.stringify({ taskId: 'task_new' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const router = await renderPage()
    const row1 = await screen.findByTestId('scheduled-row-s1')
    const row2 = screen.getByTestId('scheduled-row-s2')

    fireEvent.click(within(row1).getByRole('button', { name: 'Run now' }))
    fireEvent.click(within(row1).getByRole('button', { name: /confirm/i }))
    await waitFor(() => expect(attempt).toBe(1))
    expect((screen.getByTestId('scheduled-run-now-s1') as HTMLButtonElement).disabled).toBe(true)
    expect(
      (within(row2).getByRole('button', { name: 'Run now' }) as HTMLButtonElement).disabled,
    ).toBe(false)

    resolveFirst(
      new Response(JSON.stringify({ code: 'launch-rejected', message: 'cannot launch now' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const error = await screen.findByTestId('scheduled-run-now-error-s1')
    const feedbackRow = screen.getByTestId('scheduled-run-now-feedback-row-s1')
    expect(feedbackRow.tagName).toBe('TR')
    expect(feedbackRow.previousElementSibling).toBe(row1)
    expect((feedbackRow.querySelector('td') as HTMLTableCellElement).colSpan).toBe(6)
    expect(feedbackRow.contains(error)).toBe(true)
    expect(row1.contains(error)).toBe(false)
    expect(screen.getByTestId('scheduled-row-s1')).toBeTruthy()
    expect(router.state.location.pathname).toBe('/scheduled')

    fireEvent.click(within(error).getByRole('button', { name: /retry/i }))
    await waitFor(() => expect(attempt).toBe(2))
    expect(
      rec.calls.filter(
        (call) => call.method === 'POST' && call.url.includes('/scheduled-tasks/s1/run-now'),
      ),
    ).toHaveLength(2)
    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks/task_new'))
  })

  test('run-now transport loss locks only that row and never exposes a blind retry', async () => {
    let attempt = 0
    const rec = installFetch([sched('s1'), sched('s2')], () => {
      attempt += 1
      throw new TypeError('socket closed after request')
    })
    const router = await renderPage()
    const row1 = await screen.findByTestId('scheduled-row-s1')
    const row2 = screen.getByTestId('scheduled-row-s2')

    fireEvent.click(within(row1).getByRole('button', { name: 'Run now' }))
    fireEvent.click(within(row1).getByRole('button', { name: /confirm/i }))

    const feedback = await screen.findByTestId('scheduled-run-now-error-s1')
    expect(feedback.textContent).toContain('may already have started a task')
    expect(feedback.textContent).toContain('Do not send the request again')
    expect(within(feedback).queryByRole('button', { name: /retry/i })).toBeNull()
    expect(within(feedback).getByRole('link', { name: 'Inspect tasks' }).getAttribute('href')).toBe(
      '/tasks',
    )
    expect((screen.getByTestId('scheduled-run-now-s1') as HTMLButtonElement).disabled).toBe(true)
    expect(
      (within(row2).getByRole('button', { name: 'Run now' }) as HTMLButtonElement).disabled,
    ).toBe(false)

    fireEvent.click(screen.getByTestId('scheduled-run-now-s1'))
    expect(attempt).toBe(1)
    expect(
      rec.calls.filter(
        (call) => call.method === 'POST' && call.url.endsWith('/api/scheduled-tasks/s1/run-now'),
      ),
    ).toHaveLength(1)
    expect(router.state.location.pathname).toBe('/scheduled')
  })

  test('repair row blocks run-now; disabled and failed-streak rows remain manually runnable', async () => {
    installFetch([
      sched('bad', { migrationNeeded: true, launchPayload: null }),
      sched('paused', { enabled: false }),
      sched('flaky', {
        lastStatus: 'failed',
        lastError: 'exploded',
        consecutiveFailures: 3,
        lastTaskId: 'task_old_success',
      }),
    ])
    await renderPage()
    const rows = await screen.findAllByRole('button', { name: 'Run now' })
    expect(rows).toHaveLength(3)
    const bad = screen.getByTestId('scheduled-row-bad')
    expect((bad.querySelector('.data-table__actions button') as HTMLButtonElement).disabled).toBe(
      true,
    )
    const flaky = screen.getByTestId('scheduled-row-flaky')
    expect((flaky.querySelector('.data-table__actions button') as HTMLButtonElement).disabled).toBe(
      false,
    )
    const paused = screen.getByTestId('scheduled-row-paused')
    expect(
      (paused.querySelector('.data-table__actions button') as HTMLButtonElement).disabled,
    ).toBe(false)
    // Streak chip at ×3; the stale lastTaskId must NOT render as a link.
    expect(screen.getByTestId('scheduled-streak-flaky').textContent).toContain('3')
    expect(screen.queryByTestId('scheduled-last-task-flaky')).toBeNull()
  })

  test('launched row links the last task; single failure has no streak chip', async () => {
    installFetch([
      sched('ok'),
      sched('once', { lastStatus: 'failed', consecutiveFailures: 1, lastTaskId: 'task_x' }),
    ])
    await renderPage()
    const link = await screen.findByTestId('scheduled-last-task-ok')
    expect(link.getAttribute('href')).toBe('/tasks/task_prev')
    expect(screen.queryByTestId('scheduled-streak-once')).toBeNull()
    expect(screen.queryByTestId('scheduled-last-task-once')).toBeNull()
  })

  test('next-run: relative + absolute subtitle when enabled; em dash when disabled', async () => {
    installFetch([sched('on'), sched('off', { enabled: false, nextRunAt: Date.now() + 3_600_000 })])
    await renderPage()
    const on = await screen.findByTestId('scheduled-row-on')
    expect(on.querySelector('.scheduled-next time')).not.toBeNull()
    expect(on.querySelector('.scheduled-next__abs')).not.toBeNull()
    const off = screen.getByTestId('scheduled-row-off')
    expect(off.querySelector('.scheduled-next time')).toBeNull()
    expect(off.querySelector('.scheduled-next__abs')).toBeNull()
    expect(off.textContent).toContain('—')
  })

  test('row click navigates to the detail page', async () => {
    installFetch([sched('s9')])
    const router = await renderPage()
    fireEvent.click(await screen.findByTestId('scheduled-row-s9'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/scheduled/s9'))
  })

  test('rows end with the shared chevron affordance cell (parity with /tasks)', async () => {
    installFetch([sched('s1')])
    await renderPage()
    const row = await screen.findByTestId('scheduled-row-s1')
    const cells = row.querySelectorAll('td')
    const last = cells[cells.length - 1]
    expect(last?.classList.contains('data-table__chevron')).toBe(true)
    expect(last?.querySelector('svg')).not.toBeNull()
    expect(last?.getAttribute('aria-hidden')).toBe('true')
    // Column-count lock: a td without its matching th (or vice versa) skews
    // every header over the wrong column.
    const table = row.closest('table')
    expect(table?.querySelectorAll('thead th')).toHaveLength(cells.length)
    expect(table?.parentElement?.classList.contains('table-viewport__scroller')).toBe(true)
    expect(table?.closest('.table-viewport')?.classList.contains('table-viewport--lg')).toBe(false)
    expect(document.querySelector('h1.page__title')).not.toBeNull()
  })

  test('initial empty state owns the only create action', async () => {
    installFetch([])
    await renderPage()
    const empty = await screen.findByTestId('scheduled-empty')
    expect(empty.textContent).toContain(enUS.scheduled.emptyDescription)
    expect(empty.querySelector('[data-icon="schedule"]')).not.toBeNull()
    const createActions = screen.getAllByTestId('scheduled-new')
    expect(createActions).toHaveLength(1)
    expect(empty.contains(createActions[0]!)).toBe(true)
    expect(createActions[0]!.closest('.page__actions')).toBeNull()
    const header = empty.closest('.page')?.querySelector('header.page__header')
    const chromePrimaries = [header, empty].flatMap((surface) =>
      Array.from(surface?.querySelectorAll('.btn--primary') ?? []),
    )
    expect(chromePrimaries).toEqual([createActions[0]])
  })

  test('refetch error keeps stale schedules visible and retry recovers', async () => {
    let fail = false
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (req: RequestInfo | URL) => {
      const url = req.toString()
      if (url.includes('/api/scheduled-tasks') && fail) {
        return new Response(
          JSON.stringify({ code: 'scheduled-load-failed', message: 'try again' }),
          {
            status: 500,
            headers: { 'content-type': 'application/json' },
          },
        )
      }
      return new Response(
        JSON.stringify(url.includes('/api/scheduled-tasks') ? [sched('stale')] : []),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await renderPage(qc)
    await screen.findByTestId('scheduled-row-stale')

    fail = true
    await qc.refetchQueries({ queryKey: ['scheduled-tasks'] })
    await screen.findByRole('alert')
    expect(screen.getByTestId('scheduled-row-stale')).toBeTruthy()

    fail = false
    fireEvent.click(screen.getByRole('button', { name: /retry|重试/i }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByTestId('scheduled-row-stale')).toBeTruthy()
  })
})
