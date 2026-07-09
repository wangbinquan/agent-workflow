// RFC-159 — scheduled-detail visual-consistency regressions (2026-07-10).
// Locks the restyle that moved the detail-page actions out of a bespoke
// `.detail-actions` btn--sm sidebar and into the standard top-right
// `.page__actions` header cluster (full-size buttons), matching every other
// detail page (tasks / mcps / agents …). Also guards:
//   - the fixed `scheduled.fieldEnabled` missing-key bug (the raw key must
//     never render as the "Enabled" label — it now reuses `scheduled.colEnabled`);
//   - the run-history table now has a real <thead> (column headers) and renders
//     rows through the shared <TaskStatusChip>.
// Assertions are language-independent (classes / structure / absence of the raw
// key / roles) so they don't race i18n language detection.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
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
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

const SCHEDULE = {
  id: 'sched-1',
  name: 'nightly audit',
  ownerUserId: 'bob',
  launchPayload: { workflowId: 'wf', name: 'nightly', repoPath: '/r', baseBranch: 'main' },
  scheduleSpec: { kind: 'daily', at: '09:00', timezone: 'UTC' },
  enabled: true,
  nextRunAt: 1_900_000_000_000,
  lastRunAt: null,
  lastStatus: null,
  lastError: null,
  lastTaskId: null,
  consecutiveFailures: 0,
  createdAt: 1,
  updatedAt: 1,
}

function installFetch(history: unknown[]) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = input.toString()
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    if (url.includes('/api/tasks')) return json(history) // run history
    if (url.includes('/api/scheduled-tasks/sched-1')) return json(SCHEDULE)
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
  // Stub target so <Link to="/tasks/$id"> in the history table resolves.
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

describe('RFC-159 — scheduled-detail UI consistency', () => {
  test('actions live in the top-right page__actions cluster, full-size — not a btn--sm sidebar', async () => {
    installFetch([])
    await renderDetail()

    const runNow = await screen.findByTestId('scheduled-run-now')
    // Full-size primary button; the old `.detail-actions` sidebar used btn--sm.
    expect(runNow.className).toContain('btn--primary')
    expect(runNow.className).not.toContain('btn--sm')

    // Anchored inside the standard header action cluster.
    const actions = runNow.closest('.page__actions')
    expect(actions).not.toBeNull()
    expect(actions!.closest('.page__header')).not.toBeNull()

    // Toggle shares the same cluster and is also full-size.
    const toggle = screen.getByTestId('scheduled-toggle')
    expect(toggle.className).not.toContain('btn--sm')
    expect(toggle.closest('.page__actions')).toBe(actions)

    // The bespoke sidebar is gone.
    expect(document.querySelector('.detail-actions')).toBeNull()
  })

  test('config grid shows a real Enabled label, never the raw i18n key', async () => {
    installFetch([])
    await renderDetail()
    await screen.findByTestId('scheduled-detail')
    // Regression: `scheduled.fieldEnabled` did not exist → rendered the raw key.
    expect(screen.queryByText('scheduled.fieldEnabled')).toBeNull()
  })

  test('run history renders a column-headed table with the shared status chip', async () => {
    installFetch([
      { id: 'task-1', name: 'nightly #1', status: 'done', startedAt: 1_800_000_000_000 },
    ])
    await renderDetail()

    const table = await screen.findByTestId('scheduled-history')
    // A real <thead> with three column headers (the table was headerless before).
    expect(within(table).getAllByRole('columnheader')).toHaveLength(3)
    // The task name renders as a link into task detail…
    const link = within(table).getByRole('link', { name: 'nightly #1' })
    expect(link.getAttribute('href')).toContain('/tasks/task-1')
    // …and the shared <TaskStatusChip> (success kind for a done task).
    expect(table.querySelector('.status-chip--success')).not.toBeNull()
  })
})
