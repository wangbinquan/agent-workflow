// /workflows quick-create dialog — locks the refactor that removed the
// /workflows/new full-page editor in favor of the RFC-164 workgroup pattern
// (list-page dialog collects name + description; the definition starts empty
// and ALL detail editing happens in the /workflows/$id editor).
//
// Locks:
//   1. buildQuickCreateWorkflowPayload pure matrix (empty / overlong name
//      block, payload carries the EMPTY definition).
//   2. "+ New workflow" opens the shared <Dialog>; Create stays disabled on
//      an empty name; confirm POSTs EXACTLY {name, description, definition}
//      and navigates to the editor of the created id.
//   3. A failed POST keeps the dialog open and surfaces the error in the
//      footer (no navigation); dismissing the dialog while a slow POST is
//      in flight suppresses the late navigation (Codex review P2).
//   4. Wiring: /workflows/new survives ONLY as a redirect to the list page
//      (old bookmarks); the editor route file serves /workflows/$id alone,
//      Onboarding points at the list, the list page composes the shared
//      Dialog + the pure builder, and the editor renders its error state
//      before the loading guard (a bad id must not park on loading forever).

import { readFileSync } from 'node:fs'
import path, { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
import {
  EMPTY_WORKFLOW_DEFINITION,
  buildQuickCreateWorkflowPayload,
} from '../src/lib/workflow-form'
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
  // Unmount React BEFORE clearing the body: an open <Dialog> portals into
  // document.body, and blowing the DOM away first makes React's portal
  // removal throw (happy-dom removeChild DOMException).
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

interface Recorded {
  calls: Array<{ url: string; method: string; body: unknown }>
}

function installFetch(
  state: { workflows: Workflow[]; releaseCreate?: () => void } & Recorded,
  opts: { failCreate?: boolean; deferCreate?: boolean } = {},
): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (req: RequestInfo | URL, init?: RequestInit) => {
      const url = req.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      state.calls.push({ url, method, body })
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        })

      if (url.includes('/api/users/lookup')) return json([])
      if (url.endsWith('/api/workflows') && method === 'GET') return json(state.workflows)
      if (url.endsWith('/api/workflows') && method === 'POST') {
        if (opts.failCreate === true) {
          return json({ error: { code: 'quick-create-exploded', message: 'boom happened' } }, 500)
        }
        const b = body as { name: string; description: string; definition: unknown }
        const created = json(
          wf('created', {
            id: 'wf_created',
            name: b.name,
            description: b.description,
            definition: b.definition as Workflow['definition'],
          }),
          201,
        )
        if (opts.deferCreate === true) {
          // Parked until the test calls state.releaseCreate() — simulates a
          // slow POST so dismiss-while-pending behavior can be asserted.
          return await new Promise<Response>((resolve) => {
            state.releaseCreate = () => resolve(created)
          })
        }
        return created
      }
      return json({})
    },
  )
}

async function renderPage(initialEntry: string) {
  const list = await import('../src/routes/workflows')
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/workflows',
    component: list.Route.options.component,
  })
  // Reuses the REAL retired-URL redirect logic (beforeLoad) under a test
  // root. The cast stops the reused hook's inferred generics from poisoning
  // this standalone tree's types (same escape hatch as `router as any`).
  const newRedirectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/workflows/new',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    beforeLoad: list.NewRedirectRoute.options.beforeLoad as any,
  })
  // Navigation target only — the real editor needs xyflow + ResizeObserver,
  // which happy-dom can't host; the assertion is on router.state.location.
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/workflows/$id',
    component: () => <div data-testid="editor-stub" />,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([newRedirectRoute, listRoute, detailRoute]),
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

describe('buildQuickCreateWorkflowPayload (pure)', () => {
  test('empty name is not ok (Create button stays disabled)', () => {
    expect(buildQuickCreateWorkflowPayload({ name: '', description: 'x' }).ok).toBe(false)
  })

  test('overlong name (>256) is caught by the schema net', () => {
    expect(buildQuickCreateWorkflowPayload({ name: 'a'.repeat(257), description: '' }).ok).toBe(
      false,
    )
  })

  test('valid draft assembles name + description + the EMPTY definition', () => {
    const built = buildQuickCreateWorkflowPayload({ name: 'audit-flow', description: 'demo' })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.payload).toEqual({
      name: 'audit-flow',
      description: 'demo',
      definition: EMPTY_WORKFLOW_DEFINITION,
    })
  })

  test('description may be empty (schema default keeps it a string)', () => {
    const built = buildQuickCreateWorkflowPayload({ name: 'n', description: '' })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.payload.description).toBe('')
  })
})

describe('/workflows quick-create dialog', () => {
  test('empty name disables Create; a valid draft POSTs the full payload and navigates to the editor', async () => {
    const state = { workflows: [], calls: [] as Recorded['calls'] }
    installFetch(state)
    const router = await renderPage('/workflows')

    fireEvent.click(await screen.findByTestId('workflow-new-button'))
    const confirm = (await screen.findByTestId('workflow-create-confirm')) as HTMLButtonElement
    expect(confirm.disabled).toBe(true) // empty name
    // a11y: required must live on the control, not only as the label asterisk.
    expect((screen.getByTestId('workflow-create-name') as HTMLInputElement).required).toBe(true)

    fireEvent.change(screen.getByTestId('workflow-create-name'), {
      target: { value: 'code-audit' },
    })
    fireEvent.change(screen.getByTestId('workflow-create-description'), {
      target: { value: 'demo flow' },
    })
    const enabled = screen.getByTestId('workflow-create-confirm') as HTMLButtonElement
    expect(enabled.disabled).toBe(false)
    fireEvent.click(enabled)

    await waitFor(() => {
      const post = state.calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/workflows'))
      expect(post).toBeTruthy()
      // Name + description from the dialog, definition ALWAYS the empty one —
      // the editor (auto-save) owns everything beyond that.
      expect(post?.body).toEqual({
        name: 'code-audit',
        description: 'demo flow',
        definition: { $schema_version: 1, inputs: [], nodes: [], edges: [] },
      })
    })
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/workflows/wf_created')
    })
  })

  test('a failed POST keeps the dialog open and shows the error in the footer', async () => {
    const state = { workflows: [], calls: [] as Recorded['calls'] }
    installFetch(state, { failCreate: true })
    const router = await renderPage('/workflows')

    fireEvent.click(await screen.findByTestId('workflow-new-button'))
    fireEvent.change(await screen.findByTestId('workflow-create-name'), {
      target: { value: 'doomed' },
    })
    fireEvent.click(screen.getByTestId('workflow-create-confirm'))

    await screen.findByText(/boom happened/)
    expect(screen.getByTestId('workflow-create-dialog')).toBeTruthy()
    expect(router.state.location.pathname).toBe('/workflows')
  })

  test('dismissing the dialog while the POST is pending suppresses the late navigation', async () => {
    const state = { workflows: [], calls: [] as Recorded['calls'] } as {
      workflows: Workflow[]
      releaseCreate?: () => void
    } & Recorded
    installFetch(state, { deferCreate: true })
    const router = await renderPage('/workflows')

    fireEvent.click(await screen.findByTestId('workflow-new-button'))
    fireEvent.change(await screen.findByTestId('workflow-create-name'), {
      target: { value: 'slowpoke' },
    })
    fireEvent.click(screen.getByTestId('workflow-create-confirm'))
    await waitFor(() => {
      expect(state.calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/workflows'))).toBe(
        true,
      )
    })

    // User walks away mid-flight…
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    // …then the response lands: the list cache still refreshes (row appears),
    // but the user must NOT be yanked into the editor.
    const getsBefore = state.calls.filter(
      (c) => c.method === 'GET' && c.url.endsWith('/api/workflows'),
    ).length
    state.releaseCreate?.()
    await waitFor(() => {
      const gets = state.calls.filter(
        (c) => c.method === 'GET' && c.url.endsWith('/api/workflows'),
      ).length
      expect(gets).toBeGreaterThan(getsBefore)
    })
    expect(router.state.location.pathname).toBe('/workflows')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('reopening the dialog resets the previous draft', async () => {
    const state = { workflows: [], calls: [] as Recorded['calls'] }
    installFetch(state)
    await renderPage('/workflows')

    fireEvent.click(await screen.findByTestId('workflow-new-button'))
    fireEvent.change(await screen.findByTestId('workflow-create-name'), {
      target: { value: 'stale-draft' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    fireEvent.click(screen.getByTestId('workflow-new-button'))
    const name = (await screen.findByTestId('workflow-create-name')) as HTMLInputElement
    expect(name.value).toBe('')
    expect((screen.getByTestId('workflow-create-confirm') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('/workflows/new removal wiring', () => {
  test('the retired /workflows/new URL redirects to the list page', async () => {
    installFetch({ workflows: [], calls: [] })
    const router = await renderPage('/workflows/new')
    await screen.findByTestId('workflows-empty')
    expect(router.state.location.pathname).toBe('/workflows')
  })

  test('router: no full-page /new route; the redirect literal precedes /workflows/$id', () => {
    const router = readSrc('router.tsx')
    expect(router).toContain(
      "import { EditRoute as workflowEditRoute } from '@/routes/workflows.edit'",
    )
    expect(router).not.toContain('workflowNewRoute,')
    const redirectIdx = router.indexOf('workflowNewRedirectRoute,')
    const editIdx = router.indexOf('workflowEditRoute,')
    expect(redirectIdx).toBeGreaterThan(0)
    expect(editIdx).toBeGreaterThan(redirectIdx)
  })

  test('editor renders the error state before the loading guard (stuck-loading fix)', () => {
    const edit = readSrc('routes/workflows.edit.tsx')
    const errIdx = edit.indexOf('if (query.error !== null && query.error !== undefined)')
    const loadIdx = edit.indexOf('if (query.isLoading || draft === null)')
    expect(errIdx).toBeGreaterThan(0)
    expect(loadIdx).toBeGreaterThan(0)
    expect(errIdx).toBeLessThan(loadIdx)
  })

  test('the editor route file only serves /workflows/$id', () => {
    const edit = readSrc('routes/workflows.edit.tsx')
    expect(edit).toContain("path: '/workflows/$id'")
    expect(edit).not.toContain("'/workflows/new'")
    expect(edit).not.toContain('NewRoute')
  })

  test('Onboarding manual-create CTA points at the list page (dialog lives there)', () => {
    const ob = readSrc('components/Onboarding.tsx')
    expect(ob).not.toContain('/workflows/new')
    expect(ob).toContain('to="/workflows"')
  })

  test('the list page composes the shared Dialog + the pure builder + the redirect', () => {
    const list = readSrc('routes/workflows.tsx')
    expect(list).toContain("import { Dialog } from '@/components/Dialog'")
    expect(list).toContain('buildQuickCreateWorkflowPayload')
    expect(list).toContain('NewRedirectRoute')
  })
})
