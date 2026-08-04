// RFC-257 T11/T12 — 两个新路由页的渲染测试（route-ux-inventory 的 owner）。
// 锁：PageHeader 标题渲染、空态（EmptyState / 空列表文案）、列表行出现。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import i18n from '../src/i18n'
import { setBaseUrl, setToken } from '../src/stores/auth'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

let triggers: unknown[] = []
let deliveries: unknown[] = []

async function renderPath(path: '/webhook-triggers' | '/webhook-deliveries') {
  const mod =
    path === '/webhook-triggers'
      ? await import('../src/routes/webhook-triggers')
      : await import('../src/routes/webhook-deliveries')
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const pageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: mod.Route.options.component!,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([pageRoute]),
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  setBaseUrl(`http://webhook-pages-${crypto.randomUUID()}.test`)
  setToken('tok')
  triggers = []
  deliveries = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString()
    if (url.includes('/api/webhook-triggers')) return jsonResponse(triggers)
    if (url.includes('/api/webhook-endpoints')) return jsonResponse([])
    if (url.includes('/api/webhook-deliveries')) return jsonResponse(deliveries)
    return jsonResponse([])
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RFC-257 · /webhook-triggers page', () => {
  test('renders the PageHeader title and the empty state', async () => {
    await renderPath('/webhook-triggers')
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Webhook Triggers' })).toBeTruthy()
    })
    await waitFor(() => expect(screen.getByTestId('webhook-triggers-empty')).toBeTruthy())
  })

  test('renders a trigger row with rule summary and state chips', async () => {
    triggers = [
      {
        id: 'tr1',
        name: '修到绿',
        endpointId: 'ep1',
        ownerUserId: 'u1',
        enabled: true,
        repoScope: { kind: 'prefix', prefix: 'platform/' },
        eventTypes: ['pipeline_failed'],
        branchFilter: null,
        commandPrefix: null,
        ignoreUsernames: ['aw-bot'],
        launchKind: 'workflow',
        launchRefId: 'wf1',
        launchPayload: { inputs: {} },
        migrationError: null,
        maxConsecutiveFires: 3,
        autoRegisterRepos: true,
        lastFiredAt: null,
        lastStatus: 'launched',
        lastError: null,
        lastTaskId: null,
        consecutiveFailures: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    await renderPath('/webhook-triggers')
    await waitFor(() => expect(screen.getByTestId('webhook-trigger-tr1')).toBeTruthy())
    expect(screen.getByText(/platform\/\*/)).toBeTruthy()
    expect(screen.getByText(/Pipeline failed/)).toBeTruthy()
    expect(screen.getByText('Last launched')).toBeTruthy()
  })
})

describe('RFC-257 · /webhook-deliveries page', () => {
  test('renders the PageHeader title and the empty state', async () => {
    await renderPath('/webhook-deliveries')
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Webhook Deliveries' })).toBeTruthy()
    })
    await waitFor(() => expect(screen.getByTestId('webhook-deliveries-empty')).toBeTruthy())
  })

  test('renders a rejected delivery row; replay disabled with reason', async () => {
    deliveries = [
      {
        id: 'd1',
        endpointId: 'ep1',
        eventUuid: 'u-1',
        attemptCount: 2,
        gitlabEventHeader: 'Pipeline Hook',
        objectKind: 'pipeline',
        eventType: 'pipeline_failed',
        repoPath: 'platform/api',
        streamHint: 'platform/api|mr:42',
        status: 'rejected',
        statusReason: 'invalid-token',
        replayedFromDeliveryId: null,
        receivedAt: Date.now(),
      },
    ]
    await renderPath('/webhook-deliveries')
    await waitFor(() => expect(screen.getByTestId('webhook-delivery-d1')).toBeTruthy())
    const row = screen.getByTestId('webhook-delivery-d1')
    expect(within(row).getByText('Rejected')).toBeTruthy()
    const replayBtn = screen.getByTestId('webhook-delivery-replay-d1')
    expect((replayBtn as HTMLButtonElement).disabled).toBe(true)
  })
})
