// RFC-198 PR4 — /memory must wait for the actor query before choosing its
// admin/non-admin surface. These rendered regressions prevent a cold-start
// forbidden flash and keep the truthful permission branch visible when a
// background actor refresh fails.

import type { MemoryDistillJob } from '@agent-workflow/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { MeResponse } from '../src/hooks/useActor'
import i18n from '../src/i18n'
import { enUS } from '../src/i18n/en-US'
import { Route as MemoryRoute } from '../src/routes/memory'
import { clearToken, setBaseUrl, setToken } from '../src/stores/auth'

vi.mock('../src/hooks/useMemoryWs', async () => {
  const actual = await vi.importActual('../src/hooks/useMemoryWs')
  return { ...actual, useMemoryWs: () => undefined }
})

vi.mock('../src/hooks/useMemoryDistillJobWs', async () => {
  const actual = await vi.importActual('../src/hooks/useMemoryDistillJobWs')
  return { ...actual, useMemoryDistillJobWs: () => undefined }
})

const userActor: MeResponse = {
  user: {
    id: 'u1',
    username: 'alice',
    displayName: 'Alice',
    role: 'user',
    status: 'active',
  },
  source: 'session',
  permissions: ['memory:approve'],
  linkedIdentities: [],
  pats: [],
}

const adminActor: MeResponse = {
  ...userActor,
  user: { ...userActor.user, id: 'admin-1', username: 'admin', role: 'admin' },
}

const distillJob: MemoryDistillJob = {
  id: 'job-1',
  debounceKey: 'scope-1',
  sourceKind: 'feedback',
  sourceEventId: 'event-1',
  taskId: null,
  scopeResolved: { agentIds: [], workflowId: null, repoId: null, includeGlobal: true },
  status: 'failed',
  attempts: 1,
  nextRunAt: 0,
  lastError: 'cached failure',
  createdAt: 1,
  startedAt: null,
  finishedAt: null,
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function renderMemory(client: QueryClient, initialEntry = '/memory?tab=distill-jobs') {
  const root = createRootRoute({ component: () => <Outlet /> })
  const memory = createRoute({
    getParentRoute: () => root,
    path: '/memory',
    component: MemoryRoute.options.component,
    validateSearch: MemoryRoute.options.validateSearch,
  })
  const router = createRouter({
    routeTree: root.addChildren([memory]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  render(
    <QueryClientProvider client={client}>
      {/* Test route types intentionally differ from the generated app tree. */}
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  cleanup()
  clearToken()
  vi.restoreAllMocks()
})

describe('/memory actor query continuity', () => {
  test('cold start renders LoadingState without flashing admin or forbidden content', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request: RequestInfo | URL) => {
      const path = new URL(request.toString()).pathname
      if (path === '/api/auth/me') return new Promise<Response>(() => {})
      throw new Error(`unexpected memory request: ${path}`)
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    renderMemory(client)

    expect(await screen.findByRole('heading', { level: 1, name: enUS.memory.title })).toBeTruthy()
    expect(screen.getByTestId('loading-state')).toBeTruthy()
    expect(screen.queryByTestId('memory-tab-bar')).toBeNull()
    expect(screen.queryByTestId('memory-distill-jobs-admin-only')).toBeNull()
    expect(screen.queryByTestId('memory-distill-jobs')).toBeNull()
  })

  test('initial actor error hides permission content and exposes a working retry', async () => {
    let failActor = true
    let actorRequests = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request: RequestInfo | URL) => {
      const path = new URL(request.toString()).pathname
      if (path === '/api/auth/me') {
        actorRequests += 1
        return failActor
          ? json({ code: 'actor-unavailable', message: 'Actor lookup failed' }, 503)
          : json(userActor)
      }
      throw new Error(`unexpected memory request: ${path}`)
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    renderMemory(client)

    expect((await screen.findByRole('alert')).textContent).toContain('Actor lookup failed')
    expect(screen.queryByTestId('memory-tab-bar')).toBeNull()
    expect(screen.queryByTestId('memory-distill-jobs-admin-only')).toBeNull()

    failActor = false
    fireEvent.click(screen.getByRole('button', { name: enUS.common.retry }))
    expect(await screen.findByTestId('memory-tab-bar')).toBeTruthy()
    expect(screen.getByTestId('memory-distill-jobs-admin-only')).toBeTruthy()
    expect(actorRequests).toBe(2)
  })

  test('stale admin actor error preserves admin content and recovers in place', async () => {
    let failActorRefresh = true
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request: RequestInfo | URL) => {
      const path = new URL(request.toString()).pathname
      if (path === '/api/auth/me') {
        return failActorRefresh
          ? json({ code: 'actor-refresh-failed', message: 'Actor refresh failed' }, 503)
          : json(adminActor)
      }
      throw new Error(`unexpected memory request: ${path}`)
    })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    })
    client.setQueryData(['auth', 'me', 'tok'], adminActor)
    client.setQueryData(['memory-distill-jobs', 'list'], { items: [distillJob] })

    renderMemory(client)

    expect(await screen.findByTestId('memory-distill-jobs')).toBeTruthy()
    await act(async () => {
      await client.refetchQueries({ queryKey: ['auth', 'me', 'tok'], exact: true })
    })
    expect((await screen.findByRole('alert')).textContent).toContain('Actor refresh failed')
    expect(screen.getByTestId('memory-distill-jobs')).toBeTruthy()
    expect(screen.queryByTestId('memory-distill-jobs-admin-only')).toBeNull()

    failActorRefresh = false
    fireEvent.click(
      within(screen.getByRole('alert')).getByRole('button', { name: enUS.common.retry }),
    )
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByTestId('memory-distill-jobs')).toBeTruthy()
  })
})
