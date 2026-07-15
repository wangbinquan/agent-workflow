// RFC-169 (T5) — UnsavedChangesGuard behavior in a real memory-history router:
//   - a dirty parent draft blocks in-app navigation (card click) → Dialog;
//   - "discard" (proceed) lets the navigation through; "stay" (reset) cancels;
//   - ESC / × / overlay-click all map to reset (stay), and a dismiss must not
//     leave the resolver stuck — a subsequent navigation blocks again (P2-5);
//   - a clean draft never blocks;
//   - a SYNCHRONOUS report(key,false) before a programmatic navigate is not
//     blocked (T-D5 sync-ref — the create/delete onSuccess path).
//
// beforeenload arming is covered by e2e (jsdom can't meaningfully fire it).

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
import type { ReactElement } from 'react'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { Route as RootRoute } from '../src/routes/__root'
import { ResourceSplitPage, type ResourceCardItem } from '../src/components/split/ResourceSplitPage'
import { useReportSplitDirty, useSplitDirty } from '../src/components/split/splitDirty'
import '../src/i18n'

const ITEMS: ResourceCardItem[] = [
  { key: 'a', kind: 'agent', title: 'a', to: '/agents/$name', params: { name: 'a' } },
  { key: 'b', kind: 'agent', title: 'b', to: '/agents/$name', params: { name: 'b' } },
]

function AlwaysDirtyDetail() {
  const { name } = useParams({ from: '/agents/$name' })
  useReportSplitDirty(name, true)
  return <div data-testid="detail-pane">detail:{name}</div>
}

function CleanDetail() {
  const { name } = useParams({ from: '/agents/$name' })
  useReportSplitDirty(name, false)
  return <div data-testid="detail-pane">detail:{name}</div>
}

/** Dirty, but a button that sync-clears the dirty ref before navigating —
 *  the shape create/delete onSuccess uses to avoid a self-block (T-D5). */
function SyncClearDetail() {
  const { name } = useParams({ from: '/agents/$name' })
  const { report } = useSplitDirty()
  const navigate = useNavigate()
  useReportSplitDirty(name, true)
  return (
    <div data-testid="detail-pane">
      detail:{name}
      <button
        type="button"
        data-testid="save-and-go"
        onClick={() => {
          report(name, false) // synchronous ref clear
          void navigate({ to: '/agents/$name', params: { name: 'b' } })
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
      const params = useParams({ strict: false }) as { name?: string }
      return (
        <ResourceSplitPage
          title="Agents"
          items={ITEMS}
          isLoading={false}
          error={null}
          selectedKey={params.name ?? null}
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
    path: '/$name',
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
})
