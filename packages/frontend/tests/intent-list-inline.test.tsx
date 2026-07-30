// RFC-234 (T8) — /intent list locks:
//   1. Sessions render with title + status chip (inFlight → generating).
//   2. The create dialog POSTs {message, hint?} and navigates to the detail.
//   3. Start button disabled until a non-empty message exists.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Window as HappyWindow } from 'happy-dom'
import {
  RouterProvider,
  createBrowserHistory,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router'
import type { IntentSessionSummary } from '@agent-workflow/shared'
import { IntentCreateComposer } from '../src/components/intent/IntentCreateComposer'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { enUS } from '../src/i18n/en-US'
import '../src/i18n'

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})
afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function session(id: string, overrides: Partial<IntentSessionSummary> = {}): IntentSessionSummary {
  return {
    id,
    title: `goal-${id}`,
    status: 'active',
    contextRevision: 0,
    turnSeq: 2,
    commitSeq: 0,
    inFlight: false,
    currentDraftRevision: null,
    createdAt: 1,
    updatedAt: Date.now(),
    ...overrides,
  }
}

interface Recorded {
  calls: Array<{ url: string; method: string; body: unknown }>
}

function installFetch(rows: IntentSessionSummary[]): Recorded {
  const rec: Recorded = { calls: [] }
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (req: RequestInfo | URL, init?: RequestInit) => {
      const url = req.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      rec.calls.push({ url, method, body })
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      if (url.includes('/api/intent-sessions') && method === 'POST') {
        return json(session('new-one'), 201)
      }
      if (url.includes('/api/intent-sessions')) return json(rows)
      return json([])
    },
  )
  return rec
}

async function renderPage(initialEntry: string | string[] = '/intent', initialIndex?: number) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const list = await import('../src/routes/intent')
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/intent',
    component: list.Route.options.component,
    // Reuse the real search coercion so `?create=true&mountType=…` behaves
    // exactly like production (raw strings otherwise).
    validateSearch: list.Route.options.validateSearch,
  })
  const detailStub = createRoute({
    getParentRoute: () => rootRoute,
    path: '/intent/$sessionId',
    component: () => <div data-testid="detail-stub" />,
  })
  const agentsStub = createRoute({
    getParentRoute: () => rootRoute,
    path: '/agents',
    component: () => <div data-testid="agents-stub" />,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([listRoute, detailStub, agentsStub]),
    history: createMemoryHistory({
      initialEntries: typeof initialEntry === 'string' ? [initialEntry] : initialEntry,
      ...(initialIndex === undefined ? {} : { initialIndex }),
    }),
  })
  render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
  return { qc, router }
}

describe('RFC-234 /intent list', () => {
  test('rows render with status chips; in-flight shows generating', async () => {
    installFetch([session('a'), session('b', { inFlight: true })])
    await renderPage()
    await screen.findByText('goal-a')
    expect(screen.getByText('goal-b')).toBeTruthy()
    expect(screen.getByText(enUS.intent.statusRunning)).toBeTruthy()
    expect(screen.getByText(enUS.intent.statusActive)).toBeTruthy()
  })

  test('create dialog gates on message, POSTs and navigates to the detail', async () => {
    const rec = installFetch([])
    const { router } = await renderPage()
    await screen.findByText(enUS.intent.emptyTitle)
    const start = await screen.findByRole('button', { name: enUS.intent.startBuilding })
    expect((start as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByTestId('intent-create-message'), {
      target: { value: '  build an audit pipeline  ' },
    })
    expect((start as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(start)
    await waitFor(() => {
      const post = rec.calls.find(
        (call) => call.method === 'POST' && call.url.endsWith('/api/intent-sessions'),
      )
      expect(post?.body).toEqual({ message: 'build an audit pipeline' })
    })
    await screen.findByTestId('detail-stub')
    router.history.back()
    await waitFor(() => expect(router.state.location.pathname).toBe('/intent'))
    expect(router.state.location.search).toEqual({})
  })

  test('dialog focuses the goal input and restores focus to the inline composer', async () => {
    installFetch([])
    await renderPage('/intent?create=true')
    const dialog = await screen.findByRole('dialog')
    const dialogTextarea = within(dialog).getByTestId('intent-create-message')
    await waitFor(() => expect(document.activeElement).toBe(dialogTextarea))

    fireEvent.click(within(dialog).getByRole('button', { name: enUS.common.close }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('intent-create-message')),
    )
  })

  test('pending create locks every dialog dismiss path until the POST settles', async () => {
    let resolvePost: ((response: Response) => void) | undefined
    const postResponse = new Promise<Response>((resolve) => {
      resolvePost = resolve
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (req: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase()
        if (method === 'POST') return postResponse
        return new Response('[]', { headers: { 'content-type': 'application/json' } })
      },
    )

    const { router } = await renderPage(
      ['/agents?side=before', '/intent?create=true', '/agents?side=after'],
      1,
    )
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByTestId('intent-create-message'), {
      target: { value: 'build a pending workflow' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: enUS.intent.startBuilding }))

    const close = within(dialog).getByRole('button', {
      name: enUS.common.close,
    }) as HTMLButtonElement
    await waitFor(() => expect(close.disabled).toBe(true))
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.mouseDown(document.querySelector('.dialog__overlay') as HTMLElement)
    expect(screen.getByRole('dialog')).toBe(dialog)

    void router.navigate({ to: '/agents' })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(router.state.location.pathname).toBe('/intent')
    expect(router.state.location.search).toEqual({ create: true })

    resolvePost?.(
      new Response(JSON.stringify(session('pending-done')), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await screen.findByTestId('detail-stub')
    router.history.back()
    await waitFor(() => expect(router.state.location.pathname).toBe('/intent'))
    expect(router.state.location.search).toEqual({})
  })

  test('pending inline create synchronously blocks route leave and duplicate submit', async () => {
    let resolvePost: ((response: Response) => void) | undefined
    const postResponse = new Promise<Response>((resolve) => {
      resolvePost = resolve
    })
    const rec: Recorded = { calls: [] }
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (req: RequestInfo | URL, init?: RequestInit) => {
        const url = req.toString()
        const method = (init?.method ?? 'GET').toUpperCase()
        rec.calls.push({ url, method, body: init?.body })
        if (method === 'POST') return postResponse
        return new Response('[]', { headers: { 'content-type': 'application/json' } })
      },
    )

    const { router } = await renderPage(['/agents', '/intent'])
    await screen.findByText(enUS.intent.emptyTitle)
    const form = screen.getByTestId('intent-create-inline')
    fireEvent.change(screen.getByTestId('intent-create-message'), {
      target: { value: 'build exactly one inline session' },
    })
    fireEvent.submit(form)
    fireEvent.submit(form)
    await waitFor(() => expect(rec.calls.filter((call) => call.method === 'POST')).toHaveLength(1))

    void router.navigate({ to: '/agents' })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(router.state.location.pathname).toBe('/intent')

    resolvePost?.(
      new Response(JSON.stringify(session('inline-pending-done')), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await screen.findByTestId('detail-stub')
    router.history.back()
    await waitFor(() => expect(router.state.location.pathname).toBe('/intent'))
  })

  test('successful POST stays locked until its navigation transaction settles', async () => {
    const rec = installFetch([])
    let resolveNavigation: (() => void) | undefined
    const navigation = new Promise<void>((resolve) => {
      resolveNavigation = resolve
    })
    const onCreated = vi.fn(() => navigation)
    const pendingChanges: boolean[] = []
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <IntentCreateComposer
          variant="inline"
          onCreated={onCreated}
          onPendingChange={(pending) => pendingChanges.push(pending)}
        />
      </QueryClientProvider>,
    )

    const form = screen.getByTestId('intent-create-inline')
    const message = screen.getByTestId('intent-create-message') as HTMLTextAreaElement
    fireEvent.change(message, { target: { value: 'build and wait for navigation' } })
    fireEvent.submit(form)

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(message.disabled).toBe(true)
    const start = screen.getByRole('button', { name: enUS.common.creating }) as HTMLButtonElement
    expect(start.disabled).toBe(true)
    expect(pendingChanges[pendingChanges.length - 1]).toBe(true)
    fireEvent.submit(form)
    expect(rec.calls.filter((call) => call.method === 'POST')).toHaveLength(1)

    await act(async () => {
      resolveNavigation?.()
      await navigation
    })
    await waitFor(() => expect(pendingChanges[pendingChanges.length - 1]).toBe(false))
    expect(message.disabled).toBe(true)
    fireEvent.submit(form)
    expect(rec.calls.filter((call) => call.method === 'POST')).toHaveLength(1)
  })

  test('failed post-success navigation retries the route transaction without another POST', async () => {
    const rec = installFetch([])
    const routeFailure = new Error('detail navigation failed')
    const onCreated = vi
      .fn<(session: IntentSessionSummary) => Promise<void>>()
      .mockRejectedValueOnce(routeFailure)
      .mockResolvedValueOnce()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <IntentCreateComposer variant="inline" onCreated={onCreated} />
      </QueryClientProvider>,
    )

    fireEvent.change(screen.getByTestId('intent-create-message'), {
      target: { value: 'create once even if routing fails' },
    })
    fireEvent.submit(screen.getByTestId('intent-create-inline'))

    const retry = await screen.findByRole('button', { name: enUS.common.retry })
    expect(onCreated).toHaveBeenCalledTimes(1)
    expect(rec.calls.filter((call) => call.method === 'POST')).toHaveLength(1)
    fireEvent.click(retry)
    fireEvent.click(retry)
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: enUS.common.retry })).toBeNull(),
    )
    expect(rec.calls.filter((call) => call.method === 'POST')).toHaveLength(1)
  })

  test('pending browser history restores both Back and Forward by the signed index delta', async () => {
    const isolatedWindow = new HappyWindow({
      url: 'http://intent.test/agents?side=before',
    })
    const history = createBrowserHistory({ window: isolatedWindow })
    const list = await import('../src/routes/intent')
    let pending = true
    const onPopState = list.createIntentPendingPopGuard({
      isPending: () => pending,
      currentIndex: () => history.location.state.__TSR_index,
      restore: (delta) => isolatedWindow.history.go(delta),
    })
    const eventWindow = isolatedWindow as unknown as Window
    let unblock = (): void => {}

    try {
      history.push('/intent?create=true')
      history.flush()
      history.push('/agents?side=after')
      history.flush()
      isolatedWindow.history.back()
      await isolatedWindow.happyDOM.waitUntilComplete()
      await waitFor(() => expect(history.location.pathname).toBe('/intent'))

      eventWindow.addEventListener('popstate', onPopState, true)
      unblock = history.block({
        blockerFn: () => pending,
        enableBeforeUnload: () => pending,
      })
      const beforeUnload = new isolatedWindow.Event('beforeunload', {
        cancelable: true,
      })
      isolatedWindow.dispatchEvent(beforeUnload)
      expect(beforeUnload.defaultPrevented).toBe(true)

      history.forward()
      await isolatedWindow.happyDOM.waitUntilComplete()
      await waitFor(() => {
        expect(isolatedWindow.location.pathname).toBe('/intent')
        expect(history.location.pathname).toBe('/intent')
      })

      history.back()
      await isolatedWindow.happyDOM.waitUntilComplete()
      await waitFor(() => {
        expect(isolatedWindow.location.pathname).toBe('/intent')
        expect(history.location.pathname).toBe('/intent')
      })

      pending = false
      history.forward()
      await isolatedWindow.happyDOM.waitUntilComplete()
      await waitFor(() => {
        expect(isolatedWindow.location.pathname).toBe('/agents')
        expect(isolatedWindow.location.search).toBe('?side=after')
        expect(history.location.pathname).toBe('/agents')
      })
    } finally {
      eventWindow.removeEventListener('popstate', onPopState, true)
      unblock()
      history.destroy()
      await isolatedWindow.happyDOM.close()
    }
  })

  test('successful create navigates before a stalled list refresh can unlock the composer', async () => {
    installFetch([])
    const { qc, router } = await renderPage('/intent?create=true')
    const dialog = await screen.findByRole('dialog')
    await screen.findByText(enUS.intent.emptyTitle)
    vi.spyOn(qc, 'invalidateQueries').mockImplementation(() => new Promise<never>(() => {}))

    fireEvent.change(within(dialog).getByTestId('intent-create-message'), {
      target: { value: 'build without waiting for the list' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: enUS.intent.startBuilding }))

    await screen.findByTestId('detail-stub')
    expect(screen.queryByRole('dialog')).toBeNull()
    router.history.back()
    await waitFor(() => expect(router.state.location.pathname).toBe('/intent'))
    expect(router.state.location.search).toEqual({})
  })

  // User feedback 2026-07-28: the artifact type is a dropdown on plain
  // creates, and the MODIFY entry must not ask for it at all — the mounted
  // target IS the subject, and it rides the create POST as `mounts`.
  test('create shows the type dropdown; modify entry hides it and mounts the target', async () => {
    installFetch([])
    await renderPage('/intent?create=true')
    // Dialog auto-opened via search; the shared composer shows Auto.
    const createDialog = await screen.findByRole('dialog')
    expect(within(createDialog).getByText(enUS.intent.hintAuto)).toBeTruthy()
    expect(within(createDialog).queryByTestId('intent-modify-target')).toBeNull()
    const pinnedFooter = within(createDialog).getByTestId('intent-create-dialog-footer')
    const pinnedStart = within(pinnedFooter).getByRole('button', {
      name: enUS.intent.startBuilding,
    }) as HTMLButtonElement
    expect(createDialog.querySelector('.dialog__body')?.contains(pinnedStart)).toBe(false)
    expect(pinnedStart.form).toBe(within(createDialog).getByTestId('intent-create-dialog'))
    cleanup()

    const rec = installFetch([])
    await renderPage('/intent?create=true&mountType=agent&mountId=A1')
    const modifyDialog = await screen.findByRole('dialog')
    await within(modifyDialog).findByTestId('intent-modify-target')
    expect(within(modifyDialog).queryByText(enUS.intent.hintAuto)).toBeNull()
    fireEvent.change(within(modifyDialog).getByTestId('intent-create-message'), {
      target: { value: 'tweak the auditor' },
    })
    fireEvent.click(within(modifyDialog).getByRole('button', { name: enUS.intent.startBuilding }))
    await waitFor(() => {
      const post = rec.calls.find(
        (call) => call.method === 'POST' && call.url.endsWith('/api/intent-sessions'),
      )
      expect(post?.body).toEqual({
        message: 'tweak the auditor',
        mounts: [{ resourceType: 'agent', resourceId: 'A1' }],
      })
    })
  })
})
