// RFC-243 PR-5 — /tasks child-task nesting locks.
//
//   1. The DEFAULT list request carries NO include_children param (the
//      server's top-level filter is the contract); the expand arrow appears
//      iff the row reports visible children (`childCount > 0`) and is absent
//      otherwise. Status is NOT a gate — the RFC-243 follow-up replaced the
//      status-based always-on arrow, which put a 「无子任务」 dead end on every
//      ordinary running/done task that never invoked a call node.
//   2. Expanding a parent lazily fetches `GET /api/tasks?parent_id=<id>` and
//      nests the direct children under it (indent +「子任务」badge + status
//      chip); collapsing removes them.
//   3. An empty children result renders the「无子任务」row once and is
//      REMEMBERED in component state — re-expanding must not re-fetch. Since
//      (1) only offers the arrow when childCount > 0, this path is now the
//      RACE guard: the children were deleted between list and expand.
//   4. The「含子任务」scope toggle re-requests with include_children=true
//      (flat) and child rows carry a parent-task LINK badge.
//   5. When the parent is not visible (absent from the list AND the probe
//      404s — design §8, e.g. a workgroup human member who is only a member
//      of the child), the badge degrades to a neutral non-link label.
//   6. The expand arrow is row-navigation exempt (shouldRowNavigate guard).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
import type { TaskListItem } from '@agent-workflow/shared'
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

function row(name: string, overrides: Partial<TaskListItem> = {}): TaskListItem {
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
    childCount: 0,
    ownerUserId: 'u1',
    owner: { id: 'u1', username: 'alice', displayName: 'Alice' },
    ...overrides,
  }
}

interface FetchFixture {
  /** Top-level rows (returned when include_children is absent). */
  top: TaskListItem[]
  /** Flat rows (returned when include_children=true). */
  flat?: TaskListItem[]
  /** parent_id=<key> → direct children. */
  childrenByParent?: Record<string, TaskListItem[]>
  /** /api/tasks/<id> probe targets that resolve (else 404). */
  probeTasks?: Record<string, TaskListItem>
}

interface Recorded {
  urls: string[]
}

function installFetch(fixture: FetchFixture): Recorded {
  const rec: Recorded = { urls: [] }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (req: RequestInfo | URL) => {
    const url = req.toString()
    rec.urls.push(url)
    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    const parsed = new URL(url)
    if (parsed.pathname === '/api/tasks') {
      const parentId = parsed.searchParams.get('parent_id')
      if (parentId !== null) return json(fixture.childrenByParent?.[parentId] ?? [])
      if (parsed.searchParams.get('include_children') === 'true') {
        return json(fixture.flat ?? fixture.top)
      }
      return json(fixture.top)
    }
    const probeMatch = /^\/api\/tasks\/([^/]+)$/.exec(parsed.pathname)
    if (probeMatch !== null) {
      const task = fixture.probeTasks?.[decodeURIComponent(probeMatch[1]!)]
      if (task !== undefined) return json(task)
      return json({ code: 'not-found', message: 'no such task' }, 404)
    }
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

describe('/tasks — child-task nesting (RFC-243 PR-5)', () => {
  test('default request carries no include_children; arrows follow childCount, not status', async () => {
    const rec = installFetch({
      top: [
        // childCount > 0 → arrow, across every status the count can occur on.
        row('live', { status: 'running', finishedAt: null, childCount: 1 }),
        row('parked', { status: 'awaiting_human', finishedAt: null, childCount: 2 }),
        row('finished', { childCount: 1 }),
        // A FAILED parent still owns its children — status is not a gate. This
        // row had no arrow under the old status set, hiding a real child.
        row('boom', { status: 'failed', errorSummary: 'x', childCount: 1 }),
        // childCount === 0 → NO affordance, even on the statuses that used to
        // carry the always-on arrow. This is the regression this test exists
        // for: ordinary tasks must not offer an expand that leads nowhere.
        row('solo-running', { status: 'running', finishedAt: null }),
        row('solo-done'),
        row('queued', { status: 'pending', finishedAt: null }),
      ],
    })
    await renderPage()
    await screen.findByTestId('task-row-t_live')

    const listUrls = rec.urls.filter((u) => new URL(u).pathname === '/api/tasks')
    expect(listUrls.length).toBeGreaterThan(0)
    expect(listUrls.every((u) => !u.includes('include_children'))).toBe(true)

    expect(screen.getByTestId('task-expand-t_live')).toBeTruthy()
    expect(screen.getByTestId('task-expand-t_parked')).toBeTruthy()
    expect(screen.getByTestId('task-expand-t_finished')).toBeTruthy()
    expect(screen.getByTestId('task-expand-t_boom')).toBeTruthy()
    expect(screen.queryByTestId('task-expand-t_solo-running')).toBeNull()
    expect(screen.queryByTestId('task-expand-t_solo-done')).toBeNull()
    expect(screen.queryByTestId('task-expand-t_queued')).toBeNull()
  })

  test('expand lazily fetches parent_id children and nests them; collapse removes', async () => {
    const rec = installFetch({
      top: [row('parent', { status: 'running', finishedAt: null, childCount: 1 })],
      childrenByParent: {
        t_parent: [
          row('kid', {
            status: 'running',
            finishedAt: null,
            parentTaskId: 't_parent',
            invocationDepth: 1,
          }),
        ],
      },
    })
    await renderPage()
    const arrow = await screen.findByTestId('task-expand-t_parent')
    // Lazy: no children fetch before the first expand click.
    expect(rec.urls.some((u) => u.includes('parent_id='))).toBe(false)

    fireEvent.click(arrow)
    const kid = await screen.findByTestId('task-row-t_kid')
    expect(rec.urls.some((u) => u.includes('parent_id=t_parent'))).toBe(true)
    // Nested rendering: child badge + indent hook + its own status chip. The
    // indent itself is CSS (`.task-row--child .task-name-cell__inner` consumes
    // the --task-child-depth var — styles.css is not loaded under jsdom, so
    // the rule is locked by the source assertion below).
    expect(kid.classList.contains('task-row--child')).toBe(true)
    expect(kid.getAttribute('data-depth')).toBe('1')
    expect(kid.style.getPropertyValue('--task-child-depth')).toBe('1')
    expect(screen.getByTestId('task-child-badge-t_kid').textContent).toBe(enUS.tasks.childBadge)
    expect(kid.textContent).toContain(enUS.tasks.status.running)
    expect(arrow.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(arrow)
    expect(screen.queryByTestId('task-row-t_kid')).toBeNull()
    expect(arrow.getAttribute('aria-expanded')).toBe('false')
  })

  test('empty children render the no-child row once and are remembered (no re-fetch)', async () => {
    const rec = installFetch({
      // Race: the list reported a child, but it was deleted before the expand.
      top: [row('lonely', { status: 'done', childCount: 1 })],
      childrenByParent: { t_lonely: [] },
    })
    await renderPage()
    const arrow = await screen.findByTestId('task-expand-t_lonely')

    fireEvent.click(arrow)
    const empty = await screen.findByTestId('task-children-empty-t_lonely')
    expect(empty.textContent).toContain(enUS.tasks.noChildTasks)
    const fetches = () => rec.urls.filter((u) => u.includes('parent_id=t_lonely')).length
    await waitFor(() => expect(fetches()).toBe(1))

    // Collapse + re-expand: the childless memory answers locally.
    fireEvent.click(arrow)
    expect(screen.queryByTestId('task-children-empty-t_lonely')).toBeNull()
    fireEvent.click(arrow)
    expect(screen.getByTestId('task-children-empty-t_lonely')).toBeTruthy()
    expect(fetches()).toBe(1)
  })

  test('scope toggle requests include_children=true and child rows link their parent', async () => {
    const parent = row('parent', { status: 'running', finishedAt: null, childCount: 1 })
    const kid = row('kid', {
      status: 'awaiting_human',
      finishedAt: null,
      parentTaskId: 't_parent',
      invocationDepth: 1,
    })
    const rec = installFetch({ top: [parent], flat: [parent, kid] })
    await renderPage()
    await screen.findByTestId('task-row-t_parent')

    fireEvent.click(screen.getByTestId('tasks-scope-all'))
    await screen.findByTestId('task-row-t_kid')
    expect(rec.urls.some((u) => u.includes('include_children=true'))).toBe(true)

    // Flat mode: no expand arrows, and the child row carries the parent LINK
    // badge (parent is visible in the same response — no probe fetch).
    expect(screen.queryByTestId('task-expand-t_parent')).toBeNull()
    const badge = screen.getByTestId('task-parent-chip-t_kid')
    expect(badge.tagName).toBe('A')
    expect(badge.getAttribute('href')).toBe('/tasks/t_parent')
    expect(badge.textContent).toBe(enUS.tasks.parentTaskChip)
    expect(rec.urls.some((u) => new URL(u).pathname === '/api/tasks/t_parent')).toBe(false)
  })

  test('invisible parent (probe 404) degrades the badge to neutral text, not a link', async () => {
    // Design §8: a workgroup human member can be a member of the CHILD only —
    // their flat list contains the child but not the parent, and the parent
    // detail probe 404s (same shape as "does not exist").
    const kid = row('kid', {
      status: 'awaiting_human',
      finishedAt: null,
      parentTaskId: 't_ghost',
      invocationDepth: 1,
    })
    installFetch({ top: [row('other')], flat: [row('other'), kid] })
    await renderPage()
    await screen.findByTestId('task-row-t_other')

    fireEvent.click(screen.getByTestId('tasks-scope-all'))
    const badge = await screen.findByTestId('task-parent-chip-t_kid')
    await waitFor(() => expect(badge.textContent).toBe(enUS.tasks.parentTaskUnavailable))
    expect(badge.tagName).not.toBe('A')
    expect(badge.getAttribute('href')).toBeNull()
  })

  test('expand arrow click never triggers whole-row navigation', async () => {
    installFetch({
      top: [row('parent', { status: 'done', childCount: 1 })],
      childrenByParent: { t_parent: [] },
    })
    const router = await renderPage()
    const arrow = await screen.findByTestId('task-expand-t_parent')

    fireEvent.click(arrow)
    await screen.findByTestId('task-children-empty-t_parent')
    expect(router.state.location.pathname).toBe('/tasks')

    // Sanity: a plain row-body click still navigates.
    fireEvent.click(screen.getByTestId('task-row-t_parent'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks/t_parent'))
  })

  test('styles.css indents nested child rows via the --task-child-depth var', () => {
    // jsdom never loads styles.css, so the visual indent is locked at the
    // source layer (CLAUDE.md bedrock-assertion rule): the child-row rule
    // must consume the depth var the <tr> sets inline.
    const css = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf-8')
    expect(css).toMatch(
      /\.task-row--child \.task-name-cell__inner\s*\{[^}]*padding-left:\s*calc\(var\(--task-child-depth,\s*1\)\s*\*\s*16px\)/,
    )
  })

  test('styles.css keeps the 「子任务」badge on one line (no shrink, no wrap)', () => {
    // Regression: the badge wrapped mid-word inside its pill. Two independent
    // causes, so two independent locks — either one alone lets it come back.
    const css = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf-8')
    // 1. The shared chip primitive must not wrap its own text.
    expect(css).toMatch(/^\.chip \{[^}]*white-space:\s*nowrap/m)
    // 2. Chips in the task-name row must not absorb the flex squeeze — the
    //    name ellipsizes instead. The badge carried no flex rule of its own,
    //    unlike the scheduled-origin chip beside it, and got compressed.
    expect(css).toMatch(/\.task-name-cell__row > \.chip \{[^}]*flex:\s*none/)
  })
})
