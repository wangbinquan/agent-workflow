// RFC-033-T7 — /repos page renders the batch-import button and opens the
// dialog on click. Locks in the header wiring so a regression that drops
// either the button or the dialog blows up here.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { fireEvent, render, screen } from '@testing-library/react'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { enUS } from '../src/i18n/en-US'
import type * as ApiClientModule from '../src/api/client'

vi.mock('../src/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('../src/api/client')
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn().mockImplementation((path: string) =>
        Promise.resolve(
          path === '/api/auth/me'
            ? {
                permissions: [
                  'repos:read',
                  'repos:create',
                  'repos:update',
                  'repos:delete',
                  'repos:execute',
                ],
              }
            : { items: [] },
        ),
      ),
      post: vi.fn(),
      delete: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      postMultipart: vi.fn(),
    },
  }
})

// The page owns URL-driven tabs, so its focused harness below clones the real
// /repos route id instead of bypassing the TanStack router context.
import { ReposRoute, validateReposSearch } from '../src/routes/repos'

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  try {
    localStorage.removeItem('repo-import-batch-id')
  } catch {
    /* ignore */
  }
})

afterEach(() => {
  // RFC-035 PR3: BatchImportDialog renders via <Dialog> + createPortal.
  // React's own unmount cleans up the portal subtree; manually wiping
  // document.body races with that and throws DOMException in React 19.
  vi.restoreAllMocks()
})

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const reposRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/repos',
    validateSearch: validateReposSearch,
    component: ReposRoute.options.component,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([reposRoute]),
    history: createMemoryHistory({ initialEntries: ['/repos?tab=repos'] }),
  })
  return render(
    <QueryClientProvider client={qc}>
      {/* The focused test tree intentionally differs from the generated app tree. */}
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
}

describe('/repos page batch import button (RFC-033)', () => {
  test('initial empty state renders exactly one batch-import button', async () => {
    renderPage()
    const empty = await screen.findByTestId('repos-empty')
    expect(empty.textContent).toContain(enUS.repos.emptyDescription)
    expect(empty.querySelector('[data-icon="repo"]')).not.toBeNull()
    const buttons = screen.getAllByTestId('repos-batch-import-button')
    expect(buttons).toHaveLength(1)
    const btn = buttons[0]!
    expect(btn.textContent ?? '').toMatch(/批量导入|Batch import/)
    expect(empty.contains(btn)).toBe(true)
    expect(btn.closest('.page__actions')).toBeNull()
    const header = empty.closest('.page')?.querySelector('header.page__header')
    const chromePrimaries = [header, empty].flatMap((surface) =>
      Array.from(surface?.querySelectorAll('.btn--primary') ?? []),
    )
    expect(chromePrimaries).toEqual([btn])
  })

  test('clicking the button mounts the dialog', async () => {
    renderPage()
    fireEvent.click(await screen.findByTestId('repos-batch-import-button'))
    expect(screen.getByTestId('batch-import-dialog')).toBeTruthy()
  })

  // Locks in the webkit-nightly fix (runs 26282474062 + 26293636014):
  // Safari/WebKit doesn't focus <button> on mouse click. We avoid the
  // unreliable `document.activeElement`-at-open-time capture inside the
  // Dialog by passing the trigger's ref explicitly via `triggerRef`,
  // which the Dialog prefers on close. Locked at source level because
  // the contract is "this trigger's ref reaches the Dialog" — a JSDOM
  // simulation can't validate cross-browser focus behavior, only
  // production / e2e webkit can.
  test('trigger button forwards its ref to BatchImportDialog.triggerRef for focus restoration', () => {
    const src = readFileSync(resolve(__dirname, '..', 'src', 'routes', 'repos.tsx'), 'utf8')
    // The trigger button must carry a ref (any name — assert structure).
    expect(src).toMatch(/<button\s+ref=\{[a-zA-Z]+TriggerRef\}/)
    // BatchImportDialog must receive that ref through triggerRef.
    expect(src).toMatch(/triggerRef=\{[a-zA-Z]+TriggerRef\}/)
    // RFC-198: one stable action element moves between the initial empty state
    // and PageHeader, so a list refresh while the dialog is open updates the
    // shared ref to the newly connected trigger.
    // RFC-248 T37 加了「远端仓库 | 仓库组」分段后，`actions` 外层多了一个
    // `tab === 'groups' ? newGroupAction : …` 的三元。本条锁的不变量没变——
    // **仓库分段下**空态与 PageHeader 仍共用同一个 `batchImportAction` 元素
    // 实例，所以列表刷新时 ref 会跟到新挂载的那个 trigger 上。改成断言这段
    // 子表达式，既不因为外层多一层就假红，也不会漏掉真正的回归（把
    // batchImportAction 拆成两个不同实例）。
    expect(src).toContain('isInitialEmpty ? undefined : batchImportAction')
    // 且 `batchImportAction` 只被**定义一次**（拆成两份就破坏共享实例）。
    expect(src.match(/const batchImportAction = /g)).toHaveLength(1)
    expect(src).toMatch(/<EmptyState[^>]+action=\{batchImportAction\}/)
  })

  // Initial empty lists intentionally move the sole primary CTA into the
  // EmptyState. The shared PageHeader still owns the page heading; after data
  // arrives the same action is conditionally rendered in its actions slot.
  test('empty CTA keeps primary styling while PageHeader owns the heading', async () => {
    renderPage()
    await screen.findByTestId('repos-empty')
    const btn = screen.getByTestId('repos-batch-import-button')
    expect(btn.className).toContain('btn--primary')
    expect(btn.className).not.toContain('btn--sm')
    expect(
      document.querySelector('header.page__header.page__header--row h1.page__title'),
    ).not.toBeNull()
  })
})
