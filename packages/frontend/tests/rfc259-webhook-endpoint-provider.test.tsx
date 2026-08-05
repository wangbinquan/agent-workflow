// RFC-259 — 端点卡的 provider 面（proposal AC-11）：
//   创建 Dialog 的 GitLab / GitHub 选择（radiogroup 语义）、POST 携带 provider、
//   GitHub 专属指引（content type application/json——最常见的接入误配）、
//   列表按行 provider 展示、一次性 secret Dialog 的 per-provider 粘贴指引。
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

import { WebhookEndpointCard } from '../src/components/WebhookEndpointCard'
import i18n from '../src/i18n'
import { setBaseUrl, setToken } from '../src/stores/auth'

const GITLAB_ROW = {
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

const GITHUB_ROW = {
  ...GITLAB_ROW,
  id: 'ep2',
  name: 'GitHub.com',
  provider: 'github',
  urlToken: 'aw_whk_tok2',
  ingressUrl: 'https://aw.example.com/webhooks/github/aw_whk_tok2',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

let endpoints: unknown[] = []
let createBodies: unknown[] = []

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const hostRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <WebhookEndpointCard />,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([hostRoute]),
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
  setBaseUrl(`http://webhook-provider-${crypto.randomUUID()}.test`)
  setToken('tok')
  endpoints = [GITLAB_ROW, GITHUB_ROW]
  createBodies = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString()
    const method = init?.method ?? 'GET'
    if (url.includes('/api/webhook-endpoints') && method === 'GET') {
      return jsonResponse(endpoints)
    }
    if (url.includes('/api/webhook-endpoints') && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { provider?: string }
      createBodies.push(body)
      return jsonResponse(
        {
          ...GITHUB_ROW,
          id: 'ep3',
          name: 'fresh',
          provider: body.provider ?? 'gitlab',
          secretHint: 'zz99',
          secret: 'one-time-secret-value-zz99',
        },
        201,
      )
    }
    return jsonResponse({})
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RFC-259 · WebhookEndpointCard provider 面（AC-11）', () => {
  test('列表按行显示 provider（GitLab / GitHub 并存）', async () => {
    renderCard()
    await waitFor(() => expect(screen.getByTestId('webhook-endpoint-ep2')).toBeTruthy())
    expect(screen.getByTestId('webhook-endpoint-provider-ep1').textContent).toBe('GitLab')
    expect(screen.getByTestId('webhook-endpoint-provider-ep2').textContent).toBe('GitHub')
  })

  test('创建 Dialog：provider radiogroup 默认 GitLab；选 GitHub 出现 content-type 指引并随 POST 提交', async () => {
    renderCard()
    await waitFor(() => expect(screen.getByTestId('webhook-endpoint-add')).toBeTruthy())
    fireEvent.click(screen.getByTestId('webhook-endpoint-add'))
    const dialog = await screen.findByTestId('webhook-endpoint-create-dialog')
    const group = within(dialog).getByRole('radiogroup', { name: /code host/i })
    const gitlab = within(group).getByRole('radio', { name: 'GitLab' })
    const github = within(group).getByRole('radio', { name: 'GitHub' })
    expect(gitlab.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(github)
    expect(github.getAttribute('aria-checked')).toBe('true')
    // GitHub 专属指引：content type 必须 application/json（最常见误配的前置提醒）
    expect(within(dialog).getByText(/application\/json/i)).toBeTruthy()

    fireEvent.change(within(dialog).getByTestId('webhook-endpoint-name'), {
      target: { value: 'GitHub.com' },
    })
    fireEvent.click(within(dialog).getByTestId('webhook-endpoint-create-submit'))
    await waitFor(() => expect(createBodies.length).toBe(1))
    expect((createBodies[0] as { provider?: string }).provider).toBe('github')
  })

  test('一次性 secret Dialog：github 端点显示 GitHub 粘贴指引（含 content type 提示）', async () => {
    renderCard()
    await waitFor(() => expect(screen.getByTestId('webhook-endpoint-add')).toBeTruthy())
    fireEvent.click(screen.getByTestId('webhook-endpoint-add'))
    const dialog = await screen.findByTestId('webhook-endpoint-create-dialog')
    fireEvent.click(within(dialog).getByRole('radio', { name: 'GitHub' }))
    fireEvent.change(within(dialog).getByTestId('webhook-endpoint-name'), {
      target: { value: 'GitHub.com' },
    })
    fireEvent.click(within(dialog).getByTestId('webhook-endpoint-create-submit'))
    const hint = await screen.findByTestId('webhook-endpoint-paste-hint')
    expect(hint.textContent).toContain('GitHub')
    expect(hint.textContent).toContain('application/json')
  })
})
