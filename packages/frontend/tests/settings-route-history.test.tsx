// RFC-198 PR4 / RFC-201 — rendered /settings URL-section and config-query
// continuity regressions.
//
// These tests mount the production SettingsPage under its real route id. They
// lock browser-history semantics (user tab changes push; canonicalization
// replaces), adjacent-search preservation, the legacy #runtime one-shot, and
// shared initial/stale config states. Source-only tests cannot catch a URL and
// visible panel drifting apart after Back/Forward.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { DEFAULT_CONFIG, type Config } from '@agent-workflow/shared'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('@/components/RuntimeList', () => ({
  RuntimeList: () => <div data-testid="runtime-list-stub" />,
}))

import '../src/i18n'
import { getConfigQueryKey } from '../src/lib/config-resource'
import { Route as SettingsRoute, validateSettingsSearch } from '../src/routes/settings'
import { setBaseUrl, setToken } from '../src/stores/auth'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function installFetch(
  handler: (path: string) => Response | Promise<Response> | undefined,
): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (request: RequestInfo | URL) => {
    const path = new URL(request.toString()).pathname
    const response = handler(path)
    if (response !== undefined) return response
    throw new Error(`unexpected fetch in settings route harness: ${path}`)
  })
}

function renderSettingsRoute(
  initialEntries: string[],
  options: {
    config?: Config
    staleTime?: number
  } = {},
) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: options.staleTime ?? Number.POSITIVE_INFINITY },
    },
  })
  if (options.config !== undefined) qc.setQueryData(getConfigQueryKey(), options.config)

  // SettingsPage calls hooks on its production Route object. A cloned route
  // with the same /settings id supplies that match while avoiding AppShell and
  // auth concerns in this focused harness.
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    validateSearch: validateSettingsSearch,
    component: SettingsRoute.options.component,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([settingsRoute]),
    history: createMemoryHistory({ initialEntries }),
  })
  const view = render(
    <QueryClientProvider client={qc}>
      {/* The test route tree intentionally differs from the generated app tree. */}
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
  return { qc, router, view }
}

class DesktopResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe = (target: Element) => {
    this.callback(
      [
        {
          target,
          contentRect: { width: 1024 },
          contentBoxSize: [{ inlineSize: 1024 }],
        } as unknown as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    )
  }

  disconnect = () => {}
  unobserve = () => {}
}

function sectionDestination(tab: string): HTMLAnchorElement {
  const link = Array.from(
    document.querySelectorAll<HTMLAnchorElement>('.page-section-nav__leaf'),
  ).find((candidate) => new URL(candidate.href).searchParams.get('tab') === tab)
  if (link === undefined) throw new Error(`missing Settings destination for ${tab}`)
  return link
}

function activePanel(tab: string): HTMLElement {
  const panel = document.querySelector<HTMLElement>(`.settings-section-panel--${tab}`)
  if (panel === null) throw new Error(`missing active Settings panel for ${tab}`)
  return panel
}

function expectActivePanel(tab: string): void {
  expect(sectionDestination(tab).getAttribute('aria-current')).toBe('page')
  expect(activePanel(tab).getAttribute('aria-labelledby')).toBe(`settings-section-title-${tab}`)
  expect(document.querySelectorAll('.settings-section-panel')).toHaveLength(1)
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', DesktopResizeObserver)
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('/settings rendered URL-backed tabs', () => {
  test('a Config draft survives active-panel unmount and browser tab history', async () => {
    installFetch(() => undefined)
    const { router } = renderSettingsRoute(['/settings?tab=limits&focus=keep'], {
      config: DEFAULT_CONFIG,
    })

    await waitFor(() => expectActivePanel('limits'))
    const limitsPanel = activePanel('limits')
    const duration = within(limitsPanel).getAllByRole('spinbutton')[0] as HTMLInputElement
    fireEvent.change(duration, { target: { value: '424242' } })
    expect(duration.value).toBe('424242')
    await waitFor(() => {
      expect(screen.getByRole('link', { name: /Limits.*(unsaved|未保存)/i })).toBeTruthy()
    })

    fireEvent.click(sectionDestination('network'))
    await waitFor(() => {
      expectActivePanel('network')
      expect(screen.getByRole('link', { name: /Limits.*(unsaved|未保存)/i })).toBeTruthy()
    })
    fireEvent.click(sectionDestination('limits'))
    await waitFor(() => {
      expectActivePanel('limits')
      expect(
        (within(activePanel('limits')).getAllByRole('spinbutton')[0] as HTMLInputElement).value,
      ).toBe('424242')
    })

    router.history.back()
    await waitFor(() => expectActivePanel('network'))
    router.history.forward()
    await waitFor(() => {
      expectActivePanel('limits')
      expect(
        (within(activePanel('limits')).getAllByRole('spinbutton')[0] as HTMLInputElement).value,
      ).toBe('424242')
      expect(router.state.location.search).toEqual({ tab: 'limits', focus: 'keep' })
    })
  })

  test('tab clicks push and Back/Forward preserve adjacent search parameters', async () => {
    installFetch(() => undefined)
    const { router } = renderSettingsRoute(['/settings?tab=limits&focus=runtime-card&trace=2'], {
      config: DEFAULT_CONFIG,
    })

    await waitFor(() => expectActivePanel('limits'))
    fireEvent.click(sectionDestination('appearance'))
    await waitFor(() => {
      expect(router.state.location.search).toEqual({
        focus: 'runtime-card',
        trace: 2,
        tab: 'appearance',
      })
      expectActivePanel('appearance')
    })

    router.history.back()
    await waitFor(() => {
      expect(router.state.location.search).toEqual({
        focus: 'runtime-card',
        trace: 2,
        tab: 'limits',
      })
      expectActivePanel('limits')
    })

    router.history.forward()
    await waitFor(() => {
      expect(router.state.location.search.tab).toBe('appearance')
      expectActivePanel('appearance')
    })
  })

  test('an invalid tab canonicalizes with replace and keeps the previous history entry', async () => {
    installFetch(() => undefined)
    const { router } = renderSettingsRoute(
      ['/before', '/settings?tab=not-a-tab&focus=keep&trace=3'],
      { config: DEFAULT_CONFIG },
    )

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ focus: 'keep', trace: 3, tab: 'runtime' })
      expectActivePanel('runtime')
    })

    router.history.back()
    await waitFor(() => expect(router.state.location.pathname).toBe('/before'))
  })

  test('#runtime is consumed once and its flash does not replay after tab history', async () => {
    installFetch(() => undefined)
    const { router } = renderSettingsRoute(['/settings?focus=keep#runtime'], {
      config: DEFAULT_CONFIG,
    })

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ focus: 'keep', tab: 'runtime' })
      expect(router.state.location.hash).toBe('')
      expect(document.querySelector('.runtime-status-anchor')?.getAttribute('data-flash')).toBe('1')
    })

    fireEvent.click(sectionDestination('appearance'))
    await waitFor(() => expectActivePanel('appearance'))
    router.history.back()
    await waitFor(() => {
      expectActivePanel('runtime')
      expect(router.state.location.hash).toBe('')
      expect(document.querySelector('.runtime-status-anchor')?.getAttribute('data-flash')).toBe('0')
    })
  })
})

describe('/settings rendered config-query states', () => {
  test('initial loading becomes a retryable error, then retry restores the requested panel', async () => {
    const first = deferred<Response>()
    let attempts = 0
    const fetchSpy = installFetch((path) => {
      if (path !== '/api/config') return undefined
      attempts += 1
      return attempts === 1 ? first.promise : json(DEFAULT_CONFIG)
    })
    const { router } = renderSettingsRoute(['/settings?tab=appearance&focus=keep'])

    await screen.findByTestId('loading-state')
    expectActivePanel('appearance')

    await act(async () => {
      first.resolve(json({ code: 'config-down', message: 'config unavailable' }, 503))
      await first.promise
    })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('config unavailable')

    fireEvent.click(screen.getByRole('button', { name: /重试|Retry/ }))
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      expect(screen.queryByRole('alert')).toBeNull()
      expect(router.state.location.search).toEqual({ tab: 'appearance', focus: 'keep' })
      expectActivePanel('appearance')
    })
  })

  test('a failed stale refetch keeps the cached panel visible beside the error', async () => {
    const fetchSpy = installFetch((path) =>
      path === '/api/config'
        ? json({ code: 'stale-config', message: 'refresh failed' }, 503)
        : undefined,
    )
    const { qc } = renderSettingsRoute(['/settings?tab=appearance'], {
      config: DEFAULT_CONFIG,
      staleTime: 0,
    })

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled()
      expect(screen.getByRole('alert').textContent).toContain('refresh failed')
      expectActivePanel('appearance')
      expect(document.querySelector('.settings-section-panel--appearance .form-grid')).toBeTruthy()
    })
    expect(qc.getQueryData(getConfigQueryKey())).toEqual(DEFAULT_CONFIG)
  })
})
