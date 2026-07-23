// RFC-192 (T2/T3) — /tasks run-monitor table locks.
//
//   1. Error line renders on FAILED rows only — canceled rows carry non-null
//      summaries ("canceled by user") that must NOT paint red (negative case
//      is the Codex 设计门 P2 fix).
//   2.「N 仓库」chip only when repoCount > 1;「定时」chip only when
//      scheduledTaskId is set, and clicking it does NOT trigger row nav.
//   3. Whole-row click navigates; Cmd-click (and clicks on inner links) do
//      not double-navigate (shouldRowNavigate guard).
//   4. The list query explicitly requests limit=500 (listTasks defaults to
//      100 — local filtering would silently miss rows 101+, Codex P1).
//   5. pulse class only on running rows; URL-mode repo shows the repo name
//      derived from the redacted URL, not the cache dir.
//   6. Subject Segmented + name search compose (client-side AND); the new
//      toolbar hides on an empty list (tasks.png baseline parity).

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
import type { TaskSummary } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
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

function row(name: string, overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: `t_${name}`,
    name,
    workflowId: 'wf1',
    workflowName: 'wf-one',
    repoPath: '/Users/w/proj/agent-workflow',
    repoUrl: null,
    cachedRepoId: null,
    status: 'done',
    startedAt: Date.now() - 3_600_000,
    finishedAt: Date.now() - 3_000_000,
    errorSummary: null,
    repoCount: 1,
    spaceKind: 'remote',
    ...overrides,
  }
}

interface Recorded {
  urls: string[]
}

function installFetch(rows: TaskSummary[]): Recorded {
  const rec: Recorded = { urls: [] }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (req: RequestInfo | URL) => {
    const url = req.toString()
    rec.urls.push(url)
    const json = (payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    if (url.includes('/api/tasks')) return json(rows)
    return json([])
  })
  return rec
}

async function renderPage(
  initialEntry = '/tasks',
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const list = await import('../src/routes/tasks')
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks',
    component: list.Route.options.component,
    validateSearch: list.Route.options.validateSearch,
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
      stub('/tasks/$id'),
      stub('/tasks/new'),
      stub('/scheduled/$id'),
      stub('/workflows/$id'),
      stub('/workgroups/$id'),
      stub('/agents/$id'),
    ]),
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

describe('/tasks — run-monitor table (RFC-192)', () => {
  test('RFC-198 page-header-primary-ratchet keeps one populated-list header task', async () => {
    installFetch([row('primary-ratchet')])
    await renderPage()

    const taskRow = await screen.findByTestId('task-row-t_primary-ratchet')
    const page = taskRow.closest('.page')
    const header = page?.querySelector('header.page__header')
    const create = screen.getByTestId('tasks-new-button')

    expect(Array.from(header?.querySelectorAll('.btn--primary') ?? [])).toEqual([create])
    expect(create.getAttribute('href')).toBe('/tasks/new')
  })

  test('query requests limit=500; error line only on FAILED rows (canceled negative)', async () => {
    const rec = installFetch([
      row('boom', { status: 'failed', errorSummary: 'node exec failed: exited 1' }),
      row('halted', { status: 'canceled', errorSummary: 'canceled by user', finishedAt: null }),
    ])
    await renderPage()
    await screen.findByTestId('task-row-t_boom')
    expect(rec.urls.some((u) => u.includes('/api/tasks') && u.includes('limit=500'))).toBe(true)

    const err = screen.getByTestId('task-error-t_boom')
    // RFC-203 T4: the cell shows LOCALIZED failure copy; the raw machine
    // summary survives in the hover title only.
    expect(err.textContent).toBe('Task execution failed.')
    expect(err.getAttribute('title')).toBe('node exec failed: exited 1')
    // Canceled row: summary present in the payload but NO red error line.
    expect(screen.queryByTestId('task-error-t_halted')).toBeNull()

    // RFC-198: the route keeps its native table/row contract, but the table
    // now lives in the shared responsive viewport and the heading uses the
    // shared PageHeader DOM shape.
    const table = err.closest('table')
    expect(table?.parentElement?.classList.contains('table-viewport__scroller')).toBe(true)
    expect(table?.closest('.table-viewport')?.classList.contains('table-viewport--lg')).toBe(true)
    expect(document.querySelector('h1.page__title')).not.toBeNull()
  })

  test('repo chip only when repoCount>1; URL-mode repo name derives from the redacted URL', async () => {
    installFetch([
      row('multi', {
        repoCount: 3,
        repoPath: '/home/.aw/repos/deadbeef-monorepo',
        repoUrl: 'https://user:pw@github.com/org/monorepo.git',
        cachedRepoId: null,
      }),
      row('single'),
    ])
    await renderPage()
    const multi = await screen.findByTestId('task-row-t_multi')
    expect(screen.getByTestId('task-repos-t_multi').textContent).toContain('3')
    expect(multi.textContent).toContain('monorepo')
    expect(multi.textContent).not.toContain('deadbeef')
    const code = multi.querySelector('code[title]')
    expect(code?.getAttribute('title')).not.toContain('pw')
    expect(screen.queryByTestId('task-repos-t_single')).toBeNull()
  })

  test('pulse dot only on running rows; duration column per status', async () => {
    installFetch([
      row('live', { status: 'running', finishedAt: null }),
      row('finished'),
      row('parked', { status: 'awaiting_review', finishedAt: null }),
    ])
    await renderPage()
    const live = await screen.findByTestId('task-row-t_live')
    expect(live.querySelector('.status-chip--pulse .status-chip__dot')).not.toBeNull()
    expect(live.textContent).toContain('running ·')
    const done = screen.getByTestId('task-row-t_finished')
    expect(done.querySelector('.status-chip--pulse')).toBeNull()
    expect(done.textContent).toContain('10 min') // 3.6e6-3e6 = 10 min span
    expect(screen.getByTestId('task-row-t_parked').textContent).toContain('waiting')
  })

  test('row click navigates; Cmd-click and inner-link clicks do not', async () => {
    installFetch([row('nav', { scheduledTaskId: 'sched_1' })])
    const router = await renderPage()
    const tr = await screen.findByTestId('task-row-t_nav')

    // Cmd-click anywhere on the row (e.g. on the name link) → no row nav.
    fireEvent.click(tr, { metaKey: true })
    expect(router.state.location.pathname).toBe('/tasks')

    // Click on the scheduled-origin chip (an inner link) → guard exempts it;
    // the router follows the LINK (to /scheduled/$id), not the row target.
    fireEvent.click(screen.getByTestId('task-scheduled-chip-t_nav'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/scheduled/sched_1'))

    // Back on the list: plain row-body click → task detail.
    router.history.back()
    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks'))
    fireEvent.click(screen.getByTestId('task-row-t_nav'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks/t_nav'))
  })

  test('subject + search filters compose; toolbar hidden on an empty list', async () => {
    installFetch([
      row('flow-a'),
      row('crew-b', { workgroupId: 'wg1', workgroupName: 'crew' }),
      row('solo-c', { sourceAgentName: 'coder' }),
    ])
    await renderPage()
    await screen.findByTestId('task-row-t_flow-a')

    fireEvent.click(screen.getByTestId('tasks-subject-workgroup'))
    expect(screen.queryByTestId('task-row-t_flow-a')).toBeNull()
    expect(screen.getByTestId('task-row-t_crew-b')).toBeTruthy()

    fireEvent.change(screen.getByTestId('tasks-search'), { target: { value: 'zzz' } })
    const noMatches = screen.getByTestId('tasks-no-matches')
    expect(screen.queryByTestId('tasks-empty')).toBeNull()

    // The compact empty state owns one clear action; it resets both local
    // filters and restores focus to the retained search field.
    fireEvent.click(within(noMatches).getByRole('button', { name: /clear filters/i }))
    expect((screen.getByTestId('tasks-search') as HTMLInputElement).value).toBe('')
    expect(document.activeElement).toBe(screen.getByTestId('tasks-search'))
    expect(screen.getByTestId('tasks-subject-all').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('task-row-t_flow-a')).toBeTruthy()
    expect(screen.getByTestId('task-row-t_crew-b')).toBeTruthy()
  })

  test('empty list renders one guided primary action without the filter toolbar', async () => {
    installFetch([])
    await renderPage()
    const empty = await screen.findByTestId('tasks-empty')
    expect(screen.queryByTestId('tasks-search')).toBeNull()
    expect(screen.queryByTestId('tasks-subject-all')).toBeNull()
    expect(empty.textContent).toContain(enUS.tasks.emptyDescription)
    expect(empty.querySelector('[data-icon="task"]')).not.toBeNull()
    const createActions = screen.getAllByTestId('tasks-new-button')
    expect(createActions).toHaveLength(1)
    expect(createActions[0]!.textContent).toBe(enUS.tasks.newButton)
    expect(empty.contains(createActions[0]!)).toBe(true)
    expect(createActions[0]!.closest('.page__actions')).toBeNull()
    const header = empty.closest('.page')?.querySelector('header.page__header')
    const chromePrimaries = [header, empty].flatMap((surface) =>
      Array.from(surface?.querySelectorAll('.btn--primary') ?? []),
    )
    expect(chromePrimaries).toEqual([createActions[0]])
  })

  test('status-filter no-match keeps one create action and restores focus after URL clear', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (req: RequestInfo | URL) => {
      const url = req.toString()
      const payload = url.includes('status=failed') ? [] : [row('after-status-clear')]
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const router = await renderPage('/tasks?status=failed')
    const empty = await screen.findByTestId('tasks-no-matches')
    const createActions = screen.getAllByTestId('tasks-new-button')
    expect(createActions).toHaveLength(1)
    expect(empty.contains(createActions[0]!)).toBe(false)
    expect(createActions[0]!.closest('.page__actions')).not.toBeNull()
    fireEvent.click(within(empty).getByRole('button', { name: /clear filters/i }))
    await waitFor(() => expect(router.state.location.search).toEqual({}))
    await screen.findByTestId('task-row-t_after-status-clear')
    expect(document.activeElement).toBe(screen.getByTestId('tasks-search'))
  })

  test('refetch error keeps stale rows visible and exposes a working retry action', async () => {
    let fail = false
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (req: RequestInfo | URL) => {
      const url = req.toString()
      if (!url.includes('/api/tasks')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (fail) {
        return new Response(JSON.stringify({ code: 'tasks-load-failed', message: 'try again' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify([row('stale')]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await renderPage('/tasks', qc)
    await screen.findByTestId('task-row-t_stale')

    fail = true
    await qc.refetchQueries({ queryKey: ['tasks'] })
    await screen.findByRole('alert')
    expect(screen.getByTestId('task-row-t_stale')).toBeTruthy()

    fail = false
    fireEvent.click(screen.getByRole('button', { name: /retry|重试/i }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByTestId('task-row-t_stale')).toBeTruthy()
  })
})
