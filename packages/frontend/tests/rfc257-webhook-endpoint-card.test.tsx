// RFC-257 T10 — Settings → Webhook 端点卡片。
// 锁 secret 的一次性语义（AC-15 的前端面）：列表 GET 永远只有掩码 hint；
// 创建响应携带的明文只在「仅此一次」Dialog 里出现，关掉后无处再取。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { WebhookEndpointCard } from '../src/components/WebhookEndpointCard'
import i18n from '../src/i18n'
import { setBaseUrl, setToken } from '../src/stores/auth'

const LISTED = {
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
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

let endpoints: unknown[] = []

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const hostRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <WebhookEndpointCard />,
  })
  const triggersStub = createRoute({
    getParentRoute: () => rootRoute,
    path: '/webhook-triggers',
    component: () => <div />,
  })
  const deliveriesStub = createRoute({
    getParentRoute: () => rootRoute,
    path: '/webhook-deliveries',
    component: () => <div />,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([hostRoute, triggersStub, deliveriesStub]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
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
  setBaseUrl(`http://webhook-endpoint-${crypto.randomUUID()}.test`)
  setToken('tok')
  endpoints = [LISTED]
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString()
    const method = init?.method ?? 'GET'
    if (url.includes('/api/webhook-endpoints') && method === 'GET') {
      return jsonResponse(endpoints)
    }
    if (url.includes('/api/webhook-endpoints') && method === 'POST') {
      // 创建响应：一次性明文 secret（列表 GET 永远没有这个字段）
      const created = {
        ...LISTED,
        id: 'ep2',
        name: 'New GL',
        secretHint: 'zz99',
        secret: 'one-time-secret-value-zz99',
      }
      endpoints = [LISTED, { ...created, secret: undefined }]
      return jsonResponse(created, 201)
    }
    return jsonResponse({})
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RFC-257 · WebhookEndpointCard', () => {
  test('列表只展示掩码 hint 与 URL，绝无 secret 明文', async () => {
    renderCard()
    await waitFor(() => {
      expect(screen.getByTestId('webhook-endpoint-ep1')).toBeTruthy()
    })
    expect(screen.getByTestId('webhook-endpoint-url-ep1').textContent).toBe(LISTED.ingressUrl)
    expect(screen.getByText(/last 4: ab12/i)).toBeTruthy()
    expect(document.body.textContent).not.toContain('one-time-secret')
  })

  test('创建 → 一次性 secret Dialog 展示明文；关闭后明文从页面消失', async () => {
    renderCard()
    await waitFor(() => expect(screen.getByTestId('webhook-endpoint-add')).toBeTruthy())
    fireEvent.click(screen.getByTestId('webhook-endpoint-add'))
    const nameInput = await screen.findByTestId('webhook-endpoint-name')
    fireEvent.change(nameInput, { target: { value: 'New GL' } })
    fireEvent.click(screen.getByTestId('webhook-endpoint-create-submit'))
    const secretEl = await screen.findByTestId('webhook-endpoint-secret-value')
    expect(secretEl.textContent).toBe('one-time-secret-value-zz99')
    // 关闭一次性 Dialog 后明文不再出现在任何地方（列表只有 hint）
    fireEvent.click(screen.getByRole('button', { name: /I saved it/i }))
    await waitFor(() => {
      expect(screen.queryByTestId('webhook-endpoint-secret-value')).toBeNull()
    })
    expect(document.body.textContent).not.toContain('one-time-secret-value-zz99')
  })
})
