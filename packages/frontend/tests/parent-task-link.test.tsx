// RFC-245 — task-detail parent-task entry.
//
// A child execution (RFC-243: launched by a parent's call node) must be able to
// walk back UP. Until now /tasks/:id echoed nothing for `parentTaskId`, so the
// canvas jump this RFC introduces was one-way.
//
// The subtle part is the ACL degrade, so it is locked at BOTH real error shapes
// (design-gate P2-4 — the first draft modeled only 404):
//   - 403: the parent EXISTS but the viewer cannot read it (a workgroup human
//     member can be a member of the child task only) — routes/tasks.ts throws
//     ForbiddenError from assertTaskVisible.
//   - 404: the parent was deleted.
// Both must render the same neutral, non-link label, with no parent NAME, so the
// UI never leaks which of the two happened and never shows a dead link.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { ParentTaskLink } from '../src/components/tasks/ParentTaskLink'
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

function installFetch(reply: { status: number; body?: unknown }) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    return new Response(reply.body === undefined ? '{}' : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    })
  })
}

async function renderLink(showName = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const hostRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <ParentTaskLink taskId="t_child" parentTaskId="t_parent" showName={showName} />
    ),
  })
  const detailStub = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks/$id',
    component: () => <div data-testid="stub" />,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([hostRoute, detailStub]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
}

describe('ParentTaskLink (RFC-245)', () => {
  test('visible parent → link to /tasks/<parent>', async () => {
    installFetch({ status: 200, body: { id: 't_parent', name: 'parent task' } })
    await renderLink()
    await waitFor(() => {
      const el = screen.getByTestId('task-parent-chip-t_child')
      expect(el.tagName).toBe('A')
      expect(el.getAttribute('href')).toBe('/tasks/t_parent')
    })
  })

  test('showName renders the parent name once the probe resolved', async () => {
    installFetch({ status: 200, body: { id: 't_parent', name: 'nightly audit' } })
    await renderLink(true)
    await waitFor(() => {
      expect(screen.getByTestId('task-parent-chip-t_child').textContent).toContain('nightly audit')
    })
  })

  test('403 (exists but not visible) → neutral non-link label, no name', async () => {
    installFetch({ status: 403, body: { error: { code: 'task-not-visible' } } })
    await renderLink(true)
    await waitFor(() => {
      const el = screen.getByTestId('task-parent-chip-t_child')
      expect(el.tagName).not.toBe('A')
      expect(el.textContent).toBe(enUS.tasks.parentTaskUnavailable)
    })
  })

  test('404 (deleted) → the SAME neutral label (existence not disclosed)', async () => {
    installFetch({ status: 404, body: { error: { code: 'task-not-found' } } })
    await renderLink(true)
    await waitFor(() => {
      const el = screen.getByTestId('task-parent-chip-t_child')
      expect(el.tagName).not.toBe('A')
      expect(el.textContent).toBe(enUS.tasks.parentTaskUnavailable)
    })
  })

  test('access revoked mid-session: a later 403 demotes even though data is cached', async () => {
    // react-query keeps the last successful `data` next to a subsequent error,
    // so a data-first render would keep showing the parent's NAME and a live
    // link after the viewer lost access. Error must win.
    let denied = false
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (denied) {
        return new Response(JSON.stringify({ error: { code: 'task-not-visible' } }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ id: 't_parent', name: 'secret plan' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const rootRoute = createRootRoute({ component: () => <Outlet /> })
    const hostRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <ParentTaskLink taskId="t_child" parentTaskId="t_parent" showName />,
    })
    const detailStub = createRoute({
      getParentRoute: () => rootRoute,
      path: '/tasks/$id',
      component: () => <div data-testid="stub" />,
    })
    const router = createRouter({
      routeTree: rootRoute.addChildren([hostRoute, detailStub]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
    render(
      <QueryClientProvider client={qc}>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <RouterProvider router={router as any} />
      </QueryClientProvider>,
    )
    await waitFor(() => {
      expect(screen.getByTestId('task-parent-chip-t_child').textContent).toContain('secret plan')
    })

    denied = true
    await qc.refetchQueries({ queryKey: ['tasks', 't_parent'] })

    await waitFor(() => {
      const el = screen.getByTestId('task-parent-chip-t_child')
      expect(el.tagName).not.toBe('A')
      expect(el.textContent).toBe(enUS.tasks.parentTaskUnavailable)
      expect(el.textContent).not.toContain('secret plan')
    })
  })

  test('while the probe is in flight: no link and no name (never an optimistic dead link)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}))
    await renderLink(true)
    const el = await screen.findByTestId('task-parent-chip-t_child')
    expect(el.tagName).not.toBe('A')
    expect(el.textContent).toBe(enUS.tasks.parentTaskChip)
  })
})

describe('task detail wiring (source lock)', () => {
  const read = (rel: string) => readFileSync(resolve(import.meta.dirname, '..', rel), 'utf8')

  test('the detail header renders ParentTaskLink only for child tasks', () => {
    const src = read('src/routes/tasks.detail.tsx')
    expect(src).toMatch(/import \{ ParentTaskLink \} from '@\/components\/tasks\/ParentTaskLink'/)
    expect(src).toMatch(
      /tk\.parentTaskId != null && tk\.parentTaskId !== ''[\s\S]{0,200}<ParentTaskLink[\s\S]{0,120}showName/,
    )
  })

  test('there is exactly one parent-probe implementation in the app', () => {
    // The list surface gets `listContext.parentAvailability` from the server
    // (RFC-244); this component is the only client-side probe. A second copy
    // would drift on the ACL degrade.
    const detail = read('src/routes/tasks.detail.tsx')
    const component = read('src/components/tasks/ParentTaskLink.tsx')
    expect(component).toMatch(/queryKey: \['tasks', parentTaskId\]/)
    expect(detail).not.toMatch(/queryKey: \['tasks', parentTaskId\]/)
  })
})
