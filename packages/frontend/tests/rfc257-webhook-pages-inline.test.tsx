// RFC-257 UI 修订 — /webhooks 单页（route-ux-inventory 的 owner）。
// 锁：admin 三 tab（端点/触发器/投递）渲染与切换、triggers/deliveries 面板行、
// **非 admin 拒绝态**（页面级守卫——侧栏项过滤之外的直输 URL 兜底）。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import i18n from '../src/i18n'
import { setBaseUrl, setToken } from '../src/stores/auth'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

let role: 'admin' | 'user' = 'admin'
let triggers: unknown[] = []
let deliveries: unknown[] = []
let endpoints: unknown[] = []

function meResponse() {
  return {
    user: { id: 'u1', username: 'root', displayName: 'root', role, status: 'active' },
    source: 'session',
    permissions: [],
    linkedIdentities: [],
    pats: [],
  }
}

async function renderWebhooks(initialSearch = '') {
  const mod = await import('../src/routes/webhooks')
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const pageRoute = { ...mod.Route, options: mod.Route.options }
  // createRoute 已绑定 RootRoute（真 __root）；memory router 需要重新挂树 —
  // 直接复用组件与 validateSearch 构一个同路径 route。
  const { createRoute } = await import('@tanstack/react-router')
  void pageRoute
  const hosted = createRoute({
    getParentRoute: () => rootRoute,
    path: '/webhooks',
    validateSearch: mod.validateWebhooksSearch,
    component: mod.Route.options.component!,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([hosted]),
    history: createMemoryHistory({ initialEntries: [`/webhooks${initialSearch}`] }),
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
  setBaseUrl(`http://webhooks-page-${crypto.randomUUID()}.test`)
  setToken('tok')
  role = 'admin'
  triggers = []
  deliveries = []
  endpoints = [
    {
      id: 'ep1',
      name: 'Internal GitLab',
      provider: 'gitlab',
      urlToken: 'aw_whk_tok1',
      enabled: true,
      preferredCloneProtocol: 'http',
      hasSecret: true,
      secretHint: 'ab12',
      lastDeliveryAt: null,
      createdAt: 1,
      updatedAt: 1,
      ingressUrl: 'https://aw.example.com/webhooks/gitlab/aw_whk_tok1',
    },
  ]
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString()
    if (url.includes('/api/auth/me')) return jsonResponse(meResponse())
    if (url.includes('/api/webhook-triggers')) return jsonResponse(triggers)
    if (url.includes('/api/webhook-endpoints')) return jsonResponse(endpoints)
    // RFC-261：列表响应封套化；/repos 是仓库过滤下拉的选项源。
    if (url.includes('/api/webhook-deliveries/repos')) return jsonResponse([])
    if (url.includes('/api/webhook-deliveries'))
      return jsonResponse({
        items: deliveries,
        total: deliveries.length,
        page: 1,
        pageCount: 1,
      })
    if (url.includes('/api/workflows')) return jsonResponse([])
    if (url.includes('/api/agents')) return jsonResponse([])
    if (url.includes('/api/workgroups')) return jsonResponse([])
    return jsonResponse([])
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RFC-257 · /webhooks page (admin)', () => {
  test('renders the header, the three tabs, and the endpoints tab by default', async () => {
    await renderWebhooks()
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Webhook Automation' })).toBeTruthy()
    })
    expect(screen.getByTestId('webhooks-tab-endpoints')).toBeTruthy()
    expect(screen.getByTestId('webhooks-tab-triggers')).toBeTruthy()
    expect(screen.getByTestId('webhooks-tab-deliveries')).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId('webhook-endpoints')).toBeTruthy())
  })

  test('triggers tab renders the panel with a trigger row', async () => {
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
    await renderWebhooks('?tab=triggers')
    await waitFor(() => expect(screen.getByTestId('webhook-triggers-panel')).toBeTruthy())
    await waitFor(() => expect(screen.getByTestId('webhook-trigger-tr1')).toBeTruthy())
    expect(screen.getByText(/platform\/\*/)).toBeTruthy()
    expect(screen.getByText(/Pipeline failed/)).toBeTruthy()
  })

  test('deliveries tab renders the audit panel; rejected replay disabled', async () => {
    deliveries = [
      {
        id: 'd1',
        endpointId: 'ep1',
        eventUuid: 'u-1',
        attemptCount: 1,
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
    await renderWebhooks('?tab=deliveries')
    await waitFor(() => expect(screen.getByTestId('webhook-deliveries-panel')).toBeTruthy())
    await waitFor(() => expect(screen.getByTestId('webhook-delivery-d1')).toBeTruthy())
    const row = screen.getByTestId('webhook-delivery-d1')
    expect(within(row).getByText('Rejected')).toBeTruthy()
    expect((screen.getByTestId('webhook-delivery-replay-d1') as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  test('tab switching via the TabBar reaches the triggers panel', async () => {
    await renderWebhooks()
    await waitFor(() => expect(screen.getByTestId('webhooks-tab-triggers')).toBeTruthy())
    fireEvent.click(screen.getByTestId('webhooks-tab-triggers'))
    await waitFor(() => expect(screen.getByTestId('webhook-triggers-panel')).toBeTruthy())
  })

  test('new rule is a gated four-step flow and protects an unsaved draft on close', async () => {
    await renderWebhooks('?tab=triggers')
    await screen.findByTestId('webhook-trigger-new')
    await waitFor(() =>
      expect((screen.getByTestId('webhook-trigger-new') as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.click(screen.getByTestId('webhook-trigger-new'))

    expect(await screen.findByTestId('webhook-trigger-stepper')).toBeTruthy()
    expect(screen.getByTestId('stepper-step-scope')).toBeTruthy()
    expect(screen.getByTestId('stepper-step-events')).toBeTruthy()
    expect(screen.getByTestId('stepper-step-target')).toBeTruthy()
    expect(screen.getByTestId('stepper-step-review')).toBeTruthy()
    expect(screen.getByTestId('webhook-trigger-step-scope')).toBeTruthy()
    expect(screen.queryByTestId('webhook-trigger-step-events')).toBeNull()

    const next = screen.getByTestId('stepper-next') as HTMLButtonElement
    expect(next.disabled).toBe(true)
    fireEvent.change(screen.getByTestId('wt-name'), { target: { value: 'Repair failures' } })
    fireEvent.change(screen.getByTestId('wt-scope-prefix'), { target: { value: 'platform/' } })
    await waitFor(() => expect(next.disabled).toBe(false))
    fireEvent.click(next)
    expect(await screen.findByTestId('webhook-trigger-step-events')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(await screen.findByRole('heading', { name: 'Discard unsaved changes?' })).toBeTruthy()
    expect(screen.getByTestId('webhook-trigger-dialog')).toBeTruthy()
  })
})

describe('RFC-260 · /webhooks page (non-admin, read-only)', () => {
  // RFC-257 原语义是拒绝态（webhooks-forbidden）；RFC-260 显式改判为「读全员、
  // 写 admin」——user 看到只读视图，配置动作零渲染（真正边界在后端方法门与
  // URL 响应分层）。
  test('a user role sees the read-only page with zero configuration actions', async () => {
    role = 'user'
    await renderWebhooks()
    await waitFor(() => expect(screen.getByTestId('webhooks-tab')).toBeTruthy())
    expect(screen.queryByTestId('webhooks-forbidden')).toBeNull()
    expect(screen.getByTestId('webhook-endpoints')).toBeTruthy()
    // 端点 tab：无新建入口
    expect(screen.queryByTestId('webhook-endpoint-add')).toBeNull()
  })
})
