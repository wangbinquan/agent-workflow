// RFC-260 — /webhooks 非 admin 只读视图（proposal AC-5）：
//   三 tab 可见但配置动作零渲染（新建/编辑/删除/开关/轮换/replay/重置/复制），
//   hook URL 渲染后端脱敏形状（urlToken null + 尾 4 hint → 掩码文本），
//   空态文案分角色。admin 视图与现状逐像素一致由既有 rfc257/259 套件锁定
//  （组件 isAdmin 默认 false——评审门 F-8 的 fail-closed；那些测试显式传 isAdmin）。
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

import i18n from '../src/i18n'
import { setBaseUrl, setToken } from '../src/stores/auth'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** 后端脱敏形状（RFC-260 D3）：非 admin 的响应里 urlToken/ingressUrl 就是 null。 */
const MASKED_ENDPOINT = {
  id: 'ep1',
  name: 'Internal GitLab',
  provider: 'gitlab',
  urlToken: null,
  urlTokenHint: 'tok1',
  enabled: true,
  preferredCloneProtocol: 'http',
  hasSecret: true,
  secretHint: 'ab12',
  lastDeliveryAt: null,
  createdAt: 1,
  updatedAt: 1,
  ingressUrl: null,
}

const TRIGGER_ROW = {
  id: 'tr1',
  name: '别人的触发器',
  endpointId: 'ep1',
  ownerUserId: 'someone-else',
  enabled: true,
  repoScope: { kind: 'all' },
  eventTypes: ['push'],
  branchFilter: null,
  commandPrefix: null,
  ignoreUsernames: [],
  launchKind: 'workflow',
  launchRefId: 'wf1',
  launchPayload: { inputs: {} },
  migrationError: null,
  maxConsecutiveFires: 3,
  autoRegisterRepos: true,
  lastFiredAt: null,
  lastStatus: null,
  lastError: null,
  lastTaskId: null,
  consecutiveFailures: 0,
  createdAt: 1,
  updatedAt: 1,
}

const DELIVERY_ROW = {
  id: 'dl1',
  endpointId: 'ep1',
  eventUuid: 'uuid-1',
  attemptCount: 1,
  gitlabEventHeader: 'Push Hook',
  objectKind: 'push',
  eventType: 'push',
  repoPath: 'acme/api',
  streamHint: 'acme/api|branch:main',
  status: 'matched',
  statusReason: null,
  replayedFromDeliveryId: null,
  receivedAt: Date.now(),
}

async function renderWebhooks(initialSearch = '') {
  const mod = await import('../src/routes/webhooks')
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
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

let empty = false

beforeEach(async () => {
  empty = false
  await i18n.changeLanguage('en-US')
  setBaseUrl(`http://webhooks-readonly-${crypto.randomUUID()}.test`)
  setToken('tok')
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString()
    if (url.includes('/api/auth/me')) {
      return jsonResponse({
        user: { id: 'u1', username: 'dev', displayName: 'dev', role: 'user', status: 'active' },
        source: 'session',
        permissions: [],
        linkedIdentities: [],
        pats: [],
      })
    }
    if (url.includes('/api/webhook-triggers')) return jsonResponse(empty ? [] : [TRIGGER_ROW])
    if (url.includes('/api/webhook-endpoints')) return jsonResponse(empty ? [] : [MASKED_ENDPOINT])
    // RFC-261：列表响应封套化；/repos 与详情要先于列表前缀匹配。
    if (url.includes('/api/webhook-deliveries/repos'))
      return jsonResponse(empty ? [] : ['acme/api'])
    if (url.includes('/api/webhook-deliveries/dl1'))
      return jsonResponse({ ...DELIVERY_ROW, bodyJson: '{}' })
    if (url.includes('/api/webhook-deliveries'))
      return jsonResponse(
        empty
          ? { items: [], total: 0, page: 1, pageCount: 1 }
          : { items: [DELIVERY_ROW], total: 1, page: 1, pageCount: 1 },
      )
    return jsonResponse([])
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RFC-260 · 非 admin 只读视图（AC-5）', () => {
  test('端点 tab：掩码 URL 渲染、无新建/轮换/删除/复制/开关', async () => {
    await renderWebhooks()
    await waitFor(() => expect(screen.getByTestId('webhook-endpoint-ep1')).toBeTruthy())
    const masked = screen.getByTestId('webhook-endpoint-url-masked-ep1')
    expect(masked.textContent).toBe('/webhooks/gitlab/•••• tok1')
    expect(document.body.textContent).toContain('visible to administrators only')
    expect(screen.queryByTestId('webhook-endpoint-add')).toBeNull()
    expect(screen.queryByTestId('webhook-endpoint-rotate-ep1')).toBeNull()
    expect(screen.queryByRole('button', { name: /copy url/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
  })

  test('触发器 tab：行可见（他人 owner）、状态只读 chip、无新建/编辑/删除；触发记录按钮保留', async () => {
    await renderWebhooks('?tab=triggers')
    await waitFor(() => expect(screen.getByTestId('webhook-trigger-tr1')).toBeTruthy())
    expect(screen.queryByTestId('webhook-trigger-new')).toBeNull()
    expect(screen.queryByTestId('webhook-trigger-edit-tr1')).toBeNull()
    expect(screen.queryByTestId('webhook-trigger-enable-tr1')).toBeNull() // Switch → chip
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()
    expect(screen.getByTestId('webhook-trigger-fires-tr1')).toBeTruthy()
  })

  test('空态文案分角色：非 admin 版无「新建」引导、无 action 按钮（评审门 F-5c）', async () => {
    empty = true
    await renderWebhooks()
    await waitFor(() =>
      expect(
        screen.getByText('No ingress endpoints have been configured by an administrator yet.'),
      ).toBeTruthy(),
    )
    expect(screen.queryByTestId('webhook-endpoint-add')).toBeNull()
    cleanup()
    await renderWebhooks('?tab=triggers')
    await waitFor(() =>
      expect(
        screen.getByText('No trigger rules have been created by an administrator yet.'),
      ).toBeTruthy(),
    )
    expect(screen.queryByTestId('webhook-trigger-new')).toBeNull()
  })

  test('投递 tab：行与详情入口可见、无 replay 按钮', async () => {
    await renderWebhooks('?tab=deliveries')
    await waitFor(() => expect(screen.getByTestId('webhook-delivery-detail-dl1')).toBeTruthy())
    expect(screen.queryByTestId('webhook-delivery-replay-dl1')).toBeNull()
    fireEvent.click(screen.getByTestId('webhook-delivery-detail-dl1'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeTruthy())
  })
})
