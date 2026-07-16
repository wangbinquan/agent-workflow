// RFC-169 (T5) — ResourceSplitPage skeleton: card rendering, selection accent,
// search filter, "+ new" active state, the three list states (loading / error /
// empty), and the dirty dot driven through the SplitDirty context. Rendered in
// a real memory-history router (cards are <Link>s; the guard needs a router).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { useRef, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRoute,
  createRouter,
  useLocation,
  useParams,
} from '@tanstack/react-router'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { Route as RootRoute } from '../src/routes/__root'
import { ResourceSplitPage, type ResourceCardItem } from '../src/components/split/ResourceSplitPage'
import {
  useRegisterSplitDiscard,
  useReportSplitDirty,
  useSplitDirty,
  type SplitBusyRelease,
  type SplitDiscardHandler,
} from '../src/components/split/splitDirty'
import '../src/i18n'

const ITEMS: ResourceCardItem[] = [
  {
    key: 'code-worker',
    kind: 'agent',
    title: 'code-worker',
    subtitle: 'writes code',
    searchText: 'opencode 1 in 2 out',
    updatedAt: Date.now() - 60_000,
    to: '/agents/$name',
    params: { name: 'code-worker' },
  },
  {
    key: 'auditor',
    kind: 'agent',
    title: 'auditor',
    subtitle: 'audits diffs',
    to: '/agents/$name',
    params: { name: 'auditor' },
  },
]

function mockFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () => new Response('not found', { status: 404 }),
  )
}

/** A detail pane that reports a fixed dirty state up through the context. */
function DirtyDetail({ dirty }: { dirty: boolean }) {
  const { name } = useParams({ from: '/agents/$name' })
  useReportSplitDirty(name, dirty)
  return (
    <div data-testid="detail-pane" tabIndex={-1}>
      detail:{name}
    </div>
  )
}

function stubCompactViewport(initial: boolean) {
  let matches = initial
  const listeners = new Set<() => void>()
  const media = {
    get matches() {
      return matches
    },
    media: '(max-width: 1080px)',
    onchange: null,
    addEventListener: (_type: string, listener: () => void) => {
      listeners.add(listener)
    },
    removeEventListener: (_type: string, listener: () => void) => {
      listeners.delete(listener)
    },
    addListener: (listener: () => void) => {
      listeners.add(listener)
    },
    removeListener: (listener: () => void) => {
      listeners.delete(listener)
    },
    dispatchEvent: () => true,
  } as unknown as MediaQueryList
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => media),
  )
  return {
    setCompact(next: boolean) {
      matches = next
      for (const listener of [...listeners]) listener()
    },
  }
}

function ConcurrentBusyDetail() {
  const { beginBusy } = useSplitDirty()
  const firstReleaseRef = useRef<SplitBusyRelease | undefined>(undefined)
  const secondReleaseRef = useRef<SplitBusyRelease | undefined>(undefined)
  return (
    <div data-testid="detail-pane">
      <button
        type="button"
        data-testid="start-two-busy"
        onClick={() => {
          firstReleaseRef.current = beginBusy('code-worker')
          secondReleaseRef.current = beginBusy('code-worker')
        }}
      >
        start two
      </button>
      <button
        type="button"
        data-testid="release-first-busy"
        onClick={() => firstReleaseRef.current?.()}
      >
        release first
      </button>
      <button
        type="button"
        data-testid="release-second-busy"
        onClick={() => secondReleaseRef.current?.()}
      >
        release second
      </button>
    </div>
  )
}

function CompositeDiscardDetail({
  first,
  second,
}: {
  first: SplitDiscardHandler
  second: SplitDiscardHandler
}) {
  const { name } = useParams({ from: '/agents/$name' })
  useReportSplitDirty(name, true)
  useRegisterSplitDiscard(name, first)
  useRegisterSplitDiscard(name, second)
  return <div data-testid="detail-pane">detail:{name}</div>
}

function renderSplit(opts: {
  initial: string
  items?: ResourceCardItem[]
  isLoading?: boolean
  error?: unknown
  detailDirty?: boolean
  emptyDescription?: string
  emptyIcon?: ReactNode
  onRetry?: () => void
  concurrentBusy?: boolean
  discardHandlers?: readonly [SplitDiscardHandler, SplitDiscardHandler]
}) {
  mockFetch()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const layoutRoute = createRoute({
    getParentRoute: () => RootRoute,
    path: '/agents',
    component: function Layout() {
      const params = useParams({ strict: false }) as { name?: string }
      const isNew = useLocation().pathname === '/agents/new'
      return (
        <ResourceSplitPage
          title="Agents"
          items={opts.items}
          isLoading={opts.isLoading ?? false}
          error={opts.error ?? null}
          selectedKey={isNew ? null : (params.name ?? null)}
          newActive={isNew}
          newLabel="+ New agent"
          newTo="/agents/new"
          searchPlaceholder="Search…"
          emptyListText="No agents yet"
          emptyDescription={opts.emptyDescription}
          emptyIcon={opts.emptyIcon}
          onRetry={opts.onRetry}
          listTo="/agents"
          mobileBackLabel="Back to agents"
          mobileBackTestId="agents-mobile-back"
        >
          <Outlet />
        </ResourceSplitPage>
      )
    },
  })
  const indexRoute = createRoute({
    getParentRoute: () => layoutRoute,
    path: '/',
    component: () => <div data-testid="empty-pane">empty</div>,
  })
  const detailRoute = createRoute({
    getParentRoute: () => layoutRoute,
    path: '/$name',
    component: () =>
      opts.concurrentBusy ? (
        <ConcurrentBusyDetail />
      ) : opts.discardHandlers === undefined ? (
        <DirtyDetail dirty={opts.detailDirty ?? false} />
      ) : (
        <CompositeDiscardDetail first={opts.discardHandlers[0]} second={opts.discardHandlers[1]} />
      ),
  })
  const newRoute = createRoute({
    getParentRoute: () => layoutRoute,
    path: '/new',
    component: () => <div data-testid="new-pane">new</div>,
  })
  const tree = RootRoute.addChildren([layoutRoute.addChildren([newRoute, detailRoute, indexRoute])])
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: [opts.initial] }),
  })
  render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
  return router
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ResourceSplitPage — structure & three states', () => {
  test('renders cards with title + subtitle; index shows empty pane', async () => {
    renderSplit({ initial: '/agents', items: ITEMS })
    await waitFor(() => screen.getByTestId('split-card-code-worker'))
    const card = screen.getByTestId('split-card-code-worker')
    expect(within(card).getByText('code-worker')).toBeTruthy()
    expect(within(card).getByText('writes code')).toBeTruthy()
    expect(within(card).queryByText('Agent')).toBeNull()
    expect(card.querySelector('[data-icon="agent"]')).not.toBeNull()
    expect(card.querySelector('.split-card__updated time')).not.toBeNull()
    expect(screen.getByTestId('split-count').textContent).toBe('2 items')
    expect(screen.getByTestId('empty-pane')).toBeTruthy()
  })

  test('selected card gets the is-selected accent', async () => {
    renderSplit({ initial: '/agents/auditor', items: ITEMS })
    await waitFor(() => screen.getByTestId('detail-pane'))
    expect(screen.getByTestId('split-card-auditor').className).toContain('is-selected')
    expect(screen.getByTestId('split-card-auditor').getAttribute('aria-current')).toBe('page')
    expect(screen.getByTestId('split-card-code-worker').className).not.toContain('is-selected')
    expect(screen.getByTestId('split-card-code-worker').getAttribute('aria-current')).toBeNull()
  })

  test('search box filters cards (case-insensitive, title or subtitle)', async () => {
    renderSplit({ initial: '/agents', items: ITEMS })
    await waitFor(() => screen.getByTestId('split-card-code-worker'))
    fireEvent.change(screen.getByTestId('split-search'), { target: { value: 'AUDIT' } })
    expect(screen.queryByTestId('split-card-code-worker')).toBeNull()
    expect(screen.getByTestId('split-card-auditor')).toBeTruthy()
    // subtitle-only hit
    fireEvent.change(screen.getByTestId('split-search'), { target: { value: 'writes' } })
    expect(screen.getByTestId('split-card-code-worker')).toBeTruthy()
    expect(screen.queryByTestId('split-card-auditor')).toBeNull()
    // Visible operational facts are searchable too.
    fireEvent.change(screen.getByTestId('split-search'), { target: { value: 'opencode' } })
    expect(screen.getByTestId('split-card-code-worker')).toBeTruthy()
    expect(screen.queryByTestId('split-card-auditor')).toBeNull()
    expect(screen.getByTestId('split-count').textContent).toBe('1 item')
  })

  test('missing descriptions keep an explicit, muted fallback instead of collapsing the card', async () => {
    renderSplit({
      initial: '/agents',
      items: [
        {
          key: 'blank',
          kind: 'agent',
          title: 'blank',
          to: '/agents/$name',
          params: { name: 'blank' },
        },
      ],
    })
    const card = await screen.findByTestId('split-card-blank')
    expect(card.querySelector('.split-card__subtitle--empty')?.textContent).toBe('(no description)')
  })

  test('long agent names wrap beside the icon instead of using ellipsis', async () => {
    const longName = 'agent-'.padEnd(128, 'x')
    renderSplit({
      initial: '/agents',
      items: [
        {
          key: longName,
          kind: 'agent',
          title: longName,
          subtitle: 'long identifier',
          to: '/agents/$name',
          params: { name: longName },
        },
      ],
    })

    const card = await screen.findByTestId(`split-card-${longName}`)
    const title = card.querySelector('.split-card__identity .split-card__title')
    expect(title?.textContent).toBe(longName)
    expect(title?.querySelector('.split-card__name')).not.toBeNull()
  })

  test('filtered-to-nothing shows no-matches; genuinely empty list shows emptyListText', async () => {
    renderSplit({ initial: '/agents', items: ITEMS })
    await waitFor(() => screen.getByTestId('split-card-code-worker'))
    const search = screen.getByTestId('split-search') as HTMLInputElement
    fireEvent.change(search, { target: { value: 'zzz' } })
    expect(screen.getByTestId('split-empty').textContent).toContain('No matches')
    expect(screen.getAllByRole('link', { name: '+ New agent' })).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(search.value).toBe('')
    expect(document.activeElement).toBe(search)
    expect(screen.queryByTestId('split-empty')).toBeNull()
    expect(screen.getByTestId('split-card-code-worker')).toBeTruthy()

    cleanup()
    renderSplit({ initial: '/agents', items: [] })
    await waitFor(() => screen.getByTestId('split-empty'))
    expect(screen.getByTestId('split-empty').textContent).toContain('No agents yet')
  })

  test('genuine empty metadata and retry stay inside the list without clearing stale cards', async () => {
    renderSplit({
      initial: '/agents',
      items: [],
      emptyDescription: 'Create the first agent when you are ready.',
      emptyIcon: <svg data-testid="empty-icon" />,
    })
    const empty = await screen.findByTestId('split-empty')
    expect(empty.className).not.toContain('empty-state--compact')
    expect(empty.textContent).toContain('Create the first agent when you are ready.')
    expect(screen.getByTestId('empty-icon')).toBeTruthy()

    cleanup()
    const onRetry = vi.fn()
    renderSplit({ initial: '/agents', items: ITEMS, error: new Error('boom'), onRetry })
    await waitFor(() => screen.getByTestId('split-card-code-worker'))
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByTestId('split-card-auditor')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  test('"+ new" button is active on /new; index route is not', async () => {
    renderSplit({ initial: '/agents/new', items: ITEMS })
    await waitFor(() => screen.getByTestId('new-pane'))
    expect(screen.getByTestId('split-new-button').className).toContain('is-active')
  })

  test('the rail owns the only create CTA; the index detail gets no synthesized duplicate', async () => {
    renderSplit({ initial: '/agents', items: ITEMS })
    await waitFor(() => screen.getByTestId('empty-pane'))
    expect(screen.getAllByRole('link', { name: '+ New agent' })).toHaveLength(1)
    expect(
      within(screen.getByTestId('split-detail')).queryByRole('link', { name: '+ New agent' }),
    ).toBeNull()
  })

  test('compact cards keep keyboard focus, two-line descriptions, and semantic summary chrome', () => {
    const css = readFileSync(
      path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src/styles.css'),
      'utf8',
    )
    expect(css).toContain('.split-card:focus-visible')
    expect(css).toContain('.split-card__icon')
    expect(css).toContain('-webkit-line-clamp: 2')
    expect(css).toContain('.split-card__summary')
    expect(css).toMatch(
      /\.content:has\(\.page--split\)\s*\{[^}]*padding-inline:\s*var\(--space-4\);/s,
    )
    expect(css).toMatch(/\.split__cards > \.split-card\s*\{[^}]*flex-shrink:\s*0;/s)
    expect(css).toMatch(
      /\.split-card--agent \.split-card__name\s*\{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/s,
    )
    expect(css).toMatch(
      /\.split-card__badges \.data-table__owner\s*\{[^}]*text-overflow: ellipsis/s,
    )
    expect(css).toContain('@media (forced-colors: active)')
  })
})

describe('ResourceSplitPage — mobile list/detail DOM contract', () => {
  test('CSS switches exactly one split pane at the 1080px compact breakpoint', () => {
    const css = readFileSync(
      path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src/styles.css'),
      'utf8',
    )
    expect(css).toMatch(/@media \(max-width: 1080px\)[\s\S]*?data-mobile-view='list'/)
    expect(css).toMatch(/data-mobile-view='detail'[\s\S]*?\.split__list[\s\S]*?display: none/)
    expect(css).toMatch(/\.split__mobile-back[\s\S]*?display: inline-flex/)
  })

  test('view state comes only from route props and detail exposes one router back link', async () => {
    const router = renderSplit({ initial: '/agents/code-worker', items: ITEMS })
    await waitFor(() => screen.getByTestId('detail-pane'))
    const page = screen.getByTestId('split-detail').closest('.page--split')
    expect(page?.getAttribute('data-mobile-view')).toBe('detail')

    const back = screen.getByTestId('agents-mobile-back')
    expect(back.getAttribute('href')).toBe('/agents')
    expect(screen.getAllByRole('link', { name: 'Back to agents' })).toHaveLength(1)

    fireEvent.click(back)
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents'))
    expect(page?.getAttribute('data-mobile-view')).toBe('list')
    expect(screen.queryByTestId('agents-mobile-back')).toBeNull()
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('split-card-code-worker')),
    )
  })

  test('compact route entry and 1081→1080 resize move only soon-hidden list focus', async () => {
    const viewport = stubCompactViewport(true)
    const router = renderSplit({ initial: '/agents', items: ITEMS })
    const card = await screen.findByTestId('split-card-code-worker')
    card.focus()
    fireEvent.click(card)
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents/code-worker'))
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('agents-mobile-back')),
    )

    act(() => viewport.setCompact(false))
    const detail = screen.getByTestId('detail-pane')
    detail.focus()
    act(() => viewport.setCompact(true))
    expect(document.activeElement).toBe(detail)

    act(() => viewport.setCompact(false))
    screen.getByTestId('split-card-auditor').focus()
    act(() => viewport.setCompact(true))
    expect(document.activeElement).toBe(screen.getByTestId('agents-mobile-back'))

    // Real Chromium may drop the hidden link to body before matchMedia's
    // callback. The remembered pane owner must still restore a useful target.
    act(() => viewport.setCompact(false))
    const auditor = screen.getByTestId('split-card-auditor')
    auditor.focus()
    auditor.blur()
    expect(document.activeElement).toBe(document.body)
    act(() => viewport.setCompact(true))
    expect(document.activeElement).toBe(screen.getByTestId('agents-mobile-back'))
  })

  test('back navigation uses the existing dirty blocker before restoring list focus', async () => {
    const router = renderSplit({
      initial: '/agents/code-worker',
      items: ITEMS,
      detailDirty: true,
    })
    await waitFor(() => screen.getByTestId('split-card-dot-code-worker'))

    fireEvent.click(screen.getByTestId('agents-mobile-back'))
    await waitFor(() => screen.getByTestId('unsaved-guard-dialog'))
    expect(router.state.location.pathname).toBe('/agents/code-worker')
    expect(
      screen.getByTestId('split-detail').closest('.page--split')?.getAttribute('data-mobile-view'),
    ).toBe('detail')

    fireEvent.click(screen.getByTestId('unsaved-discard'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents'))
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('split-card-code-worker')),
    )
  })

  test('list focus falls back to the first visible card, then the create action', async () => {
    const firstRouter = renderSplit({ initial: '/agents/missing', items: ITEMS })
    await waitFor(() => screen.getByTestId('detail-pane'))
    fireEvent.click(screen.getByTestId('agents-mobile-back'))
    await waitFor(() => expect(firstRouter.state.location.pathname).toBe('/agents'))
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('split-card-code-worker')),
    )

    cleanup()
    const emptyRouter = renderSplit({ initial: '/agents/missing', items: [] })
    await waitFor(() => screen.getByTestId('detail-pane'))
    fireEvent.click(screen.getByTestId('agents-mobile-back'))
    await waitFor(() => expect(emptyRouter.state.location.pathname).toBe('/agents'))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('split-new-button')))
  })

  test('new route is detail state and returns focus to the first card', async () => {
    const router = renderSplit({ initial: '/agents/new', items: ITEMS })
    await waitFor(() => screen.getByTestId('new-pane'))
    expect(
      screen.getByTestId('split-detail').closest('.page--split')?.getAttribute('data-mobile-view'),
    ).toBe('detail')
    fireEvent.click(screen.getByTestId('agents-mobile-back'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents'))
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('split-card-code-worker')),
    )
  })
})

describe('ResourceSplitPage — dirty dot via context', () => {
  test('a dirty detail draws the dot on its matching card only', async () => {
    renderSplit({ initial: '/agents/code-worker', items: ITEMS, detailDirty: true })
    await waitFor(() => screen.getByTestId('detail-pane'))
    await waitFor(() => expect(screen.queryByTestId('split-card-dot-code-worker')).not.toBeNull())
    expect(screen.queryByTestId('split-card-dot-auditor')).toBeNull()
  })

  test('a clean detail draws no dot', async () => {
    renderSplit({ initial: '/agents/code-worker', items: ITEMS, detailDirty: false })
    await waitFor(() => screen.getByTestId('detail-pane'))
    expect(screen.queryByTestId('split-card-dot-code-worker')).toBeNull()
  })
})

describe('ResourceSplitPage — busy tokens and composite discard', () => {
  test('concurrent busy tokens are independent and each release is idempotent', async () => {
    const router = renderSplit({
      initial: '/agents/code-worker',
      items: ITEMS,
      concurrentBusy: true,
    })
    await screen.findByTestId('detail-pane')
    fireEvent.click(screen.getByTestId('start-two-busy'))
    fireEvent.click(screen.getByTestId('agents-mobile-back'))

    await screen.findByTestId('unsaved-guard-dialog')
    expect(screen.queryByTestId('unsaved-discard')).toBeNull()
    expect(router.state.location.pathname).toBe('/agents/code-worker')

    fireEvent.click(screen.getByTestId('release-first-busy'))
    fireEvent.click(screen.getByTestId('release-first-busy'))
    expect(screen.getByTestId('unsaved-guard-dialog')).toBeTruthy()

    fireEvent.click(screen.getByTestId('release-second-busy'))
    await waitFor(() => expect(screen.queryByTestId('unsaved-guard-dialog')).toBeNull())
    expect(router.state.location.pathname).toBe('/agents/code-worker')

    fireEvent.click(screen.getByTestId('agents-mobile-back'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents'))
  })

  test('discard composes every handler registered for the dirty card', async () => {
    const first = vi.fn()
    const second = vi.fn()
    const router = renderSplit({
      initial: '/agents/code-worker',
      items: ITEMS,
      discardHandlers: [first, second],
    })
    await waitFor(() => screen.getByTestId('split-card-dot-code-worker'))

    fireEvent.click(screen.getByTestId('agents-mobile-back'))
    await screen.findByTestId('unsaved-guard-dialog')
    fireEvent.click(screen.getByTestId('unsaved-discard'))

    await waitFor(() => expect(router.state.location.pathname).toBe('/agents'))
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })
})
