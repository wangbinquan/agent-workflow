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
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router'
import type { ScheduledTask } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { runNowBlocked } from '../src/routes/scheduled'
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

function sched(id: string, overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id,
    name: `job-${id}`,
    ownerUserId: 'u1',
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

function installFetch(rows: ScheduledTask[]): Recorded {
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
      if (url.includes('/run-now') && method === 'POST') return json({ taskId: 'task_new' })
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

describe('runNowBlocked — disable predicate (pure)', () => {
  test('structural repair states block; a failed last fire does NOT', () => {
    expect(runNowBlocked(sched('ok'))).toBe(false)
    expect(runNowBlocked(sched('m', { migrationNeeded: true }))).toBe(true)
    expect(runNowBlocked(sched('p', { launchPayload: null }))).toBe(true)
    expect(runNowBlocked(sched('s', { scheduleSpec: null }))).toBe(true)
    // Deliberately narrower than the repair badge: lastError alone ≠ blocked.
    expect(runNowBlocked(sched('f', { lastStatus: 'failed', lastError: 'boom' }))).toBe(false)
  })
})

describe('/scheduled — inline operations (RFC-192)', () => {
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

  test('repair row: run-now disabled; failed-streak row: enabled + streak chip + NO task link', async () => {
    installFetch([
      sched('bad', { migrationNeeded: true, launchPayload: null }),
      sched('flaky', {
        lastStatus: 'failed',
        lastError: 'exploded',
        consecutiveFailures: 3,
        lastTaskId: 'task_old_success',
      }),
    ])
    await renderPage()
    const rows = await screen.findAllByRole('button', { name: 'Run now' })
    expect(rows).toHaveLength(2)
    const bad = screen.getByTestId('scheduled-row-bad')
    expect((bad.querySelector('.data-table__actions button') as HTMLButtonElement).disabled).toBe(
      true,
    )
    const flaky = screen.getByTestId('scheduled-row-flaky')
    expect((flaky.querySelector('.data-table__actions button') as HTMLButtonElement).disabled).toBe(
      false,
    )
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
    expect(off.querySelector('.scheduled-next')).toBeNull()
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
    expect(last?.textContent?.trim()).toBe('›')
    expect(last?.getAttribute('aria-hidden')).toBe('true')
    // Column-count lock: a td without its matching th (or vice versa) skews
    // every header over the wrong column.
    const table = row.closest('table')
    expect(table?.querySelectorAll('thead th')).toHaveLength(cells.length)
    expect(table?.parentElement?.classList.contains('table-viewport__scroller')).toBe(true)
    expect(table?.closest('.table-viewport')?.classList.contains('table-viewport--lg')).toBe(true)
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
