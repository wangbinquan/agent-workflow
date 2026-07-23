// RFC-169 (T5) — UnsavedChangesGuard behavior in a real memory-history router:
//   - a dirty parent draft blocks in-app navigation (card click) → Dialog;
//   - "discard" (proceed) lets the navigation through; "stay" (reset) cancels;
//   - ESC / × / overlay-click all map to reset (stay), and a dismiss must not
//     leave the resolver stuck — a subsequent navigation blocks again (P2-5);
//   - a clean draft never blocks;
//   - a SYNCHRONOUS report(key,false) before a programmatic navigate is not
//     blocked (T-D5 sync-ref — the create/delete onSuccess path).
// RFC-201 (T1.3) extends that guard without weakening the RFC-169 default:
//   - a caller may allow only its own same-resource section-key navigation;
//   - unrelated search/path changes still block;
//   - an in-flight mutation blocks every navigation and cannot be discarded.
//
// beforeunload arming is covered by e2e (jsdom can't meaningfully fire it).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  Link,
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRoute,
  createRouter,
  useNavigate,
  useParams,
} from '@tanstack/react-router'
import { useRef, useState, type ReactElement } from 'react'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { Route as RootRoute } from '../src/routes/__root'
import { ResourceSplitPage, type ResourceCardItem } from '../src/components/split/ResourceSplitPage'
import {
  BUSY_ESCAPE_AFTER_MS,
  UnsavedChangesGuard,
} from '../src/components/split/UnsavedChangesGuard'
import { useReportSplitDirty, useSplitDirty } from '../src/components/split/splitDirty'
import '../src/i18n'

const ITEMS: ResourceCardItem[] = [
  { key: 'a', kind: 'agent', title: 'a', to: '/agents/$id', params: { id: 'a' } },
  { key: 'b', kind: 'agent', title: 'b', to: '/agents/$id', params: { id: 'b' } },
]

function AlwaysDirtyDetail() {
  const { id } = useParams({ from: '/agents/$id' })
  useReportSplitDirty(id, true)
  return <div data-testid="detail-pane">detail:{id}</div>
}

function CleanDetail() {
  const { id } = useParams({ from: '/agents/$id' })
  useReportSplitDirty(id, false)
  return <div data-testid="detail-pane">detail:{id}</div>
}

/** Dirty, but a button that sync-clears the dirty ref before navigating —
 *  the shape create/delete onSuccess uses to avoid a self-block (T-D5). */
function SyncClearDetail() {
  const { id } = useParams({ from: '/agents/$id' })
  const { report } = useSplitDirty()
  const navigate = useNavigate()
  useReportSplitDirty(id, true)
  return (
    <div data-testid="detail-pane">
      detail:{id}
      <button
        type="button"
        data-testid="save-and-go"
        onClick={() => {
          report(id, false) // synchronous ref clear
          void navigate({ to: '/agents/$id', params: { id: 'b' } })
        }}
      >
        save & go
      </button>
    </div>
  )
}

function renderGuard(opts: { initial: string; Detail: () => ReactElement }) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () => new Response('not found', { status: 404 }),
  )
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const layoutRoute = createRoute({
    getParentRoute: () => RootRoute,
    path: '/agents',
    component: function Layout() {
      const params = useParams({ strict: false }) as { id?: string }
      return (
        <ResourceSplitPage
          title="Agents"
          items={ITEMS}
          isLoading={false}
          error={null}
          selectedKey={params.id ?? null}
          newActive={false}
          newLabel="+ New"
          newTo="/agents/new"
          searchPlaceholder="Search…"
          emptyListText="empty"
        >
          <Outlet />
          {/* extra external nav target to exercise sidebar-style links */}
          <Link to="/agents" data-testid="go-index">
            index
          </Link>
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
    path: '/$id',
    component: opts.Detail,
  })
  const tree = RootRoute.addChildren([layoutRoute.addChildren([detailRoute, indexRoute])])
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

interface GuardSearch extends Record<string, unknown> {
  tab?: string
  filter?: string
}

function GuardAdapterHarness({
  busy,
  onDiscard,
  busySince,
  onForceLeave,
}: {
  busy: boolean
  onDiscard?: () => void
  busySince?: number | null
  onForceLeave?: () => void
}) {
  const [settled, setSettled] = useState(false)
  const dirtyRef = useRef<string | null>('settings:appearance')
  const busyRef = useRef(busy)
  const busySinceRef = useRef<number | null>(busySince ?? null)
  dirtyRef.current = settled ? null : 'settings:appearance'
  busyRef.current = settled ? false : busy
  busySinceRef.current = settled ? null : (busySince ?? null)
  return (
    <div data-testid="guard-adapter-page">
      <UnsavedChangesGuard
        dirtyRef={dirtyRef}
        busyRef={busyRef}
        busySinceRef={busySinceRef}
        {...(onForceLeave ? { onForceLeave } : {})}
        shouldBlockNavigation={({ current, next }) => {
          if (current.pathname !== next.pathname) return true
          const currentSearch = current.search as GuardSearch
          const nextSearch = next.search as GuardSearch
          const keys = new Set([...Object.keys(currentSearch), ...Object.keys(nextSearch)])
          const changedKeys = [...keys].filter(
            (key) => JSON.stringify(currentSearch[key]) !== JSON.stringify(nextSearch[key]),
          )
          // Test adapter mirrors Settings' narrow contract: only its registered
          // section key may change; adjacent search state is resource identity.
          return changedKeys.length !== 1 || changedKeys[0] !== 'tab'
        }}
        onDiscard={onDiscard}
      />
      <button type="button" data-testid="settle-busy" onClick={() => setSettled(true)}>
        settle
      </button>
      <button
        type="button"
        data-testid="start-busy-without-render"
        onClick={() => {
          busyRef.current = true
        }}
      >
        start busy silently
      </button>
      <Link
        to="/settings"
        search={(previous) => ({ ...previous, tab: 'limits' })}
        data-testid="change-section"
      >
        section
      </Link>
      <Link
        to="/settings"
        search={(previous) => ({ ...previous, filter: 'changed' })}
        data-testid="change-filter"
      >
        filter
      </Link>
      <Link to="/agents" data-testid="change-path">
        agents
      </Link>
    </div>
  )
}

function renderGuardAdapter(
  opts: {
    busy?: boolean
    onDiscard?: () => void
    busySince?: number | null
    onForceLeave?: () => void
  } = {},
) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () => new Response('not found', { status: 404 }),
  )
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const settingsRoute = createRoute({
    getParentRoute: () => RootRoute,
    path: '/settings',
    validateSearch: (raw): GuardSearch => raw,
    component: () => (
      <GuardAdapterHarness
        busy={opts.busy ?? false}
        onDiscard={opts.onDiscard}
        busySince={opts.busySince ?? null}
        onForceLeave={opts.onForceLeave}
      />
    ),
  })
  const agentsRoute = createRoute({
    getParentRoute: () => RootRoute,
    path: '/agents',
    component: () => <div data-testid="agents-page">agents</div>,
  })
  const tree = RootRoute.addChildren([settingsRoute, agentsRoute])
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({
      initialEntries: ['/settings?tab=appearance&filter=stable'],
    }),
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
  // Do NOT manually wipe document.body — the Dialog portals there and a manual
  // wipe races React 19's commit-time portal cleanup (see dialog.test.tsx). The
  // global setup.ts afterEach already runs RTL cleanup().
  vi.restoreAllMocks()
})

describe('UnsavedChangesGuard', () => {
  test('dirty draft blocks a card-click navigation → Dialog', async () => {
    const router = renderGuard({ initial: '/agents/a', Detail: AlwaysDirtyDetail })
    await waitFor(() => screen.getByText('detail:a'))
    fireEvent.click(screen.getByTestId('split-card-b'))
    await waitFor(() => screen.getByTestId('unsaved-guard-dialog'))
    // still on /agents/a — navigation is paused, not committed
    expect(router.state.location.pathname).toBe('/agents/a')
  })

  test('"discard" (proceed) lets the navigation through', async () => {
    const router = renderGuard({ initial: '/agents/a', Detail: AlwaysDirtyDetail })
    await waitFor(() => screen.getByText('detail:a'))
    fireEvent.click(screen.getByTestId('split-card-b'))
    await waitFor(() => screen.getByTestId('unsaved-guard-dialog'))
    fireEvent.click(screen.getByTestId('unsaved-discard'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents/b'))
    expect(screen.queryByTestId('unsaved-guard-dialog')).toBeNull()
  })

  test('"stay" (reset) cancels; a later navigation blocks again (not stuck)', async () => {
    const router = renderGuard({ initial: '/agents/a', Detail: AlwaysDirtyDetail })
    await waitFor(() => screen.getByText('detail:a'))
    fireEvent.click(screen.getByTestId('split-card-b'))
    await waitFor(() => screen.getByTestId('unsaved-guard-dialog'))
    fireEvent.click(screen.getByTestId('unsaved-stay'))
    await waitFor(() => expect(screen.queryByTestId('unsaved-guard-dialog')).toBeNull())
    expect(router.state.location.pathname).toBe('/agents/a')
    // resolver must be reusable — block again on the next attempt
    fireEvent.click(screen.getByTestId('split-card-b'))
    await waitFor(() => screen.getByTestId('unsaved-guard-dialog'))
    expect(router.state.location.pathname).toBe('/agents/a')
  })

  test.each([
    ['ESC', () => fireEvent.keyDown(document.body, { key: 'Escape' })],
    ['×', () => fireEvent.click(document.querySelector('.dialog__close') as Element)],
    ['overlay', () => fireEvent.mouseDown(document.querySelector('.dialog__overlay') as Element)],
  ])('dismiss via %s = stay, then a later nav blocks again', async (_label, dismiss) => {
    const router = renderGuard({ initial: '/agents/a', Detail: AlwaysDirtyDetail })
    await waitFor(() => screen.getByText('detail:a'))
    fireEvent.click(screen.getByTestId('split-card-b'))
    await waitFor(() => screen.getByTestId('unsaved-guard-dialog'))
    dismiss()
    await waitFor(() => expect(screen.queryByTestId('unsaved-guard-dialog')).toBeNull())
    expect(router.state.location.pathname).toBe('/agents/a')
    // not stuck: navigation blocks again
    fireEvent.click(screen.getByTestId('split-card-b'))
    await waitFor(() => screen.getByTestId('unsaved-guard-dialog'))
  })

  test('a clean draft never blocks', async () => {
    const router = renderGuard({ initial: '/agents/a', Detail: CleanDetail })
    await waitFor(() => screen.getByText('detail:a'))
    fireEvent.click(screen.getByTestId('split-card-b'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents/b'))
    expect(screen.queryByTestId('unsaved-guard-dialog')).toBeNull()
  })

  test('synchronous report(false) before navigate is not blocked (T-D5)', async () => {
    const router = renderGuard({ initial: '/agents/a', Detail: SyncClearDetail })
    await waitFor(() => screen.getByText('detail:a'))
    fireEvent.click(screen.getByTestId('save-and-go'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents/b'))
    expect(screen.queryByTestId('unsaved-guard-dialog')).toBeNull()
  })

  test('caller predicate allows only its same-resource section search change', async () => {
    const router = renderGuardAdapter()
    await waitFor(() => screen.getByTestId('guard-adapter-page'))

    fireEvent.click(screen.getByTestId('change-section'))
    await waitFor(() => expect(router.state.location.search.tab).toBe('limits'))
    expect(router.state.location.search.filter).toBe('stable')
    expect(screen.queryByTestId('unsaved-guard-dialog')).toBeNull()

    fireEvent.click(screen.getByTestId('change-filter'))
    await waitFor(() => screen.getByTestId('unsaved-guard-dialog'))
    expect(router.state.location.search.filter).toBe('stable')
    fireEvent.click(screen.getByTestId('unsaved-stay'))
    await waitFor(() => expect(screen.queryByTestId('unsaved-guard-dialog')).toBeNull())

    fireEvent.click(screen.getByTestId('change-path'))
    await waitFor(() => screen.getByTestId('unsaved-guard-dialog'))
    expect(router.state.location.pathname).toBe('/settings')
  })

  test('busy mutation blocks even an allowed section change and offers no discard', async () => {
    const router = renderGuardAdapter({ busy: true })
    await waitFor(() => screen.getByTestId('guard-adapter-page'))

    fireEvent.click(screen.getByTestId('change-section'))
    await waitFor(() => screen.getByTestId('unsaved-guard-dialog'))
    expect(router.state.location.search.tab).toBe('appearance')
    expect(screen.getByTestId('unsaved-stay')).toBeTruthy()
    expect(screen.queryByTestId('unsaved-discard')).toBeNull()
  })

  // RFC-208 — the busy block may no longer be indefinite AND unescapable at the
  // same time. Before this, a request that hung (no timeout existed anywhere in
  // api/client.ts) left the router-GLOBAL blocker armed with a Stay-only dialog:
  // every route in the app was unreachable from every page until a reload.
  //
  // The block itself is unchanged — a client-side abort still cannot prove the
  // server did not commit — so the escape is offered only after the operation
  // has visibly stalled, and it says so.
  test('a stalled busy mutation offers an informed "leave anyway" that aborts it', async () => {
    const onForceLeave = vi.fn()
    const router = renderGuardAdapter({
      busy: true,
      busySince: Date.now() - (BUSY_ESCAPE_AFTER_MS + 1_000),
      onForceLeave,
    })
    await waitFor(() => screen.getByTestId('guard-adapter-page'))

    fireEvent.click(screen.getByTestId('change-section'))
    await waitFor(() => screen.getByTestId('unsaved-guard-dialog'))
    // Discard stays hidden: this is NOT "pretend it never happened".
    expect(screen.queryByTestId('unsaved-discard')).toBeNull()

    fireEvent.click(screen.getByTestId('unsaved-force-leave'))
    // The in-flight request is cancelled, not merely abandoned — otherwise a
    // late onSuccess would yank the user back from wherever they navigated to.
    expect(onForceLeave).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(router.state.location.search.tab).toBe('appearance'))
  })

  test('a freshly-started busy mutation offers no escape yet (only Stay)', async () => {
    renderGuardAdapter({ busy: true, busySince: Date.now() })
    await waitFor(() => screen.getByTestId('guard-adapter-page'))

    fireEvent.click(screen.getByTestId('change-section'))
    await waitFor(() => screen.getByTestId('unsaved-guard-dialog'))
    expect(screen.getByTestId('unsaved-stay')).toBeTruthy()
    expect(screen.queryByTestId('unsaved-force-leave')).toBeNull()
  })

  test('discard clears the caller-owned registry before a blocked navigation proceeds', async () => {
    const onDiscard = vi.fn()
    const router = renderGuardAdapter({ onDiscard })
    await waitFor(() => screen.getByTestId('guard-adapter-page'))

    fireEvent.click(screen.getByTestId('change-filter'))
    await waitFor(() => screen.getByTestId('unsaved-guard-dialog'))
    fireEvent.click(screen.getByTestId('unsaved-discard'))

    await waitFor(() => expect(router.state.location.search.filter).toBe('changed'))
    expect(onDiscard).toHaveBeenCalledTimes(1)
  })

  test('a busy-only blocker closes when the exact save settles clean', async () => {
    const router = renderGuardAdapter({ busy: true })
    await waitFor(() => screen.getByTestId('guard-adapter-page'))

    fireEvent.click(screen.getByTestId('change-section'))
    await waitFor(() => screen.getByTestId('unsaved-guard-dialog'))
    fireEvent.click(screen.getByTestId('settle-busy'))

    await waitFor(() => expect(screen.queryByTestId('unsaved-guard-dialog')).toBeNull())
    expect(router.state.location.search.tab).toBe('appearance')
  })

  test('a stale discard button cannot proceed after the mutation becomes busy', async () => {
    const onDiscard = vi.fn()
    const router = renderGuardAdapter({ onDiscard })
    await waitFor(() => screen.getByTestId('guard-adapter-page'))

    fireEvent.click(screen.getByTestId('change-filter'))
    const staleDiscard = await screen.findByTestId('unsaved-discard')
    // Mutate only the synchronous ref so the already-rendered button remains
    // in the DOM, reproducing the exact render-to-click TOCTOU window.
    fireEvent.click(screen.getByTestId('start-busy-without-render'))
    fireEvent.click(staleDiscard)

    expect(router.state.location.search.filter).toBe('stable')
    expect(onDiscard).not.toHaveBeenCalled()
    expect(screen.getByTestId('unsaved-guard-dialog')).toBeTruthy()
  })
})
