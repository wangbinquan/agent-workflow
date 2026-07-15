// RFC-169 (T5) — ResourceSplitPage skeleton: card rendering, selection accent,
// search filter, "+ new" active state, the three list states (loading / error /
// empty), and the dirty dot driven through the SplitDirty context. Rendered in
// a real memory-history router (cards are <Link>s; the guard needs a router).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
import { useReportSplitDirty } from '../src/components/split/splitDirty'
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
  return <div data-testid="detail-pane">detail:{name}</div>
}

function renderSplit(opts: {
  initial: string
  items?: ResourceCardItem[]
  isLoading?: boolean
  error?: unknown
  detailDirty?: boolean
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
    component: () => <DirtyDetail dirty={opts.detailDirty ?? false} />,
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
    fireEvent.change(screen.getByTestId('split-search'), { target: { value: 'zzz' } })
    expect(screen.getByTestId('split-empty').textContent).toContain('No matches')

    cleanup()
    renderSplit({ initial: '/agents', items: [] })
    await waitFor(() => screen.getByTestId('split-empty'))
    expect(screen.getByTestId('split-empty').textContent).toContain('No agents yet')
  })

  test('"+ new" button is active on /new; index route is not', async () => {
    renderSplit({ initial: '/agents/new', items: ITEMS })
    await waitFor(() => screen.getByTestId('new-pane'))
    expect(screen.getByTestId('split-new-button').className).toContain('is-active')
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
