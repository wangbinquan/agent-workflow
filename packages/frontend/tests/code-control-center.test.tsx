import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'

import '../src/i18n'
import { setBaseUrl, setToken } from '../src/stores/auth'

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('token')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test('/code is a self-guided digital employee capability builder', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (request: RequestInfo | URL) => {
    const path = new URL(request.toString()).pathname
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    if (path === '/api/auth/me') {
      return json({
        user: {
          id: 'u-1',
          username: 'admin',
          displayName: 'Admin',
          role: 'admin',
          status: 'active',
        },
        source: 'session',
        linkedIdentities: [],
        pats: [],
        permissions: ['digital-employees:read', 'development-missions:launch'],
      })
    }
    if (path === '/api/code/setup-journey') {
      return json({
        schemaVersion: 1,
        journey: 'employee-setup',
        current: { key: 'define', ordinal: 1, total: 4, detailKey: 'setupDefineDetail' },
        next: {
          key: 'createEmployee',
          kind: 'navigate',
          detailKey: 'createEmployeeDetail',
          owner: 'current-user',
          href: '/code/config/employees?create=1',
          command: null,
          available: true,
          unavailableReason: null,
          wake: { source: null, resumeAt: null, deadlineAt: null, descriptionKey: null },
        },
        steps: [
          { key: 'define', state: 'current', owner: 'current-user', href: null },
          { key: 'publish', state: 'pending', owner: 'current-user', href: null },
          { key: 'assign', state: 'pending', owner: 'current-user', href: null },
          { key: 'launch', state: 'pending', owner: 'current-user', href: null },
        ],
        reasonRefs: ['employee-missing'],
        projectionRevision: 'setup-create',
      })
    }
    if (path === '/api/code/digital-employees') {
      return json({ items: [{ id: 'employee-1', publishedRevision: 2 }] })
    }
    if (path === '/api/code/automation-policies') {
      return json({ items: [{ id: 'policy-1', publishedRevision: 4 }] })
    }
    if (path === '/api/code/repository-assignments') {
      return json({ items: [{ scopeKind: 'repository', scopeRef: 'repo-1' }] })
    }
    if (path === '/api/code/missions') {
      return json({
        items: [
          { id: 'mission-1', status: 'ready-to-merge' },
          { id: 'mission-2', status: 'working' },
        ],
      })
    }
    if (path === '/api/code/work-items') return json({ items: [], nextCursor: null })
    return json({})
  })

  const page = await import('../src/routes/code')
  const root = createRootRoute()
  const code = createRoute({
    getParentRoute: () => root,
    path: '/code',
    component: page.Route.options.component,
  })
  const router = createRouter({
    routeTree: root.addChildren([code]),
    history: createMemoryHistory({ initialEntries: ['/code'] }),
  })

  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )

  expect(await screen.findByTestId('journey-next-action')).toBeTruthy()
  expect(screen.getByLabelText('Digital employee capability construction')).toBeTruthy()
  expect(screen.getByTestId('digital-employee-build-employees').getAttribute('href')).toBe(
    '/code/config/employees',
  )
  expect(screen.getByTestId('digital-employee-build-executors').getAttribute('href')).toBe(
    '/code/executors',
  )
  expect(screen.getByTestId('digital-employee-build-assignments').getAttribute('href')).toBe(
    '/code/assignments',
  )
  expect(screen.getByTestId('digital-employee-open-tasks').getAttribute('href')).toBe(
    '/tasks?type=digital-employee',
  )
  expect(screen.queryByTestId('mission-operations-board')).toBeNull()
})
