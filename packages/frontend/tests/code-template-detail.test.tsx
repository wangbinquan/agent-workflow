// RFC-309 T17/T23 — the template detail page: the flow, its origin, and a launch.
//
// This page is the answer to all three of the user's questions after RFC-307:
//
//   「流程和模版两个页签什么关系」        → they were the same thing twice;
//                                          now the template IS the flow
//   「是不是应该在模版里配置流程」        → yes, and this is where
//   「基于模版创建需求任务的入口在哪」    → here, and nowhere before
//
// So the cases below check the three joins rather than the markup. Each one was
// a piece of correct-but-unreachable code before this RFC: the stage graph
// rendered nothing on this route, T64's four states had no caller, and
// `POST /api/code/rounds` did not exist at all.

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
import { setBaseUrl, setToken } from '../src/stores/auth'
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

const TEMPLATE = {
  id: 'tpl-1',
  name: 'our review',
  description: null,
  capability: 'mr-review',
  scriptsRedacted: false,
  scripts: {},
  hooks: [],
  paramSchema: [],
  paramDefaults: {},
  agentBySlot: { reviewer: 'agent-1' },
  promptBySlot: {},
  params: {},
  stageContractVer: 1,
  ownerUserId: 'u-1',
  visibility: 'private',
  builtin: false,
  aclRevision: 1,
  upstream: null,
  createdAt: 1,
  updatedAt: 1,
}

/** Two stages, enough to prove the graph is drawn from the ENDPOINT. */
const GRAPH = {
  capability: 'mr-review',
  stageContractVer: 1,
  nodes: [
    {
      name: 'collect-diff',
      kind: 'program',
      requires: [],
      produces: ['diff'],
      terminal: [],
      injectable: [],
      parallel: false,
    },
    {
      name: 'review-shard',
      kind: 'ai',
      agentSlot: 'reviewer',
      requires: ['diff'],
      produces: ['findings'],
      terminal: [],
      injectable: ['extraContext'],
      parallel: true,
    },
  ],
  edges: [{ from: 'collect-diff', to: 'review-shard', via: 'diff' }],
}

interface Recorded {
  calls: Array<{ url: string; method: string; body: unknown }>
}

function installFetch(
  over: {
    template?: Record<string, unknown>
    upstream?: unknown
    repos?: unknown[]
  } = {},
): Recorded {
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

      if (url.includes('/upstream/merge'))
        return json({ applied: ['scripts'], keptLocal: [], stillConflicted: [] })
      if (url.includes('/upstream')) {
        return json(
          over.upstream ?? {
            link: null,
            status: null,
            upstreamName: null,
            fields: [],
            baseRecorded: false,
          },
        )
      }
      if (url.includes('/api/capability-templates/')) {
        if (method === 'POST')
          return json({ ...TEMPLATE, id: 'tpl-2', name: 'our review copy' }, 201)
        return json({ ...TEMPLATE, ...over.template })
      }
      if (url.includes('/graph')) return json(GRAPH)
      if (url.includes('/api/repos'))
        return json(over.repos ?? [{ id: 'repo-1', name: 'group/app' }])
      if (url.includes('/api/agents')) return json([{ id: 'agent-1', name: 'auditor' }])
      if (url.includes('/api/code/rounds')) {
        return json({ workItemId: 'wi-1', roundId: 'rd-1', roundSeq: 1 }, 201)
      }
      return json({})
    },
  )
  return rec
}

async function renderDetail(id = 'tpl-1') {
  const page = await import('../src/routes/code.templates.$id')
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const detail = createRoute({
    getParentRoute: () => rootRoute,
    path: '/code/templates/$id',
    component: page.Route.options.component,
  })
  const codeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/code',
    validateSearch: (s: Record<string, unknown>) => s,
    component: () => <div>code page</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([detail, codeRoute]),
    history: createMemoryHistory({ initialEntries: [`/code/templates/${id}`] }),
  })
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
  return router
}

describe('RFC-309 T13 — a template IS its flow', () => {
  test('opening a template shows the steps it runs', async () => {
    // The join RFC-307 built and RFC-309 moved: before this route the graph
    // endpoint existed and this page did not render it.
    installFetch()
    await renderDetail()
    expect(await screen.findByText('review-shard')).toBeTruthy()
    expect(screen.getByText('collect-diff')).toBeTruthy()
  })

  test('there is no configuration picker — the route already answered that', async () => {
    // The Flow tab asked two questions before showing anything. Re-introducing
    // either here would put the same friction on a page that knows the answer.
    installFetch()
    await renderDetail()
    await screen.findByText('review-shard')
    expect(screen.queryByTestId('code-flow-binding')).toBeNull()
    expect(screen.queryByTestId('code-flow-capability')).toBeNull()
  })

  test('a redacted template still shows its steps, and says why part is missing', async () => {
    // AC-6's read half: someone without scripts:author must be able to use the
    // page, not be locked out of it.
    installFetch({ template: { scriptsRedacted: true, scripts: undefined } })
    await renderDetail()
    expect(await screen.findByText('review-shard')).toBeTruthy()
    expect(screen.getAllByText(/scripts hidden/i).length).toBeGreaterThan(0)
  })
})

describe('RFC-309 T16 — where this copy came from', () => {
  test('an original shows NO origin section at all', async () => {
    installFetch()
    await renderDetail()
    await screen.findByText('review-shard')
    expect(screen.queryByTestId('code-template-upstream')).toBeNull()
  })

  test('a failed origin lookup SAYS so instead of looking like an original', async () => {
    // Silently dropping the panel is the tempting shortcut and it is wrong in
    // the one way that matters: a copy with a broken lookup would then be
    // indistinguishable from a template that was authored here — which is
    // exactly the distinction this panel exists to make.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (req: RequestInfo | URL) => {
      const url = req.toString()
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      if (url.includes('/upstream')) return json({ ok: false, code: 'boom' }, 500)
      if (url.includes('/api/capability-templates/')) return json(TEMPLATE)
      if (url.includes('/graph')) return json(GRAPH)
      if (url.includes('/api/repos')) return json([])
      return json({})
    })
    await renderDetail()
    expect(await screen.findByTestId('code-template-upstream-error')).toBeTruthy()
  })

  test('a copy behind its upstream offers the merge, naming what it would take', async () => {
    installFetch({
      upstream: {
        link: { upstreamId: 'tpl-0', upstreamVersion: 1 },
        status: { state: 'update-available', message: 'upstream has changed', localOverrides: [] },
        upstreamName: 'department review',
        fields: [
          { field: 'scripts', action: 'take-upstream', value: {} },
          { field: 'params', action: 'unchanged' },
        ],
        baseRecorded: true,
      },
    })
    await renderDetail()

    expect(await screen.findByTestId('code-upstream-merge')).toBeTruthy()
    expect(screen.getByTestId('code-upstream-field-scripts')).toBeTruthy()
    // Unchanged fields are not listed: a diff that lists everything is a diff
    // nobody reads.
    expect(screen.queryByTestId('code-upstream-field-params')).toBeNull()
    expect(screen.getByTestId('code-upstream-name').textContent).toContain('department review')
  })

  test('an orphaned copy offers NO merge — there is nothing to merge from', async () => {
    // Every template migrated from the two-layer model is in this state, so a
    // live button here would fail for the majority of rows.
    installFetch({
      upstream: {
        link: { upstreamId: 'gone', upstreamVersion: 1 },
        status: { state: 'orphaned', message: 'the original no longer exists', localOverrides: [] },
        upstreamName: null,
        fields: [],
        baseRecorded: false,
      },
    })
    await renderDetail()
    await screen.findByTestId('code-template-upstream')
    expect(screen.queryByTestId('code-upstream-merge')).toBeNull()
  })

  test('a copy with no recorded base says so instead of offering a merge that does nothing', async () => {
    installFetch({
      upstream: {
        link: { upstreamId: 'tpl-0', upstreamVersion: 1 },
        status: { state: 'conflicted', message: 'both sides moved', localOverrides: ['scripts'] },
        upstreamName: 'department review',
        fields: [{ field: 'scripts', action: 'conflict', upstream: {}, local: {} }],
        baseRecorded: false,
      },
    })
    await renderDetail()
    expect(await screen.findByTestId('code-upstream-no-base')).toBeTruthy()
    expect(screen.queryByTestId('code-upstream-merge')).toBeNull()
  })

  test('merging posts to the merge endpoint and reports what it did', async () => {
    const rec = installFetch({
      upstream: {
        link: { upstreamId: 'tpl-0', upstreamVersion: 1 },
        status: { state: 'update-available', message: 'upstream has changed', localOverrides: [] },
        upstreamName: 'department review',
        fields: [{ field: 'scripts', action: 'take-upstream', value: {} }],
        baseRecorded: true,
      },
    })
    await renderDetail()

    fireEvent.click(await screen.findByTestId('code-upstream-merge'))
    await waitFor(() =>
      expect(
        rec.calls.some(
          (c) =>
            c.method === 'POST' && c.url.includes('/api/capability-templates/tpl-1/upstream/merge'),
        ),
      ).toBe(true),
    )
    expect(await screen.findByTestId('code-upstream-merged')).toBeTruthy()
  })
})

describe('RFC-309 T23 — starting a round from here', () => {
  test('the form asks for what THIS capability needs, and nothing else', async () => {
    // The server's input is a discriminated union; the form is the same
    // decision made visible. A requirement field on an mr-review launch would
    // be rejected by the `.strict()` schema after the person filled it in.
    installFetch()
    await renderDetail()
    expect(await screen.findByTestId('code-launch-mr')).toBeTruthy()
    expect(screen.queryByTestId('code-launch-title')).toBeNull()
    expect(screen.queryByTestId('code-launch-pipeline')).toBeNull()
  })

  test('a requirement template asks for the requirement instead', async () => {
    installFetch({ template: { capability: 'requirement' } })
    await renderDetail()
    expect(await screen.findByTestId('code-launch-title')).toBeTruthy()
    expect(screen.queryByTestId('code-launch-mr')).toBeNull()
  })

  test('start is refused until the repository and the input are both there', async () => {
    // Not a nag: the launch fails server-side without a repository, and a
    // button that submits a request it knows will fail spends somebody's
    // attention on an error the page could have prevented.
    installFetch()
    await renderDetail()
    const submit = await screen.findByTestId('code-launch-submit')
    expect((submit as HTMLButtonElement).disabled).toBe(true)
  })

  test('a filled form posts the capability-shaped input', async () => {
    const rec = installFetch()
    await renderDetail()

    fireEvent.click(await screen.findByTestId('code-launch-repo'))
    fireEvent.mouseDown(await screen.findByRole('option', { name: 'group/app' }))
    fireEvent.change(screen.getByTestId('code-launch-mr'), { target: { value: '42' } })
    fireEvent.click(screen.getByTestId('code-launch-submit'))

    await waitFor(() => {
      const post = rec.calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/code/rounds'))
      expect(post?.body).toMatchObject({
        repoId: 'repo-1',
        templateId: 'tpl-1',
        input: { capability: 'mr-review', mrIid: '42' },
      })
    })
  })

  test('mr-monitor says there is nothing to start rather than offering a broken form', async () => {
    // It is a standing loop, not a round. An empty form here would invite
    // somebody to press start and receive a validation error naming a union
    // arm that does not exist.
    installFetch({ template: { capability: 'mr-monitor' } })
    await renderDetail()
    expect(await screen.findByTestId('code-launch-unavailable')).toBeTruthy()
    expect(screen.queryByTestId('code-launch-submit')).toBeNull()
  })
})
