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
let actorRole: 'user' | 'manager' = 'user'
let actorUserId = 'u1'
let actorPermissions: string[] = []
let triggerRows: unknown[] = [TRIGGER_ROW]

beforeEach(async () => {
  empty = false
  actorRole = 'user'
  actorUserId = 'u1'
  actorPermissions = []
  triggerRows = [TRIGGER_ROW]
  await i18n.changeLanguage('en-US')
  setBaseUrl(`http://webhooks-readonly-${crypto.randomUUID()}.test`)
  setToken('tok')
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString()
    if (url.includes('/api/auth/me')) {
      return jsonResponse({
        user: {
          id: actorUserId,
          username: actorRole === 'manager' ? 'mgr' : 'dev',
          displayName: actorRole === 'manager' ? 'Manager' : 'dev',
          role: actorRole,
          status: 'active',
        },
        source: 'session',
        permissions: actorPermissions,
        linkedIdentities: [],
        pats: [],
      })
    }
    if (url.includes('/api/webhook-triggers')) return jsonResponse(empty ? [] : triggerRows)
    if (url.includes('/api/webhook-endpoints')) return jsonResponse(empty ? [] : [MASKED_ENDPOINT])
    if (url.includes('/api/users/lookup')) {
      return jsonResponse([
        {
          id: 'someone-else',
          username: 'root',
          displayName: 'Root',
          role: 'admin',
          status: 'active',
        },
        {
          id: 'manager-1',
          username: 'mgr',
          displayName: 'Manager',
          role: 'manager',
          status: 'active',
        },
      ])
    }
    // RFC-261：列表响应封套化；/repos 与详情要先于列表前缀匹配。
    if (url.includes('/api/webhook-deliveries/repos'))
      return jsonResponse(empty ? [] : ['acme/api'])
    if (url.includes('/api/webhook-deliveries/dl1'))
      return jsonResponse({
        ...DELIVERY_ROW,
        bodyJson: '{}',
        terminalControl: {
          kind: 'fence-closed',
          observedEventType: 'mr_closed',
          status: 'succeeded',
          revision: 2,
          attemptCount: 1,
          lastError: null,
          totalTargetCount: 2,
          hiddenTargetCount: 1,
          targets: [
            {
              taskId: 'task-visible',
              priorStatus: 'running',
              currentStatus: 'canceled',
              fenceOutcome: 'fenced-closed',
              cancelOutcome: 'canceled',
              releaseOutcome: 'released',
              error: null,
              workspace: { spaceKind: 'remote', state: 'pruned' },
            },
          ],
        },
      })
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
    const owner = screen.getByTestId('webhook-trigger-owner-tr1')
    expect(within(owner).getByText('Owner')).toBeTruthy()
    expect(await within(owner).findByText('Root')).toBeTruthy()
  })

  test('manager 可新建且只显示自己规则的编辑/开关/删除，他人规则只读', async () => {
    actorRole = 'manager'
    actorUserId = 'manager-1'
    actorPermissions = [
      'webhook-triggers:create',
      'webhook-triggers:update',
      'webhook-triggers:delete',
    ]
    triggerRows = [
      { ...TRIGGER_ROW, id: 'tr-mine', name: 'Mine', ownerUserId: 'manager-1' },
      { ...TRIGGER_ROW, id: 'tr-other', name: 'Other', ownerUserId: 'someone-else' },
    ]

    await renderWebhooks('?tab=triggers')
    const mine = await screen.findByTestId('webhook-trigger-tr-mine')
    const other = await screen.findByTestId('webhook-trigger-tr-other')

    expect(screen.getByTestId('webhook-trigger-new')).toBeTruthy()
    expect(within(mine).getByText('My rule')).toBeTruthy()
    expect(within(mine).getByTestId('webhook-trigger-enable-tr-mine')).toBeTruthy()
    expect(within(mine).getByTestId('webhook-trigger-edit-tr-mine')).toBeTruthy()
    expect(within(mine).getByRole('button', { name: /delete/i })).toBeTruthy()

    expect(await within(other).findByText('Root')).toBeTruthy()
    expect(within(other).queryByTestId('webhook-trigger-enable-tr-other')).toBeNull()
    expect(within(other).queryByTestId('webhook-trigger-edit-tr-other')).toBeNull()
    expect(within(other).queryByRole('button', { name: /delete/i })).toBeNull()
    expect(within(other).getByTestId('webhook-trigger-fires-tr-other')).toBeTruthy()
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
      expect(screen.getByText('No trigger rules have been created yet.')).toBeTruthy(),
    )
    expect(screen.queryByTestId('webhook-trigger-new')).toBeNull()
  })

  test('投递 tab：行与详情入口可见、无 replay 按钮', async () => {
    await renderWebhooks('?tab=deliveries')
    await waitFor(() => expect(screen.getByTestId('webhook-delivery-detail-dl1')).toBeTruthy())
    expect(screen.queryByTestId('webhook-delivery-replay-dl1')).toBeNull()
    fireEvent.click(screen.getByTestId('webhook-delivery-detail-dl1'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeTruthy())
    expect(await screen.findByTestId('webhook-terminal-control-audit')).toBeTruthy()
    expect(screen.getByText('task-visible')).toBeTruthy()
    expect(screen.getByTestId('webhook-terminal-control-hidden-targets').textContent).toContain(
      '1 matched task',
    )
    expect(document.body.textContent).not.toContain('task-hidden')
  })
})
