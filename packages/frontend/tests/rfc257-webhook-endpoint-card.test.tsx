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
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../src/lib/clipboard', () => ({ copyText: vi.fn().mockResolvedValue(true) }))

import { WebhookEndpointCard } from '../src/components/WebhookEndpointCard'
import { meQueryOptions, type MeResponse } from '../src/hooks/useActor'
import i18n from '../src/i18n'
import { copyText } from '../src/lib/clipboard'
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
let rotateCalls = 0
let rotateFailuresRemaining = 0
let createCalls = 0
let meRefreshGate: ReturnType<typeof deferred<Response>> | null = null
let rotateGate: ReturnType<typeof deferred<Response>> | null = null

const GRANTED_USER_ACTOR: MeResponse = {
  user: { id: 'u1', username: 'dev', displayName: 'dev', role: 'user', status: 'active' },
  profile: {
    displayName: 'dev',
    email: 'dev@example.test',
    gitCommitIdentity: { name: 'dev', email: 'dev@example.test' },
  },
  source: 'session',
  permissions: ['webhook-endpoints:manage'],
  linkedIdentities: [],
  pats: [],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const hostRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <WebhookEndpointCard canManage />,
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
  return qc
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  setBaseUrl(`http://webhook-endpoint-${crypto.randomUUID()}.test`)
  setToken('tok')
  endpoints = [LISTED]
  rotateCalls = 0
  rotateFailuresRemaining = 0
  createCalls = 0
  meRefreshGate = null
  rotateGate = null
  vi.mocked(copyText).mockClear()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString()
    const method = init?.method ?? 'GET'
    if (url.includes('/api/auth/me')) {
      return meRefreshGate?.promise ?? jsonResponse(GRANTED_USER_ACTOR)
    }
    if (url.includes('/api/webhook-endpoints') && method === 'GET') {
      return jsonResponse(endpoints)
    }
    if (url.includes('/rotate-secret') && method === 'POST') {
      rotateCalls += 1
      if (rotateGate !== null) return rotateGate.promise
      if (rotateFailuresRemaining > 0) {
        rotateFailuresRemaining -= 1
        return jsonResponse({ code: 'rotate-failed', message: 'temporary rotation failure' }, 500)
      }
      return jsonResponse({
        ...LISTED,
        secretHint: 'rt99',
        secret: 'rotated-one-time-secret-rt99',
      })
    }
    if (url.includes('/api/webhook-endpoints') && method === 'POST') {
      createCalls += 1
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
    expect(screen.getByText(/•••• ab12/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('one-time-secret')
  })

  test('创建 → 一次性 secret Dialog 展示明文；关闭后明文从页面消失', async () => {
    const client = renderCard()
    await waitFor(() => expect(screen.getByTestId('webhook-endpoint-add')).toBeTruthy())
    fireEvent.click(screen.getByTestId('webhook-endpoint-add'))
    const nameInput = await screen.findByTestId('webhook-endpoint-name')
    fireEvent.change(nameInput, { target: { value: 'New GL' } })
    fireEvent.click(screen.getByTestId('webhook-endpoint-create-submit'))
    const secretEl = await screen.findByTestId('webhook-endpoint-secret-value')
    expect(secretEl.textContent).toBe('one-time-secret-value-zz99')
    expect(
      JSON.stringify(
        client
          .getMutationCache()
          .getAll()
          .map((entry) => entry.state),
      ),
    ).not.toContain('one-time-secret-value-zz99')
    // 一次性密钥不能被 Escape 或遮罩误关掉。
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByTestId('webhook-endpoint-secret-value')).toBeTruthy()
    // 关闭一次性 Dialog 后明文不再出现在任何地方（列表只有 hint）
    fireEvent.click(screen.getByRole('button', { name: /I saved it/i }))
    await waitFor(() => {
      expect(screen.queryByTestId('webhook-endpoint-secret-value')).toBeNull()
    })
    expect(document.body.textContent).not.toContain('one-time-secret-value-zz99')
  })

  // Regression for the plain-http/LAN path: the Secret copy action must pass
  // the one-time plaintext to the shared dialog-safe clipboard helper and
  // acknowledge success while the non-dismissible reveal Dialog remains open.
  test('一次性 secret 的复制按钮复制完整明文并反馈成功', async () => {
    renderCard()
    fireEvent.click(await screen.findByTestId('webhook-endpoint-add'))
    fireEvent.change(await screen.findByTestId('webhook-endpoint-name'), {
      target: { value: 'New GL' },
    })
    fireEvent.click(screen.getByTestId('webhook-endpoint-create-submit'))

    const revealDialog = await screen.findByTestId('webhook-endpoint-secret-dialog')
    fireEvent.click(within(revealDialog).getByRole('button', { name: 'Copy' }))

    await waitFor(() => expect(copyText).toHaveBeenCalledWith('one-time-secret-value-zz99'))
    expect(within(revealDialog).getByText('Copied', { selector: '[role="status"]' })).toBeTruthy()
    expect(screen.getByTestId('webhook-endpoint-secret-value').textContent).toBe(
      'one-time-secret-value-zz99',
    )
  })

  test('轮换 secret 必须先确认破坏性后果，确认前后端零写入', async () => {
    renderCard()
    const trigger = await screen.findByTestId('webhook-endpoint-rotate-ep1')
    trigger.focus()

    fireEvent.click(trigger)

    expect(await screen.findByRole('heading', { name: 'Rotate this secret?' })).toBeTruthy()
    expect(screen.getByText(/old secret.*stop working immediately/i)).toBeTruthy()
    expect(rotateCalls).toBe(0)

    const confirmDialog = screen.getByRole('dialog', { name: 'Rotate this secret?' })
    const confirm = within(confirmDialog).getByRole('button', { name: 'Rotate secret' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)

    await waitFor(() => expect(rotateCalls).toBe(1))
    expect((await screen.findByTestId('webhook-endpoint-secret-value')).textContent).toBe(
      'rotated-one-time-secret-rt99',
    )
    fireEvent.click(screen.getByRole('button', { name: /I saved it/i }))
    await waitFor(() => expect(screen.queryByTestId('webhook-endpoint-secret-value')).toBeNull())
    expect(document.activeElement).toBe(trigger)
    expect(document.body.style.overflow).toBe('')
  })

  test('取消或 Escape 关闭轮换确认时零写入并回焦原按钮', async () => {
    renderCard()
    const trigger = await screen.findByTestId('webhook-endpoint-rotate-ep1')
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'Rotate this secret?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Rotate this secret?' })).toBeNull(),
    )
    expect(rotateCalls).toBe(0)
    expect(document.activeElement).toBe(trigger)

    fireEvent.click(trigger)
    await screen.findByRole('dialog', { name: 'Rotate this secret?' })
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Rotate this secret?' })).toBeNull(),
    )
    expect(rotateCalls).toBe(0)
    expect(document.activeElement).toBe(trigger)
  })

  test('轮换失败保留同一确认会话，显式重试才发第二次写入', async () => {
    rotateFailuresRemaining = 1
    renderCard()
    fireEvent.click(await screen.findByTestId('webhook-endpoint-rotate-ep1'))
    const dialog = await screen.findByRole('dialog', { name: 'Rotate this secret?' })
    const confirm = within(dialog).getByRole('button', { name: 'Rotate secret' })

    fireEvent.click(confirm)
    await waitFor(() => expect(rotateCalls).toBe(1))
    expect(await within(dialog).findByText(/temporary rotation failure/i)).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'Rotate this secret?' })).toBe(dialog)
    expect(screen.queryByTestId('webhook-endpoint-secret-value')).toBeNull()

    fireEvent.click(confirm)
    await waitFor(() => expect(rotateCalls).toBe(2))
    expect((await screen.findByTestId('webhook-endpoint-secret-value')).textContent).toBe(
      'rotated-one-time-secret-rt99',
    )
  })

  test('cached management grant refetch fetching/error closes the draft and an invoked connected stale submit sends zero POST', async () => {
    const client = renderCard()
    fireEvent.click(await screen.findByTestId('webhook-endpoint-add'))
    fireEvent.change(await screen.findByTestId('webhook-endpoint-name'), {
      target: { value: 'stale endpoint' },
    })
    const staleSubmit = screen.getByTestId('webhook-endpoint-create-submit') as HTMLButtonElement
    let invocations = 0
    staleSubmit.addEventListener('click', () => {
      invocations += 1
    })
    meRefreshGate = deferred<Response>()
    let refresh!: Promise<void>
    act(() => {
      refresh = client.refetchQueries({ queryKey: meQueryOptions('tok').queryKey })
      fireEvent.click(staleSubmit)
    })
    expect(invocations).toBe(1)
    expect(createCalls).toBe(0)
    await waitFor(() => expect(screen.queryByTestId('webhook-endpoint-create-dialog')).toBeNull())

    await act(async () => {
      meRefreshGate?.reject(new Error('me unavailable'))
      await refresh
    })
    expect(client.getQueryData(meQueryOptions('tok').queryKey)).toEqual(GRANTED_USER_ACTOR)
    expect(screen.queryByTestId('webhook-endpoint-add')).toBeNull()
    expect(createCalls).toBe(0)
  })

  test('late rotate response after downgrade never reaches DOM or MutationCache and never resurrects', async () => {
    const client = renderCard()
    rotateGate = deferred<Response>()
    const staleCopy = await screen.findByTestId('webhook-endpoint-copy-url-ep1')
    let copyInvocations = 0
    staleCopy.addEventListener('click', () => {
      copyInvocations += 1
    })
    fireEvent.click(await screen.findByTestId('webhook-endpoint-rotate-ep1'))
    const dialog = await screen.findByRole('dialog', { name: 'Rotate this secret?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rotate secret' }))
    await waitFor(() => expect(rotateCalls).toBe(1))

    act(() => {
      client.setQueryData(meQueryOptions('tok').queryKey, {
        ...GRANTED_USER_ACTOR,
        permissions: [],
      })
      fireEvent.click(staleCopy)
    })
    expect(copyInvocations).toBe(1)
    expect(copyText).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Rotate this secret?' })).toBeNull(),
    )
    expect(document.body.textContent).not.toContain(LISTED.ingressUrl)
    expect(screen.queryByTestId('webhook-endpoint-copy-url-ep1')).toBeNull()

    const sentinel = 'late-rotated-secret-must-not-survive'
    await act(async () => {
      rotateGate?.resolve(jsonResponse({ ...LISTED, secret: sentinel }))
      await rotateGate?.promise
    })
    expect(document.body.textContent).not.toContain(sentinel)
    expect(
      JSON.stringify(
        client
          .getMutationCache()
          .getAll()
          .map((entry) => entry.state),
      ),
    ).not.toContain(sentinel)

    act(() => client.setQueryData(meQueryOptions('tok').queryKey, GRANTED_USER_ACTOR))
    await screen.findByTestId('webhook-endpoint-rotate-ep1')
    expect(document.body.textContent).not.toContain(sentinel)
  })

  test('token A late secret cannot enter token B management session or MutationCache', async () => {
    const client = renderCard()
    rotateGate = deferred<Response>()
    fireEvent.click(await screen.findByTestId('webhook-endpoint-rotate-ep1'))
    const dialog = await screen.findByRole('dialog', { name: 'Rotate this secret?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rotate secret' }))
    await waitFor(() => expect(rotateCalls).toBe(1))

    const actorB: MeResponse = {
      ...GRANTED_USER_ACTOR,
      user: { ...GRANTED_USER_ACTOR.user, id: 'u2', username: 'operator-b' },
    }
    act(() => {
      setToken('tok-b')
      client.setQueryData(meQueryOptions('tok-b').queryKey, actorB)
    })
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Rotate this secret?' })).toBeNull(),
    )

    const sentinel = 'token-a-secret-must-not-enter-token-b'
    await act(async () => {
      rotateGate?.resolve(jsonResponse({ ...LISTED, secret: sentinel }))
      await rotateGate?.promise
    })
    expect(document.body.textContent).not.toContain(sentinel)
    expect(
      JSON.stringify(
        client
          .getMutationCache()
          .getAll()
          .map((entry) => entry.state),
      ),
    ).not.toContain(sentinel)
  })
})
