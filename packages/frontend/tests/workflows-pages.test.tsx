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
import type { SaveWorkflowReceipt, Workflow, WorkflowDetail } from '@agent-workflow/shared'
import { WORKFLOW_NAME_RE, WORKGROUP_NAME_RE } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import {
  EMPTY_WORKFLOW_DEFINITION,
  buildQuickCreateWorkflowPayload,
  workflowNameError,
  workflowRenameError,
} from '../src/lib/workflow-form'
import {
  applyWorkflowSaveReceipt,
  makeWorkflowDeleteRequest,
  makeWorkflowSaveRequest,
} from '../src/lib/workflow-save-wire'
import { zhCN } from '../src/i18n/zh-CN'
import { enUS } from '../src/i18n/en-US'
import { HomepageGreeting } from '../src/components/home/HomepageGreeting'
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
  vi.unstubAllGlobals()
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

function wfDetail(name: string, overrides: Partial<WorkflowDetail> = {}): WorkflowDetail {
  return { ...wf(name), snapshotHash: 'a'.repeat(64), ...overrides }
}

interface Recorded {
  calls: Array<{ url: string; method: string; body: unknown }>
}

function installFetch(
  state: { workflows: Workflow[]; releaseCreate?: () => void } & Recorded,
  opts: {
    failCreate?: boolean
    deferCreate?: boolean
    importResponse?: { status: number; body: unknown }
  } = {},
): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (req: RequestInfo | URL, init?: RequestInit) => {
      const url = req.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      // Import bodies are YAML, not JSON — record those as the raw string.
      const body =
        typeof init?.body === 'string'
          ? (() => {
              try {
                return JSON.parse(init.body as string) as unknown
              } catch {
                return init.body
              }
            })()
          : undefined
      state.calls.push({ url, method, body })
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        })

      if (url.includes('/api/runtimes/status')) return json({ runtimes: [] })
      if (url.includes('/api/overview')) {
        return json({
          resources: {
            agents: 0,
            skills: 0,
            mcps: 0,
            plugins: 0,
            workflows: state.workflows.length,
            workgroups: 0,
            repos: 0,
            scheduled: 0,
            memories: 0,
          },
          tasks: { running: 0, awaiting: 0, done7d: 0, failed7d: 0 },
          generatedAt: '2026-07-16T00:00:00.000Z',
        })
      }
      if (url.includes('/api/users/lookup')) return json([])
      if (url.includes('/api/workflows/import') && method === 'POST') {
        const ir = opts.importResponse ?? {
          status: 201,
          body: { outcome: 'created', workflow: wfDetail('imported') },
        }
        return json(ir.body, ir.status)
      }
      if (url.endsWith('/api/workflows') && method === 'GET') return json(state.workflows)
      if (url.endsWith('/api/workflows') && method === 'POST') {
        if (opts.failCreate === true) {
          return json({ error: { code: 'quick-create-exploded', message: 'boom happened' } }, 500)
        }
        const b = body as { name: string; description: string; definition: unknown }
        const created = json(
          wfDetail('created', {
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

async function renderPage(initialEntry: string | string[], options: { homepage?: boolean } = {}) {
  const list = await import('../src/routes/workflows')
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component:
      options.homepage === true
        ? HomepageGreeting
        : () => <div data-testid="workflow-history-home" />,
  })
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/workflows',
    component: list.Route.options.component,
    validateSearch: list.Route.options.validateSearch,
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
    routeTree: rootRoute.addChildren([homeRoute, newRedirectRoute, listRoute, detailRoute]),
    history: createMemoryHistory({
      initialEntries: Array.isArray(initialEntry) ? initialEntry : [initialEntry],
    }),
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

describe('workflow name rules (pure) — unified with workgroup naming (用户 2026-07-10)', () => {
  test('WORKFLOW_NAME_RE is the SAME regex object as WORKGROUP_NAME_RE (alias, cannot drift)', () => {
    expect(WORKFLOW_NAME_RE).toBe(WORKGROUP_NAME_RE)
  })

  test('workflowNameError matrix: empty / malformed / overlong / valid', () => {
    expect(workflowNameError('')).toBe('workflows.errors.nameRequired')
    expect(workflowNameError('Bad Name!')).toBe('workflows.errors.nameInvalid')
    expect(workflowNameError('-leading-dash')).toBe('workflows.errors.nameInvalid')
    expect(workflowNameError('a'.repeat(129))).toBe('workflows.errors.nameInvalid')
    expect(workflowNameError('a'.repeat(128))).toBeNull()
    expect(workflowNameError('code-audit_2')).toBeNull()
  })

  test('workflowRenameError: an UNCHANGED legacy free-form name never blocks (grandfather)', () => {
    expect(workflowRenameError('My Legacy Flow', 'My Legacy Flow')).toBeNull()
    expect(workflowRenameError('still bad', 'My Legacy Flow')).toBe('workflows.errors.nameInvalid')
    expect(workflowRenameError('', 'My Legacy Flow')).toBe('workflows.errors.nameRequired')
    expect(workflowRenameError('new-slug', 'My Legacy Flow')).toBeNull()
  })

  test('builder: empty name → nameRequired; malformed → nameInvalid (raw i18n keys)', () => {
    const empty = buildQuickCreateWorkflowPayload({ name: '', description: 'x' })
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.errors.name).toBe('workflows.errors.nameRequired')
    const bad = buildQuickCreateWorkflowPayload({ name: 'Bad Name!', description: '' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.errors.name).toBe('workflows.errors.nameInvalid')
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

describe('RFC-199 B1 workflow revision wire adapter', () => {
  test('each save/delete intent gets a canonical fresh ULID and carries the full fence', () => {
    const snapshot = {
      name: 'audit-flow',
      description: 'demo',
      definition: EMPTY_WORKFLOW_DEFINITION,
    }
    const first = makeWorkflowSaveRequest(7, snapshot)
    const second = makeWorkflowSaveRequest(7, snapshot)
    const deletion = makeWorkflowDeleteRequest(7)

    expect(first).toMatchObject({ expectedVersion: 7, snapshot })
    expect(first.clientMutationId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
    expect(second.clientMutationId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
    expect(deletion.clientMutationId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
    expect(
      new Set([first.clientMutationId, second.clientMutationId, deletion.clientMutationId]).size,
    ).toBe(3)
  })

  test('a save receipt updates only editable snapshot and server revision fields', () => {
    const current = wfDetail('before', {
      id: 'wf-1',
      version: 4,
      ownerUserId: 'owner-1',
      visibility: 'private',
    })
    const receipt: SaveWorkflowReceipt = {
      clientMutationId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      requestedBaseVersion: 4,
      revision: {
        workflowId: 'wf-1',
        version: 5,
        snapshotHash: 'b'.repeat(64),
        updatedAt: 1_730_000_000_000,
      },
      snapshot: {
        name: 'after',
        description: 'normalized',
        definition: { ...EMPTY_WORKFLOW_DEFINITION, $schema_version: 4 },
      },
      outcome: 'committed',
    }

    expect(applyWorkflowSaveReceipt(current, receipt)).toMatchObject({
      id: 'wf-1',
      name: 'after',
      description: 'normalized',
      version: 5,
      snapshotHash: 'b'.repeat(64),
      ownerUserId: 'owner-1',
      visibility: 'private',
    })
    expect(() =>
      applyWorkflowSaveReceipt(current, {
        ...receipt,
        revision: { ...receipt.revision, workflowId: 'wf-other' },
      }),
    ).toThrow(/different workflow/)
  })
})

describe('/workflows quick-create dialog', () => {
  test('deep create consumes create=1 with replace, preserves adjacent search, and never replays', async () => {
    const state = { workflows: [], calls: [] as Recorded['calls'] }
    installFetch(state)
    const router = await renderPage(['/', '/workflows?create=1&source=homepage'])

    expect(await screen.findByTestId('workflow-create-dialog')).toBeTruthy()
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/workflows')
      expect(router.state.location.search).toEqual({ source: 'homepage' })
    })

    fireEvent.click(screen.getByRole('button', { name: enUS.common.cancel }))
    await waitFor(() => expect(screen.queryByTestId('workflow-create-dialog')).toBeNull())
    expect(document.activeElement).toBe(screen.getByTestId('workflow-new-button'))

    router.history.back()
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    router.history.forward()
    await waitFor(() => expect(router.state.location.pathname).toBe('/workflows'))
    expect(router.state.location.search).toEqual({ source: 'homepage' })
    expect(screen.queryByTestId('workflow-create-dialog')).toBeNull()

    // A real refresh starts from the already-canonical URL and must stay shut.
    cleanup()
    await renderPage('/workflows?source=homepage')
    await screen.findByTestId('workflows-empty')
    expect(screen.queryByTestId('workflow-create-dialog')).toBeNull()
  })

  test('homepage CTA is a real typed Link that lands in the one-shot create flow', async () => {
    installFetch({ workflows: [], calls: [] })
    const router = await renderPage('/', { homepage: true })

    const link = await screen.findByTestId('homepage-new-workflow')
    expect(link.getAttribute('href')).toMatch(/^\/workflows\?create=/)
    fireEvent.click(link)

    expect(await screen.findByTestId('workflow-create-dialog')).toBeTruthy()
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/workflows')
      expect(router.state.location.search).toEqual({})
    })
  })

  test('RFC-198 page-header-primary-ratchet counts gallery chrome independently', async () => {
    installFetch({ workflows: [wf('visible')], calls: [] })
    await renderPage('/workflows')

    await screen.findByTestId('workflow-card-visible')
    const page = screen.getByTestId('gallery-grid').closest('.page--gallery')
    const header = page?.querySelector('header.page__header')
    const create = screen.getByTestId('workflow-new-button')

    // Card-level Launch controls are a separate contextual group. The page
    // chrome itself has one primary task, and it is the header Create action.
    expect(Array.from(header?.querySelectorAll('.btn--primary') ?? [])).toEqual([create])
    expect(header?.contains(create)).toBe(true)
  })

  test('RFC-198 initial gallery chrome moves, rather than duplicates, its primary task', async () => {
    installFetch({ workflows: [], calls: [] })
    await renderPage('/workflows')

    const empty = await screen.findByTestId('workflows-empty')
    const page = empty.closest('.page--gallery')
    const header = page?.querySelector('header.page__header')
    const create = screen.getByTestId('workflow-new-button')
    const chromePrimaries = [header, empty].flatMap((surface) =>
      Array.from(surface?.querySelectorAll('.btn--primary') ?? []),
    )

    expect(chromePrimaries).toEqual([create])
    expect(header?.contains(create)).toBe(false)
    expect(empty.contains(create)).toBe(true)
  })

  test('empty name disables Create; a valid draft POSTs the full payload and navigates to the editor', async () => {
    const state = { workflows: [], calls: [] as Recorded['calls'] }
    installFetch(state)
    const router = await renderPage('/workflows')

    fireEvent.click(await screen.findByTestId('workflow-new-button'))
    const confirm = (await screen.findByTestId('workflow-create-confirm')) as HTMLButtonElement
    expect(confirm.disabled).toBe(true) // empty name
    // a11y: required must live on the control, not only as the label asterisk.
    expect((screen.getByTestId('workflow-create-name') as HTMLInputElement).required).toBe(true)
    // Workgroup-dialog parity (用户 2026-07-10): name hint + dedicated create
    // label, and no placeholder on the name input.
    expect(screen.getByText(enUS.workflows.fieldNameHint)).toBeTruthy()
    expect(confirm.textContent).toBe(enUS.workflows.createButton)
    expect(
      (screen.getByTestId('workflow-create-name') as HTMLInputElement).getAttribute('placeholder'),
    ).toBeNull()

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

  test('a malformed name shows the inline error and keeps Create disabled', async () => {
    installFetch({ workflows: [], calls: [] })
    await renderPage('/workflows')

    fireEvent.click(await screen.findByTestId('workflow-new-button'))
    fireEvent.change(await screen.findByTestId('workflow-create-name'), {
      target: { value: 'Bad Name!' },
    })
    expect(screen.getByText(enUS.workflows.errors.nameInvalid)).toBeTruthy()
    expect((screen.getByTestId('workflow-create-confirm') as HTMLButtonElement).disabled).toBe(true)
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

  test('workflow import success refreshes the gallery, shows result, and restores trigger focus', async () => {
    const state = { workflows: [], calls: [] as Recorded['calls'] }
    installFetch(state)
    await renderPage('/workflows')
    const trigger = await screen.findByTestId('workflow-import-trigger')
    const getsBefore = state.calls.filter(
      (call) => call.method === 'GET' && call.url.endsWith('/api/workflows'),
    ).length

    fireEvent.click(trigger)
    const file = new File(['name: imported\n'], 'imported.yaml', { type: 'application/yaml' })
    Object.defineProperty(file, 'text', {
      value: vi.fn().mockResolvedValue('name: imported\n'),
    })
    fireEvent.change(await screen.findByTestId('workflow-import-file'), {
      target: { files: [file] },
    })
    fireEvent.click(screen.getByTestId('workflow-import-submit'))

    expect(await screen.findByTestId('workflow-import-result')).toBeTruthy()
    const importCall = state.calls.find((call) => call.url.includes('/api/workflows/import'))
    expect(importCall?.url).not.toContain('onConflict')
    expect(importCall?.body).toEqual({ yamlText: 'name: imported\n', mode: 'fail' })
    await waitFor(() => {
      const gets = state.calls.filter(
        (call) => call.method === 'GET' && call.url.endsWith('/api/workflows'),
      ).length
      expect(gets).toBeGreaterThan(getsBefore)
    })

    const footerClose = document.querySelector<HTMLButtonElement>(
      '[data-testid="workflow-import-dialog"] .dialog__footer .btn--primary',
    )
    expect(footerClose).not.toBeNull()
    fireEvent.click(footerClose!)
    await waitFor(() => expect(screen.queryByTestId('workflow-import-dialog')).toBeNull())
    expect(document.activeElement).toBe(screen.getByTestId('workflow-import-trigger'))
  })
})

describe('/workflows search validation', () => {
  test('recognizes create boolean aliases, drops invalid create, and keeps adjacent search', async () => {
    const { validateWorkflowsSearch, withoutWorkflowCreate } =
      await import('../src/routes/workflows')
    expect(validateWorkflowsSearch({ create: '1', source: 'home' })).toEqual({
      create: true,
      source: 'home',
    })
    expect(validateWorkflowsSearch({ create: true, source: 'home' })).toEqual({
      create: true,
      source: 'home',
    })
    expect(validateWorkflowsSearch({ create: 'no', source: 'home' })).toEqual({ source: 'home' })
    expect(withoutWorkflowCreate({ create: true, source: 'home' })).toEqual({ source: 'home' })
  })
})

describe('postYaml uses the structured RFC-199 import wire', () => {
  test('flat 422 → ApiError carries workflow-name-invalid (was http-422)', async () => {
    installFetch(
      { workflows: [], calls: [] },
      {
        importResponse: {
          status: 422,
          body: { ok: false, code: 'workflow-name-invalid', message: 'name must match …' },
        },
      },
    )
    const { postYaml } = await import('../src/routes/workflows')
    await expect(postYaml('name: Bad Legacy Name\n', 'fail')).rejects.toMatchObject({
      code: 'workflow-name-invalid',
    })
  })

  test('flat 409 keeps workflow-import-conflict (the overwrite/new prompt branch key)', async () => {
    installFetch(
      { workflows: [], calls: [] },
      {
        importResponse: {
          status: 409,
          body: { ok: false, code: 'workflow-import-conflict', message: 'id collides' },
        },
      },
    )
    const { postYaml } = await import('../src/routes/workflows')
    await expect(postYaml('name: x\n', 'fail')).rejects.toMatchObject({
      code: 'workflow-import-conflict',
    })
  })

  test('overwrite posts the exact conflict fence and refuses a missing fence', async () => {
    const state = { workflows: [], calls: [] as Recorded['calls'] }
    installFetch(state, {
      importResponse: {
        status: 200,
        body: {
          outcome: 'overwritten',
          receipt: { outcome: 'committed' },
        },
      },
    })
    const { postYaml } = await import('../src/routes/workflows')
    const overwrite = {
      workflowId: 'wf-existing',
      expectedVersion: 9,
      clientMutationId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    }

    await postYaml('id: wf-existing\n', 'overwrite', overwrite)
    expect(state.calls.find((call) => call.url.includes('/api/workflows/import'))?.body).toEqual({
      yamlText: 'id: wf-existing\n',
      mode: 'overwrite',
      overwrite,
    })
    await expect(postYaml('id: wf-existing\n', 'overwrite')).rejects.toThrow(
      /requires the conflict revision fence/,
    )
  })

  test('the import UI routes coded errors through the shared decoders (source lock)', () => {
    const list = readSrc('routes/workflows.tsx')
    expect(list).toContain("api.post<ImportWorkflowResult>('/api/workflows/import', body)")
    expect(list).toContain('<WorkflowImportDialog')
    expect(list).not.toContain('extractErrorBody(')
    expect(list).not.toContain('onConflict')
    expect(list).not.toContain("'content-type': 'text/yaml'")
    expect(list).not.toContain('window.prompt')
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

  test('editor separates initial failure from stale refetch failure (stuck-loading fix)', () => {
    const edit = readSrc('routes/workflows.edit.tsx')
    const initialGuardIdx = edit.indexOf('if (query.data === undefined)')
    const initialErrorIdx = edit.indexOf(
      'if (query.error !== null && query.error !== undefined)',
      initialGuardIdx,
    )
    const loadedAdapterIdx = edit.indexOf('<WorkflowEditorLoaded')
    const editorReturnIdx = edit.indexOf('<div className="page page--editor">', loadedAdapterIdx)
    const staleErrorIdx = edit.indexOf('const backgroundQueryError =', loadedAdapterIdx)
    expect(initialGuardIdx).toBeGreaterThan(0)
    expect(initialErrorIdx).toBeGreaterThan(initialGuardIdx)
    expect(loadedAdapterIdx).toBeGreaterThan(initialErrorIdx)
    expect(editorReturnIdx).toBeGreaterThan(loadedAdapterIdx)
    expect(staleErrorIdx).toBeGreaterThan(loadedAdapterIdx)
    expect(edit).toContain('<PageHeader title={id} />')
    expect(edit).toContain("<LoadingState label={t('editor.loadingWorkflow')} />")
    expect(edit).toContain('error={query.error}')
    expect(edit).toContain('onClick={() => void query.refetch()}')
    expect(edit).not.toContain('<div className="page error-box">')
  })

  test('editor composes shared page header and feedback without changing canvas ownership', () => {
    const edit = readSrc('routes/workflows.edit.tsx')
    expect(edit).toContain('title={controller.state.local.name || workflowId}')
    expect(edit).toContain('actions={headerActions}')
    expect(edit).toContain('<WorkflowDraftStatus')
    expect(edit).toContain('data-testid="workflow-action-error-focus"')
    expect(edit).toContain('<ErrorBanner error={actionError} />')
    expect(edit).toContain('<WorkflowCanvas')
  })

  test('editor delegates the composite draft/WS/query lifecycle and fences DELETE', () => {
    const edit = readSrc('routes/workflows.edit.tsx')
    expect(edit).toContain('useQuery<WorkflowDetail>')
    expect(edit).toContain('useWorkflowEditorDraft({')
    expect(edit).toContain('initial,')
    expect(edit).toContain('observeRemoteDetail(observedDetail)')
    expect(edit).toContain('onFrame: controller.remoteFrame')
    expect(edit).toContain('inFlightMutationId: controller.inFlightMutationId')
    expect(edit).toMatch(
      /controller\.commit\(\s*\{ \.\.\.controller\.state\.local, definition \},\s*\{/,
    )
    expect(edit).toContain('onChange={commitDefinition}')
    expect(edit).toContain('<UnsavedChangesGuard dirtyRef={unsafeNavigationRef} />')
    expect(edit).toContain('makeWorkflowDeleteRequest(expectedVersion)')
    expect(edit).toContain('confirmationKey={deleteConfirmationKey}')
    expect(edit).toContain('del.mutateAsync({ expectedVersion: deleteExpectedVersion })')
    expect(edit).toContain('<ErrorBanner error={del.error} />')
    expect(edit).toContain('api.deleteJson<void>')
    expect(edit).not.toContain('makeWorkflowSaveRequest')
    expect(edit).not.toContain('applyWorkflowSaveReceipt')
    expect(edit).not.toContain('setDraft(')
    expect(edit).not.toContain('renameSave')
    expect(edit).not.toContain('api.delete(`/api/workflows/${encodeURIComponent(id)}`)')
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

  test('Onboarding demo import shares the structured JSON writer without a raw fallback', () => {
    const ob = readSrc('components/Onboarding.tsx')
    expect(ob).toContain("api.post<ImportWorkflowResult>('/api/workflows/import'")
    expect(ob).toContain("mode: 'new'")
    expect(ob).not.toContain('getBaseUrl')
    expect(ob).not.toContain('onConflict')
    expect(ob).not.toContain("'content-type': 'text/yaml'")
  })

  test('BOTH list pages compose the shared QuickCreateDialog (用户 2026-07-10 拍板抽公共组件)', () => {
    const list = readSrc('routes/workflows.tsx')
    expect(list).toContain("import { QuickCreateDialog } from '@/components/QuickCreateDialog'")
    expect(list).toContain('buildQuickCreateWorkflowPayload')
    expect(list).toContain('NewRedirectRoute')
    const wg = readSrc('routes/workgroups.tsx')
    expect(wg).toContain("import { QuickCreateDialog } from '@/components/QuickCreateDialog'")
    // The dismissal-suppress guard is wired on the workgroup side too.
    expect(wg).toContain('createOpenRef')
  })

  test('dialog copy matches the workgroup pattern in BOTH bundles; retired editor keys are gone', () => {
    // 用户 2026-07-10：工作流弹窗提示要和工作组一样（含 name hint）。
    expect(zhCN.workflows.createButton).toBe('创建工作流')
    expect(enUS.workflows.createButton).toBe('Create workflow')
    expect(zhCN.workflows.fieldNameHint.length).toBeGreaterThan(0)
    expect(enUS.workflows.fieldNameHint.length).toBeGreaterThan(0)
    // The full-page creator's button keys retired with it (no dead keys).
    expect('create' in zhCN.editor).toBe(false)
    expect('creating' in zhCN.editor).toBe(false)
    // 用户 2026-07-10：快速创建的名称输入不要占位符——两个弹窗都不许有。
    expect(readSrc('routes/workflows.tsx')).not.toContain('placeholder=')
    expect(readSrc('routes/workgroups.tsx')).not.toContain('placeholder="review-squad"')
  })

  test('naming unification wiring: error keys in both bundles + editor rename gate', () => {
    // 用户 2026-07-10：工作流与工作组命名规则一致（放行存量，只卡新名）。
    expect(zhCN.workflows.errors.nameRequired.length).toBeGreaterThan(0)
    expect(zhCN.workflows.errors.nameInvalid.length).toBeGreaterThan(0)
    expect(enUS.workflows.errors.nameRequired.length).toBeGreaterThan(0)
    expect(enUS.workflows.errors.nameInvalid.length).toBeGreaterThan(0)
    // 用户 2026-07-10：hint 文案两资源逐字一致，且不再提「用于 URL」。
    expect(zhCN.workgroups.fieldNameHint).toBe(zhCN.workflows.fieldNameHint)
    expect(enUS.workgroups.fieldNameHint).toBe(enUS.workflows.fieldNameHint)
    expect(zhCN.workgroups.fieldNameHint).not.toContain('URL')
    expect(enUS.workgroups.fieldNameHint).not.toMatch(/URL/i)
    expect(zhCN.errors['workflow-name-invalid']?.length ?? 0).toBeGreaterThan(0)
    expect(enUS.errors['workflow-name-invalid']?.length ?? 0).toBeGreaterThan(0)
    // Editor: the rename gate now lives in the rename DIALOG (2026-07-13) — one
    // workflowRenameError verdict drives BOTH the inline name error and the Save
    // button (unchanged legacy names must keep saving — grandfather).
    const edit = readSrc('routes/workflows.edit.tsx')
    const hits = edit.match(/workflowRenameError\(/g) ?? []
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(edit).toContain('workflowRenameError } from')
  })

  test('editor edits name/description via a RenameDialog, not inline fields (用户 2026-07-13)', () => {
    const edit = readSrc('routes/workflows.edit.tsx')
    // The rename button + shared RenameDialog replace the old inline field grid,
    // matching the workgroup rename entry (and the create dialog's elements).
    expect(edit).toContain("import { RenameDialog } from '@/components/RenameDialog'")
    expect(edit).toContain('data-testid="workflow-rename-button"')
    expect(edit).toContain('<RenameDialog')
    // The inline name/description grid is gone — they live in the dialog now.
    expect(edit).not.toContain('form-grid form-grid--cols-2')
    // Editor rename copy exists in both bundles.
    expect(zhCN.editor.renameButton.length).toBeGreaterThan(0)
    expect(enUS.editor.renameButton.length).toBeGreaterThan(0)
    expect(zhCN.editor.renameTitle.length).toBeGreaterThan(0)
    expect(enUS.editor.renameTitle.length).toBeGreaterThan(0)
  })
})
