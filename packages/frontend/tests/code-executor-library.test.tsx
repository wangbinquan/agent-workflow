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
  setToken('executor-library-token')
  localStorage.setItem('aw-language', 'en-US')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test('executor library exposes every business executor kind without ActionTemplate jargon', async () => {
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
        permissions: [
          'action-templates:create',
          'digital-employees:create',
          'adapter-definitions:create',
        ],
      })
    }
    if (path === '/api/code/action-templates') {
      return json({
        items: [
          {
            id: 'agent-java',
            name: 'Java change Agent',
            capabilityId: 'change.implement',
            executorKind: 'agent',
            publishedRevision: 3,
          },
          {
            id: 'pipeline-script',
            name: 'Pipeline gate collector',
            capabilityId: 'pipeline.collect',
            executorKind: 'script',
            publishedRevision: 2,
          },
        ],
      })
    }
    if (path === '/api/code/digital-employees') {
      return json({
        items: [
          {
            id: 'employee-cpp',
            name: 'C++ dependency employee',
            publishedRevision: 1,
          },
        ],
      })
    }
    if (path === '/api/integrations/development-adapters') {
      return json({
        items: [
          {
            id: 'approval-system',
            name: 'Change approval system',
            purpose: 'approval',
            publishedRevision: 5,
          },
        ],
      })
    }
    return json({})
  })

  const page = await import('../src/routes/code.executors')
  const root = createRootRoute()
  const executors = createRoute({
    getParentRoute: () => root,
    path: '/code/executors',
    component: page.Route.options.component,
  })
  const router = createRouter({
    routeTree: root.addChildren([executors]),
    history: createMemoryHistory({ initialEntries: ['/code/executors'] }),
  })

  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )

  expect(await screen.findByText('Java change Agent')).toBeTruthy()
  expect(screen.getByText('Pipeline gate collector')).toBeTruthy()
  expect(screen.getByText('C++ dependency employee')).toBeTruthy()
  expect(screen.getByText('Change approval system')).toBeTruthy()
  expect(screen.getByText('Built-in platform actions')).toBeTruthy()
  expect(screen.getByText('Add AI executor').getAttribute('href')).toContain(
    '/code/config/action-templates',
  )
  expect(screen.queryByText('ActionTemplate')).toBeNull()
})
