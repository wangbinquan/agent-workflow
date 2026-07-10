// RFC-164 PR-4 — /workgroups/launch page + detail-page launch entry.
//
// Locks:
//   1. Detail page: the "Launch task" button renders ONLY when the shared
//      workgroupLaunchReadiness oracle says ready, and links to
//      /workgroups/launch?name=<group>.
//   2. Launch page: task name + goal are required (submit gated); a filled
//      form POSTs /api/workgroups/:name/tasks with name/goal/repo fields on
//      the wire (goal asserted explicitly — RFC-125 lesson) and navigates to
//      the created task.
//   3. A 422 workgroup-not-ready response surfaces the localized reason copy
//      (not the raw code).

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
import type { Workgroup } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import '../src/i18n'

function wg(name: string, overrides: Partial<Workgroup> = {}): Workgroup {
  return {
    id: `wg_${name}`,
    name,
    description: '',
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
        agentName: 'coder',
        userId: null,
        displayName: 'Coder',
        roleDesc: '',
        sortOrder: 0,
      },
    ],
    ownerUserId: null,
    visibility: 'public',
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

interface Recorded {
  calls: Array<{ url: string; method: string; body: unknown }>
  launchResponse?: () => Response
}

function installFetch(state: { workgroups: Workgroup[] } & Recorded): void {
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
      const launch = url.match(/\/api\/workgroups\/([^/]+)\/tasks$/)
      if (launch !== null && method === 'POST') {
        return state.launchResponse !== undefined
          ? state.launchResponse()
          : json({ id: 'task_new', status: 'pending' }, 201)
      }
      // RFC-165: the URL-only repo row lists cached mirrors for its dropdown.
      if (url.includes('/api/cached-repos')) {
        return json({ items: [] })
      }
      if (url.includes('/api/auth/me')) {
        return json({
          user: { id: 'u_me', username: 'me', displayName: 'Me', role: 'admin', status: 'active' },
          source: 'session',
          permissions: [],
          linkedIdentities: [],
          pats: [],
        })
      }
      if (url.includes('/api/users/search')) return json([])
      const one = url.match(/\/api\/workgroups\/([^/]+)$/)
      if (one !== null && method === 'GET') {
        const row = state.workgroups.find((w) => w.name === decodeURIComponent(one[1]!))
        return row !== undefined ? json(row) : json({ code: 'workgroup-not-found' }, 404)
      }
      if (url.endsWith('/api/workgroups') && method === 'GET') return json(state.workgroups)
      return json({})
    },
  )
}

async function renderPage(initialEntry: string) {
  const detail = await import('../src/routes/workgroups.detail')
  const launch = await import('../src/routes/workgroups.launch')
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const launchRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/workgroups/launch',
    component: launch.LaunchRoute.options.component,
    validateSearch: launch.LaunchRoute.options.validateSearch,
  })
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/workgroups/$name',
    component: detail.Route.options.component,
  })
  const taskStub = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks/$id',
    component: () => <div data-testid="task-detail-stub" />,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([launchRoute, detailRoute, taskStub]),
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

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('/workgroups/$name — launch entry gating', () => {
  test('a launch-ready group shows the button linking to /workgroups/launch?name=…', async () => {
    installFetch({ workgroups: [wg('review-squad')], calls: [] })
    await renderPage('/workgroups/review-squad')
    const btn = await screen.findByTestId('workgroup-launch-button')
    expect(btn.getAttribute('href')).toBe('/workgroups/launch?name=review-squad')
  })

  test('a not-ready group (no members) hides the launch button', async () => {
    installFetch({
      workgroups: [wg('empty-squad', { members: [], leaderMemberId: null })],
      calls: [],
    })
    await renderPage('/workgroups/empty-squad')
    await screen.findByTestId('workgroup-readiness-banner')
    expect(screen.queryByTestId('workgroup-launch-button')).toBeNull()
  })
})

describe('/workgroups/launch', () => {
  test('submit stays disabled until task name, goal AND repo URL are filled', async () => {
    installFetch({ workgroups: [wg('review-squad')], calls: [] })
    await renderPage('/workgroups/launch?name=review-squad')
    const submit = (await screen.findByTestId('workgroup-launch-submit')) as HTMLButtonElement
    // RFC-165: no recent-repo prefill anymore — the URL row starts blank, so
    // name + goal + repo URL are the three outstanding gates.
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByTestId('workgroup-launch-task-name'), {
      target: { value: 'audit run' },
    })
    expect((screen.getByTestId('workgroup-launch-submit') as HTMLButtonElement).disabled).toBe(true) // goal still empty
    fireEvent.change(screen.getByTestId('workgroup-launch-goal'), {
      target: { value: 'find the bugs' },
    })
    expect((screen.getByTestId('workgroup-launch-submit') as HTMLButtonElement).disabled).toBe(true) // repo URL still empty
    fireEvent.change(screen.getByTestId('repo-source-url-0'), {
      target: { value: 'git@github.com:o/r.git' },
    })
    await waitFor(() => {
      expect((screen.getByTestId('workgroup-launch-submit') as HTMLButtonElement).disabled).toBe(
        false,
      )
    })
  })

  test('launch POSTs name/goal/repo to /api/workgroups/:name/tasks and navigates to the task', async () => {
    const state = { workgroups: [wg('review-squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    const router = await renderPage('/workgroups/launch?name=review-squad')
    await screen.findByTestId('workgroup-launch-submit')
    fireEvent.change(screen.getByTestId('workgroup-launch-task-name'), {
      target: { value: 'audit run' },
    })
    fireEvent.change(screen.getByTestId('workgroup-launch-goal'), {
      target: { value: 'find the bugs' },
    })
    fireEvent.change(screen.getByTestId('repo-source-url-0'), {
      target: { value: 'git@github.com:o/r.git' },
    })
    await waitFor(() => {
      expect((screen.getByTestId('workgroup-launch-submit') as HTMLButtonElement).disabled).toBe(
        false,
      )
    })
    fireEvent.click(screen.getByTestId('workgroup-launch-submit'))

    await waitFor(() => {
      const post = state.calls.find(
        (c) => c.method === 'POST' && c.url.endsWith('/api/workgroups/review-squad/tasks'),
      )
      expect(post).toBeTruthy()
      const body = post?.body as Record<string, unknown>
      // Field-by-field (防静默丢字段): goal is the workgroup-specific one.
      expect(body.name).toBe('audit run')
      expect(body.goal).toBe('find the bugs')
      expect(body.repoUrl).toBe('git@github.com:o/r.git')
      // RFC-165: the retired path keys must never ride the wire.
      expect(body.repoPath).toBeUndefined()
      expect(body.baseBranch).toBeUndefined()
      expect(body.workflowId).toBeUndefined()
      expect(body.inputs).toBeUndefined()
    })
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/tasks/task_new')
    })
  })

  test('a 422 workgroup-not-ready response renders the friendly reason copy', async () => {
    const state: { workgroups: Workgroup[] } & Recorded = {
      workgroups: [wg('review-squad')],
      calls: [],
      launchResponse: () =>
        new Response(
          JSON.stringify({
            ok: false,
            code: 'workgroup-not-ready',
            message: 'workgroup is not launch-ready',
            details: { reasons: ['leader-missing'] },
          }),
          { status: 422, headers: { 'content-type': 'application/json' } },
        ),
    }
    installFetch(state)
    await renderPage('/workgroups/launch?name=review-squad')
    await screen.findByTestId('workgroup-launch-submit')
    fireEvent.change(screen.getByTestId('workgroup-launch-task-name'), {
      target: { value: 'audit run' },
    })
    fireEvent.change(screen.getByTestId('workgroup-launch-goal'), {
      target: { value: 'find the bugs' },
    })
    fireEvent.change(screen.getByTestId('repo-source-url-0'), {
      target: { value: 'git@github.com:o/r.git' },
    })
    await waitFor(() => {
      expect((screen.getByTestId('workgroup-launch-submit') as HTMLButtonElement).disabled).toBe(
        false,
      )
    })
    fireEvent.click(screen.getByTestId('workgroup-launch-submit'))
    const errorEl = await screen.findByTestId('workgroup-launch-error')
    expect(errorEl.textContent).toContain(
      'Leader-Worker mode needs one agent member designated as leader.',
    )
    // Friendly copy, not the raw code.
    expect(errorEl.textContent).not.toContain('workgroup-not-ready')
  })
})
