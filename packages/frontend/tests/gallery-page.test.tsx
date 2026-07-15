// RFC-191 (T2/T3/T5) — ResourceGalleryPage shell + /workflows card assembly.
//
// Locks:
//   1. Shell: notice slot renders BEFORE the grid (import feedback must not
//      sink below the cards — Codex 设计门 P2-9); search box only when the
//      list has items (empty state stays byte-identical → zero visual-baseline
//      churn); filtered-to-nothing shows the compact no-matches state, NOT the
//      list-empty state.
//   2. Cards: whole-card stretched link + separate「启动」link (sibling <a>s,
//      never nested), description fallback, meta chips.
//   3. /workflows assembly: vN + node-count chips from the definition the
//      list API already returns; launch deep-links the wizard preselected.
//   4. Source locks (gallery-callsite): both gallery pages compose
//      ResourceGalleryPage and dropped their data-table (the RFC-035 guard
//      family — a page silently regressing to a bespoke table must go red).
//   5. TextInput extension compat: new type/aria-label/className props pass
//      through; default markup for existing callers stays byte-identical.

import { readFileSync } from 'node:fs'
import path, { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router'
import type { Workflow } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { TextInput } from '../src/components/Form'
import {
  ResourceGalleryPage,
  type GalleryCardItem,
} from '../src/components/gallery/ResourceGalleryPage'
import { enUS } from '../src/i18n/en-US'
import '../src/i18n'

const TEST_DIR = path.dirname(new URL(import.meta.url).pathname)
const FRONTEND_SRC = resolve(TEST_DIR, '..', 'src')

function readSrc(rel: string): string {
  return readFileSync(resolve(FRONTEND_SRC, rel), 'utf-8')
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function wf(name: string, overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: `wf_${name}`,
    name,
    description: '',
    definition: { $schema_version: 1, inputs: [], nodes: [], edges: [] },
    version: 1,
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 1_720_000_000_000,
    ownerUserId: null,
    visibility: 'public',
    ...overrides,
  }
}

function installFetch(workflows: Workflow[]): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (req: RequestInfo | URL) => {
    const url = req.toString()
    const json = (payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    if (url.includes('/api/users/lookup')) return json([])
    if (url.endsWith('/api/workflows')) return json(workflows)
    return json({})
  })
}

/** Mount a component tree with the three routes the gallery links against. */
function renderWithRouter(component: () => React.ReactElement, initialEntry: string) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const pageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: initialEntry,
    component,
  })
  const editorStub = createRoute({
    getParentRoute: () => rootRoute,
    path: '/workflows/$id',
    component: () => <div data-testid="editor-stub" />,
  })
  const wizardStub = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks/new',
    component: () => <div data-testid="wizard-stub" />,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([pageRoute, editorStub, wizardStub]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
  return router
}

function item(overrides: Partial<GalleryCardItem> = {}): GalleryCardItem {
  return {
    key: 'k1',
    title: 'alpha-flow',
    subtitle: 'does alpha things',
    subtitleFallback: '(no description)',
    updatedAt: Date.now() - 5 * 60_000,
    to: '/workflows/$id',
    params: { id: 'wf_alpha' },
    launch: { kind: 'workflow', workflow: 'wf_alpha' },
    testid: 'card-alpha',
    ...overrides,
  }
}

describe('ResourceGalleryPage shell', () => {
  test('notice renders before the grid; search only when items exist', async () => {
    renderWithRouter(
      () => (
        <ResourceGalleryPage
          title="Things"
          headerActions={<button type="button">new</button>}
          notice={<div data-testid="notice">imported!</div>}
          items={[item()]}
          isLoading={false}
          error={null}
          searchPlaceholder="Search…"
          emptyListText="No things yet."
          emptyTestid="things-empty"
        />
      ),
      '/gallery',
    )
    const notice = await screen.findByTestId('notice')
    const grid = screen.getByTestId('gallery-grid')
    // DOM order: notice strictly precedes the grid (P2-9).
    expect(notice.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByTestId('gallery-search')).toBeTruthy()
  })

  test('empty list: EmptyState with the page testid, NO search box (baseline parity)', async () => {
    renderWithRouter(
      () => (
        <ResourceGalleryPage
          title="Things"
          headerActions={null}
          items={[]}
          isLoading={false}
          error={null}
          searchPlaceholder="Search…"
          emptyListText="No things yet."
          emptyTestid="things-empty"
        />
      ),
      '/gallery',
    )
    await screen.findByTestId('things-empty')
    expect(screen.queryByTestId('gallery-search')).toBeNull()
    expect(screen.queryByTestId('gallery-grid')).toBeNull()
  })

  test('search filters by title OR subtitle; no hit → compact no-matches (not list-empty)', async () => {
    renderWithRouter(
      () => (
        <ResourceGalleryPage
          title="Things"
          headerActions={null}
          items={[
            item(),
            item({ key: 'k2', title: 'beta-flow', subtitle: 'audits stuff', testid: 'card-beta' }),
          ]}
          isLoading={false}
          error={null}
          searchPlaceholder="Search…"
          emptyListText="No things yet."
          emptyTestid="things-empty"
        />
      ),
      '/gallery',
    )
    await screen.findByTestId('card-alpha')
    // Subtitle match keeps beta, drops alpha.
    fireEvent.change(screen.getByTestId('gallery-search'), { target: { value: 'audits' } })
    expect(screen.queryByTestId('card-alpha')).toBeNull()
    expect(screen.getByTestId('card-beta')).toBeTruthy()
    // No hits → compact no-matches; the list-empty state must NOT appear.
    fireEvent.change(screen.getByTestId('gallery-search'), { target: { value: 'zzz' } })
    expect(screen.getByTestId('gallery-no-matches')).toBeTruthy()
    expect(screen.queryByTestId('things-empty')).toBeNull()
  })

  test('card: stretched link and launch are SIBLING <a>s (never nested); fallback desc is italicized', async () => {
    renderWithRouter(
      () => (
        <ResourceGalleryPage
          title="Things"
          headerActions={null}
          items={[item({ subtitle: undefined })]}
          isLoading={false}
          error={null}
          searchPlaceholder="Search…"
          emptyListText="No things yet."
          emptyTestid="things-empty"
        />
      ),
      '/gallery',
    )
    const card = await screen.findByTestId('card-alpha')
    const cardLink = card.querySelector('a.gallery-card__stretch')
    expect(cardLink?.getAttribute('href')).toBe('/workflows/wf_alpha')
    expect(cardLink?.querySelector('a')).toBeNull() // no nested anchors
    const launch = screen.getByTestId('card-alpha-launch')
    expect(launch.getAttribute('href')).toContain('/tasks/new')
    expect(launch.getAttribute('href')).toContain('kind=workflow')
    expect(launch.getAttribute('href')).toContain('workflow=wf_alpha')
    expect(launch.closest('a.gallery-card__stretch')).toBeNull() // sibling, not child
    expect(card.querySelector('.gallery-card__desc--empty')?.textContent).toBe('(no description)')
    // Relative time renders as a <time> with the absolute tooltip.
    expect(card.querySelector('.gallery-card__when time')).not.toBeNull()
  })
})

describe('/workflows gallery assembly (T3)', () => {
  test('cards carry vN + node-count chips, launch deep-link, and desc fallback', async () => {
    installFetch([
      wf('code-audit', {
        description: 'audit pipeline',
        version: 7,
        definition: {
          $schema_version: 1,
          inputs: [],
          nodes: [{ id: 'n1' } as never, { id: 'n2' } as never],
          edges: [],
        },
        updatedAt: Date.now() - 3_600_000,
      }),
      wf('docs-sync', { updatedAt: Date.now() - 7_200_000 }),
    ])
    const list = await import('../src/routes/workflows')
    renderWithRouter(list.Route.options.component as () => React.ReactElement, '/workflows')

    const audit = await screen.findByTestId('workflow-card-code-audit')
    expect(audit.textContent).toContain('v7')
    expect(audit.textContent).toContain('2 nodes')
    expect(audit.textContent).toContain('audit pipeline')
    const launch = screen.getByTestId('workflow-card-code-audit-launch')
    expect(launch.getAttribute('href')).toContain('kind=workflow')
    expect(launch.getAttribute('href')).toContain('workflow=wf_code-audit')

    const docs = screen.getByTestId('workflow-card-docs-sync')
    expect(docs.textContent).toContain(enUS.workflows.noDescription)
    expect(docs.textContent).toContain('0 nodes')
    // Freshest first (updatedAt desc): code-audit precedes docs-sync.
    expect(audit.compareDocumentPosition(docs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test('no delete affordance on the list (delete lives in the editor header)', async () => {
    installFetch([wf('solo')])
    const list = await import('../src/routes/workflows')
    renderWithRouter(list.Route.options.component as () => React.ReactElement, '/workflows')
    await screen.findByTestId('workflow-card-solo')
    expect(screen.queryByText(enUS.common.delete)).toBeNull()
  })
})

describe('gallery callsite locks (T5)', () => {
  test('both gallery pages compose ResourceGalleryPage and dropped the data-table', () => {
    for (const rel of ['routes/workflows.tsx', 'routes/workgroups.tsx']) {
      const body = readSrc(rel)
      expect(body, `${rel} composes the gallery shell`).toContain('ResourceGalleryPage')
      expect(body, `${rel} must not regress to a data-table`).not.toContain(
        'className="data-table"',
      )
    }
  })
})

describe('TextInput extension compat (T2)', () => {
  test('default markup stays byte-identical for existing callers', () => {
    render(<TextInput value="v" onChange={() => {}} data-testid="ti-default" />)
    const el = screen.getByTestId('ti-default')
    expect(el.className).toBe('form-input')
    expect(el.getAttribute('type')).toBe('text')
    expect(el.getAttribute('aria-label')).toBeNull()
  })

  test('type/aria-label/className pass through (gallery search face)', () => {
    render(
      <TextInput
        value=""
        onChange={() => {}}
        type="search"
        aria-label="Search…"
        className="gallery__search"
        data-testid="ti-search"
      />,
    )
    const el = screen.getByTestId('ti-search')
    expect(el.className).toBe('form-input gallery__search')
    expect(el.getAttribute('type')).toBe('search')
    expect(el.getAttribute('aria-label')).toBe('Search…')
  })
})
