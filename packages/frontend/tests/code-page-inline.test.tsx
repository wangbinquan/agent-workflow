// RFC-304 T32/T33 — the `/code` page, rendered.
//
// What is worth asserting here is not that the markup exists, but that the page
// answers the question somebody opens it with: is this capability going to run,
// and if not, what do I do about it?
//
// So the load-bearing case is a MISCONFIGURED cell. A page that shows a red
// label and stops has moved the problem rather than solved it — the person now
// has to work out which of five prerequisites is missing and where it lives.
// The backend pairs each missing piece with the route that fixes it; this test
// pins that the page actually renders those as links.

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

interface Recorded {
  calls: Array<{ url: string; method: string; body: unknown }>
}

/**
 * A template as the API actually returns it.
 *
 * Named apart from the per-describe fixtures below on purpose: `TabPanels`
 * mounts EVERY panel, so the templates list renders even while the matrix tab
 * is the visible one — and a partial fixture there crashes tests that are
 * nominally about the matrix (a missing `paramSchema` took down three).
 *
 * RFC-309 collapsed the two fixtures this replaced. There was an `API_FRAMEWORK`
 * and an `API_BINDING` that only meant anything as a pair, which is the shape
 * of the product problem the merge fixed.
 */
const API_TEMPLATE = {
  id: 'bd-1',
  name: 'Our reviewers',
  description: null,
  capability: 'mr-review',
  scriptsRedacted: false,
  paramSchema: [],
  paramDefaults: {},
  agentBySlot: {},
  promptBySlot: {},
  params: {},
  stageContractVer: 1,
  ownerUserId: null,
  visibility: 'private',
  builtin: false,
  aclRevision: 1,
  upstream: null,
  createdAt: 1,
  updatedAt: 1,
}

function installFetch(handlers: {
  rows?: unknown[]
  workItems?: unknown[]
  attempts?: unknown[]
  metrics?: unknown
  templates?: unknown[]
  catalog?: unknown[]
  graph?: unknown
  agents?: unknown[]
}): Recorded {
  const rec: Recorded = { calls: [] }
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (req: RequestInfo | URL, init?: RequestInit) => {
      const url = req.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      rec.calls.push({ url, method, body })
      const json = (payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      if (url.includes('/api/capability-templates')) {
        if (method === 'POST') return json({ id: 'tpl-copy', name: 'x copy' })
        return json(handlers.templates ?? [])
      }
      // Before the catalog: `/api/code/capabilities/:id/graph` also contains
      // `/api/code/capabilities`, and answering it with the catalog's shape
      // makes the flow render nothing while every request still returns 200.
      if (url.includes('/graph')) {
        return json(handlers.graph ?? { capability: 'mr-review', reason: 'no-stage-contract' })
      }
      if (url.includes('/api/code/capabilities')) {
        return json({ items: handlers.catalog ?? [] })
      }
      if (url.includes('/api/agents')) {
        return json(handlers.agents ?? [])
      }
      if (url.includes('/api/code/metrics')) {
        return json(handlers.metrics ?? { windowMs: 30 * 86_400_000, adoption: [], runs: [] })
      }
      if (url.includes('/attempts')) {
        return json({ attempts: handlers.attempts ?? [] })
      }
      if (url.includes('/api/code/work-items')) {
        return json({ items: handlers.workItems ?? [], nextCursor: null })
      }
      if (url.includes('/api/code/matrix')) {
        if (method === 'PUT') return json({ row: (handlers.rows ?? [])[0] })
        return json({ rows: handlers.rows ?? [] })
      }
      return json({})
    },
  )
  return rec
}

async function renderPage(initial = '/code') {
  const page = await import('../src/routes/code')
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const codeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/code',
    validateSearch: page.validateCodeSearch,
    component: page.Route.options.component,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([codeRoute]),
    history: createMemoryHistory({ initialEntries: [initial] }),
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

const READY_ROW = {
  repoId: 'group/project',
  capability: 'mr-review',
  enabled: true,
  readiness: 'ready',
  issues: [],
  repairActions: [],
  templateId: 'binding-1',
}

const MISCONFIGURED_ROW = {
  repoId: 'group/project',
  capability: 'mr-review',
  enabled: true,
  readiness: 'misconfigured',
  issues: [
    { code: 'no-binding', detail: 'no capability binding is selected for this repo' },
    { code: 'code-host-unconfigured', detail: 'no code-host connection is configured' },
  ],
  repairActions: [
    { code: 'no-binding', label: 'Choose a configuration', route: '/code/bindings' },
    { code: 'code-host-unconfigured', label: 'Add a code host', route: '/settings/code-hosts' },
  ],
  templateId: null,
}

describe('RFC-304 — the capability matrix', () => {
  test('without a repository it asks for one rather than showing an empty table', async () => {
    installFetch({})
    await renderPage()
    expect(await screen.findByText(/enter a repository/i)).toBeTruthy()
  })

  test('a ready capability is shown as ready', async () => {
    installFetch({ rows: [READY_ROW] })
    await renderPage('/code?repo=group%2Fproject')
    // The NAME, not the machine id. An operator configuring "issue → MR" should
    // not have to know that capability is spelled `requirement`.
    expect(await screen.findByText('Merge request review')).toBeTruthy()
    // Exact, not /ready/i: the binding hint legitimately contains the word
    // "ready" in a sentence, and a loose regex matched both.
    expect(await screen.findByText('Ready')).toBeTruthy()
  })

  test('a misconfigured capability names EACH missing piece', async () => {
    // Not "misconfigured" alone: the whole value of the page is that the person
    // learns which prerequisite is absent without reading a log.
    installFetch({ rows: [MISCONFIGURED_ROW] })
    await renderPage('/code?repo=group%2Fproject')
    expect(await screen.findByText(/no capability binding is selected/i)).toBeTruthy()
    expect(await screen.findByText(/no code-host connection is configured/i)).toBeTruthy()
  })

  test('each missing piece carries a link to where it is fixed', async () => {
    // A red label with no next step is only marginally better than silence —
    // which the design names as the most common reason a platform like this
    // gets abandoned.
    installFetch({ rows: [MISCONFIGURED_ROW] })
    await renderPage('/code?repo=group%2Fproject')
    const fix = await screen.findByText('Choose a configuration')
    expect(fix.getAttribute('href')).toBe('/code/bindings')
    const host = await screen.findByText('Add a code host')
    expect(host.getAttribute('href')).toBe('/settings/code-hosts')
  })

  test('toggling a capability PUTs to the matrix endpoint', async () => {
    const rec = installFetch({ rows: [READY_ROW] })
    await renderPage('/code?repo=group%2Fproject')
    const toggle = await screen.findByTestId('code-toggle-mr-review')
    ;(toggle as HTMLInputElement).click()

    await waitFor(() => {
      const put = rec.calls.find((c) => c.method === 'PUT')
      expect(put).toBeDefined()
      expect(put?.body).toMatchObject({ capability: 'mr-review', enabled: false })
    })
  })

  test('the repository is not requested until one is chosen', async () => {
    // An empty path segment would 404 and read as a broken page on first open.
    const rec = installFetch({})
    await renderPage()
    await waitFor(() => {
      expect(rec.calls.some((c) => c.url.includes('/api/code/matrix'))).toBe(false)
    })
  })
})

describe('RFC-304 — the activity view', () => {
  test('an empty deployment explains what will appear here', async () => {
    // "Nothing yet" with no explanation reads as broken on a fresh install.
    installFetch({ workItems: [] })
    await renderPage('/code?tab=activity')
    expect(await screen.findByText(/nothing has run yet/i)).toBeTruthy()
  })

  test('a work item shows its rounds expanded into stages', async () => {
    installFetch({
      workItems: [
        {
          workItemId: 'wi-1',
          capability: 'mr-review',
          anchorKind: 'mr',
          anchorId: '412',
          status: 'idle',
          epoch: 1,
          rounds: [
            {
              roundId: 'r-1',
              roundSeq: 1,
              status: 'published',
              outcome: 'published',
              baselineSha: 'abc',
              stages: [
                {
                  stageName: 'resolve-target',
                  stageSeq: 0,
                  kind: 'program',
                  status: 'done',
                  error: null,
                },
                {
                  stageName: 'review-shard',
                  stageSeq: 4,
                  kind: 'ai',
                  status: 'failed',
                  error: 'the reviewer never returned a valid result',
                },
              ],
            },
          ],
        },
      ],
    })
    await renderPage('/code?tab=activity')

    expect(await screen.findByText('resolve-target')).toBeTruthy()
    expect(await screen.findByText('review-shard')).toBeTruthy()
    // A failed stage without its reason forces a log dig for the one fact the
    // person is looking at the page to learn.
    expect(await screen.findByText(/never returned a valid result/i)).toBeTruthy()
  })
})

// RFC-304 T55/T56 — the state view's deeper levels.
//
// Both exist because of the same failure: the page could show that something
// happened without showing WHAT. A stage that succeeded on its fourth try
// looked exactly like one that succeeded first time, and the round somebody
// came to look at was buried under the history of the ones before it.

const STAGE = (over: Record<string, unknown> = {}) => ({
  stageName: 'review-shard',
  stageSeq: 1,
  kind: 'ai',
  status: 'done',
  error: null,
  ...over,
})

const ITEM_WITH_ROUNDS = {
  workItemId: 'item-1',
  capability: 'mr-review',
  anchorKind: 'mr',
  anchorId: '412',
  status: 'settled',
  epoch: 1,
  rounds: [
    // Newest first, as the projection returns them.
    {
      roundId: 'round-3',
      roundSeq: 3,
      status: 'published',
      outcome: 'published',
      baselineSha: null,
      stages: [STAGE()],
    },
    {
      roundId: 'round-2',
      roundSeq: 2,
      status: 'failed',
      outcome: 'failed',
      baselineSha: null,
      stages: [
        STAGE({
          stageName: 'publish',
          kind: 'program',
          status: 'failed',
          error: 'the code host rejected the draft',
        }),
      ],
    },
    {
      roundId: 'round-1',
      roundSeq: 1,
      status: 'published',
      outcome: 'published',
      baselineSha: null,
      stages: [STAGE()],
    },
  ],
}

describe('RFC-304 T56 — round switching', () => {
  test('the NEWEST round is shown, not the oldest', async () => {
    // The round somebody opens the page for is the one in flight. Defaulting to
    // the oldest would put the least relevant one in front of them.
    installFetch({ workItems: [ITEM_WITH_ROUNDS] })
    await renderPage('/code?tab=activity')
    expect(await screen.findByTestId('code-stages-round-3')).toBeTruthy()
    expect(screen.queryByTestId('code-stages-round-1')).toBeNull()
  })

  test('switching shows another round, and only that one', async () => {
    installFetch({ workItems: [ITEM_WITH_ROUNDS] })
    await renderPage('/code?tab=activity')
    await screen.findByTestId('code-stages-round-3')

    fireEvent.click(screen.getByTestId('code-round-picker-item-1-round-2'))

    expect(await screen.findByTestId('code-stages-round-2')).toBeTruthy()
    // The point of switching rather than stacking: one round at a time.
    expect(screen.queryByTestId('code-stages-round-3')).toBeNull()
    // And the round's own failure reason came with it.
    expect(screen.getByText(/the code host rejected the draft/i)).toBeTruthy()
  })

  test('a single-round item shows no switcher', async () => {
    // A picker with one option is chrome that implies history exists.
    installFetch({
      workItems: [{ ...ITEM_WITH_ROUNDS, rounds: [ITEM_WITH_ROUNDS.rounds[0]] }],
    })
    await renderPage('/code?tab=activity')
    await screen.findByTestId('code-stages-round-3')
    expect(screen.queryByTestId('code-round-picker-item-1-round-3')).toBeNull()
  })
})

describe('RFC-304 T55 — the model calls behind a stage', () => {
  const ATTEMPTS = [
    {
      attemptId: 'att-1',
      stageName: 'review-shard',
      shardKey: 'src/a.ts',
      rerunSeq: 0,
      attemptSeq: 0,
      status: 'failed',
      validationOutcome: 'the envelope named a port the stage does not declare',
      sessionRef: 'sess-1',
      nodeRunId: 'nr-1',
      startedAt: 1,
      endedAt: 2,
    },
    {
      attemptId: 'att-2',
      stageName: 'review-shard',
      shardKey: 'src/a.ts',
      rerunSeq: 0,
      attemptSeq: 1,
      status: 'validated',
      validationOutcome: null,
      sessionRef: 'sess-1',
      nodeRunId: 'nr-1',
      startedAt: 3,
      endedAt: 4,
    },
  ]

  test('attempts are NOT fetched until the stage is expanded', async () => {
    // Attempts are the widest rows in the model and most rounds are never
    // opened. Loading them with the list makes every visit pay for a level
    // almost nobody looks at.
    const rec = installFetch({ workItems: [ITEM_WITH_ROUNDS], attempts: ATTEMPTS })
    await renderPage('/code?tab=activity')
    await screen.findByTestId('code-stages-round-3')

    expect(rec.calls.some((c) => c.url.includes('/attempts'))).toBe(false)
  })

  test('expanding shows each call, its verdict, and both retry counters', async () => {
    installFetch({ workItems: [ITEM_WITH_ROUNDS], attempts: ATTEMPTS })
    await renderPage('/code?tab=activity')
    await screen.findByTestId('code-stages-round-3')

    fireEvent.click(screen.getByTestId('code-attempts-toggle-round-3-review-shard'))

    expect(await screen.findByTestId('code-attempts-round-3-review-shard')).toBeTruthy()
    // The guard's own words — "named an undeclared port" and "the JSON did not
    // parse" lead to different fixes, so the page must not reduce them.
    expect(screen.getByText(/the envelope named a port the stage does not declare/i)).toBeTruthy()
    // Both counters, separately: session 1 try 1 failed, session 1 try 2 passed.
    expect(screen.getByText(/session 1, try 1/i)).toBeTruthy()
    expect(screen.getByText(/session 1, try 2/i)).toBeTruthy()
  })

  test('two AI stages in one round do not show each other’s calls', async () => {
    // One fetch serves every stage of a round (they share a query key), so the
    // per-stage filter is the only thing keeping them apart. Without it each
    // stage lists the whole round's calls and every retry appears to have
    // happened everywhere — which reads as the platform looping.
    const TWO_STAGE_ROUND = {
      ...ITEM_WITH_ROUNDS,
      rounds: [
        {
          roundId: 'round-3',
          roundSeq: 3,
          status: 'published',
          outcome: 'published',
          baselineSha: null,
          stages: [STAGE(), STAGE({ stageName: 'review-global', stageSeq: 2 })],
        },
      ],
    }
    installFetch({
      workItems: [TWO_STAGE_ROUND],
      attempts: [
        ...ATTEMPTS,
        {
          attemptId: 'att-9',
          stageName: 'review-global',
          shardKey: '',
          rerunSeq: 1,
          attemptSeq: 0,
          status: 'validated',
          validationOutcome: null,
          sessionRef: 'sess-2',
          nodeRunId: 'nr-2',
          startedAt: 9,
          endedAt: 10,
        },
      ],
    })
    await renderPage('/code?tab=activity')
    await screen.findByTestId('code-stages-round-3')

    fireEvent.click(screen.getByTestId('code-attempts-toggle-round-3-review-global'))
    const list = await screen.findByTestId('code-attempts-round-3-review-global')

    // Exactly its own one call — not the two belonging to `review-shard`.
    expect(list.querySelectorAll('li').length).toBe(1)
    expect(list.textContent).toContain('Session 2')
    expect(list.textContent).not.toContain('src/a.ts')
  })

  test('a program stage offers no model-call toggle at all', async () => {
    // Not an empty list — there is no such thing as a model call for a program
    // stage, and offering the control suggests otherwise.
    installFetch({ workItems: [ITEM_WITH_ROUNDS], attempts: [] })
    await renderPage('/code?tab=activity')
    await screen.findByTestId('code-stages-round-3')

    fireEvent.click(screen.getByTestId('code-round-picker-item-1-round-2'))
    await screen.findByTestId('code-stages-round-2')

    expect(screen.queryByTestId('code-attempts-toggle-round-2-publish')).toBeNull()
  })
})

// RFC-304 T58 — the results tab, and the number it must never invent.
//
// The backend refuses to compute an adoption rate because `resolved` and `code
// changed` disagree in exactly the informative cases. The page is the other
// place that refusal can be undone — one `Math.round(adopted / published)` and
// a reviewer clearing their queue reads as total success with nothing fixed.
describe('RFC-304 T58 — the results tab', () => {
  const METRICS = {
    windowMs: 30 * 86_400_000,
    adoption: [
      {
        capability: 'mr-review',
        published: 10,
        adopted: 4,
        quietFix: 3,
        disagreed: 2,
        outstanding: 1,
      },
    ],
    runs: [
      {
        capability: 'mr-review',
        rounds: 12,
        published: 9,
        failed: 2,
        awaiting: 0,
        incomplete: 1,
      },
    ],
  }

  test('all four adoption outcomes are shown separately', async () => {
    installFetch({ metrics: METRICS })
    await renderPage('/code?tab=metrics')

    const row = await screen.findByTestId('code-metrics-adoption-mr-review')
    const cells = [...row.querySelectorAll('td')].map((c) => c.textContent)
    expect(cells).toEqual(['mr-review', '10', '4', '3', '2', '1'])
  })

  test('“resolved but not fixed” is shown, not hidden as a failure', async () => {
    // The signal that tells a team to retune the reviewer rather than mute it.
    // A page that only showed successes would leave them with no way to tell
    // the difference between "nobody has looked" and "people looked and said no".
    installFetch({ metrics: METRICS })
    await renderPage('/code?tab=metrics')
    expect(await screen.findByText(/resolved, not fixed/i)).toBeTruthy()
  })

  test('the window is stated, so the numbers mean something', async () => {
    installFetch({ metrics: METRICS })
    await renderPage('/code?tab=metrics')
    expect(await screen.findByText(/last 30 days/i)).toBeTruthy()
  })

  test('an incomplete round is its own column, apart from failures', async () => {
    // A daemon death is the platform breaking; a failed round is the round
    // deciding. Merged, an infrastructure problem looks like the capability
    // performing badly and someone switches it off.
    installFetch({ metrics: METRICS })
    await renderPage('/code?tab=metrics')

    const row = await screen.findByTestId('code-metrics-runs-mr-review')
    const cells = [...row.querySelectorAll('td')].map((c) => c.textContent)
    expect(cells).toEqual(['mr-review', '12', '9', '2', '0', '1'])
  })

  test('with nothing measured it says so rather than showing zeroes', async () => {
    // A table of zeroes reads as "the capability is failing"; the truth is that
    // nothing has run yet.
    installFetch({})
    await renderPage('/code?tab=metrics')
    expect(await screen.findByText(/nothing to measure yet/i)).toBeTruthy()
  })
})

// RFC-309 T30 — one list of templates.
//
// RFC-304 shipped two, and this block used to assert they stayed apart: a
// framework carried scripts that run as the daemon, a binding carried none, and
// the split was how a group lead could own one and not the other. The user
// overturned it — 「不需要区分组织模版和小组模版了，就是一套模版，大家可以复制
// 修改就行了」 — so what these tests now lock is that the permission survived
// the merge as a FIELD-level rule (`scriptsRedacted`) rather than as a second
// list. A template a reader may not see the scripts of is still shown, still
// copyable, and still says why part of it is missing.
describe('RFC-309 — the templates tab', () => {
  const TEMPLATE = {
    ...API_TEMPLATE,
    id: 'tpl-1',
    name: 'gitlab standard',
    description: 'the shipped review pipeline',
    scriptsRedacted: true,
    paramSchema: [{ name: 'maxFindings', kind: 'number' }],
    paramDefaults: { maxFindings: 20 },
    agentBySlot: { reviewer: 'auditor' },
    visibility: 'public',
    updatedAt: 1000,
  }

  const COPY = {
    ...TEMPLATE,
    id: 'tpl-2',
    name: 'platform team review',
    description: null,
    scriptsRedacted: false,
    visibility: 'private',
    ownerUserId: 'u-1',
    // T64 — this one is a copy, so the page shows its origin.
    upstream: { upstreamId: 'tpl-1', upstreamVersion: 900, baseDigest: 'd0' },
  }

  test('a template whose scripts are hidden SAYS so', async () => {
    // Without this the reader sees a template with no scripts and concludes it
    // is broken. The label is the difference between "you may not see this" and
    // "there is nothing here" — and after RFC-309 it is the ONLY thing left
    // marking the daemon-grade fields, so it carries more weight than before.
    installFetch({ templates: [TEMPLATE] })
    await renderPage('/code?tab=templates')
    expect(await screen.findByText(/scripts hidden/i)).toBeTruthy()
  })

  test('a template says which capability it drives and which agent fills each slot', async () => {
    // The pair a person needs to answer "is this the one I want?". Before the
    // merge it took two rows and a lookup by id to learn both.
    installFetch({ templates: [TEMPLATE] })
    await renderPage('/code?tab=templates')

    const row = await screen.findByTestId('code-template-tpl-1')
    expect(row.textContent).toContain('mr-review')
    expect(row.textContent).toContain('reviewer → auditor')
  })

  test('copying posts to the one copy endpoint', async () => {
    // One endpoint after the merge, not one per layer. Copy is now how a team
    // GETS a template — there is no shared department row to point at.
    const rec = installFetch({ templates: [TEMPLATE, COPY] })
    await renderPage('/code?tab=templates')
    await screen.findByTestId('code-template-tpl-1')

    fireEvent.click(screen.getByTestId('code-template-copy-tpl-1'))
    await waitFor(() =>
      expect(
        rec.calls.some(
          (c) => c.method === 'POST' && c.url.includes('/api/capability-templates/tpl-1/copy'),
        ),
      ).toBe(true),
    )
  })

  test('every template is in ONE list, whatever its scripts say', async () => {
    // The regression this guards is the merge being undone by accident: a
    // `scriptsRedacted` template quietly sorted into its own section would put
    // the old two-layer mental model back without anyone deciding to.
    installFetch({ templates: [TEMPLATE, COPY] })
    await renderPage('/code?tab=templates')

    const list = await screen.findByTestId('code-templates')
    expect(list.querySelectorAll('li[data-testid^="code-template-"]').length).toBe(2)
    expect(screen.queryByTestId('code-frameworks')).toBeNull()
    expect(screen.queryByTestId('code-bindings')).toBeNull()
  })

  test("the wizard draws the capability's steps — RFC-307 AC-1 keeps its home", async () => {
    // RFC-309 deleted the Flow tab, and with it the only place the structure
    // could be seen before anything was configured. Without this the deletion
    // would have quietly taken away an acceptance criterion another RFC still
    // holds: on a fresh install there are no templates to open.
    installFetch({
      templates: [],
      catalog: [{ capability: 'mr-review', agentSlots: ['reviewer'] }],
      agents: [{ id: 'agent-1', name: 'auditor' }],
      graph: {
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
        ],
        edges: [],
      },
    })
    await renderPage('/code?tab=templates')
    fireEvent.click(await screen.findByTestId('code-new-template'))

    // Nothing is drawn until a capability is chosen — there is no structure to
    // show, and an empty canvas would read as "this capability does nothing".
    expect(screen.queryByTestId('code-capability-structure')).toBeNull()

    fireEvent.click(screen.getByTestId('code-template-capability'))
    fireEvent.mouseDown(await screen.findByRole('option', { name: /Merge request review/i }))

    expect(await screen.findByTestId('code-capability-structure')).toBeTruthy()
  })

  test('a capability with no sequence SAYS so rather than showing nothing', async () => {
    // `mr-monitor` is the standing monitor loop. Rendering nothing would read
    // as "the picture failed to load" on the one screen where somebody is
    // choosing which capability to build a template for.
    installFetch({
      templates: [],
      catalog: [{ capability: 'mr-monitor', agentSlots: [] }],
      graph: { capability: 'mr-monitor', reason: 'no-stage-contract' },
    })
    await renderPage('/code?tab=templates')
    fireEvent.click(await screen.findByTestId('code-new-template'))

    fireEvent.click(screen.getByTestId('code-template-capability'))
    fireEvent.mouseDown(await screen.findByRole('option', { name: /monitor/i }))

    expect(await screen.findByTestId('code-capability-structure-none')).toBeTruthy()
    expect(screen.queryByTestId('code-capability-structure')).toBeNull()
  })

  test('creating a template is offered from the list itself', async () => {
    // RFC-309 D2: with the layers merged there is exactly one create action,
    // and it is where the templates are — not two, split by a permission the
    // person could not see.
    installFetch({ templates: [] })
    await renderPage('/code?tab=templates')
    expect(await screen.findByTestId('code-new-template')).toBeTruthy()
  })
})

// RFC-304 T57(b)/(c) — export and origin, unblocked once T17a and T64 landed.
describe('RFC-309 — export and upstream state', () => {
  const TEMPLATE = { ...API_TEMPLATE, id: 'tpl-1', name: 'gitlab standard', updatedAt: 1000 }

  const COPY = {
    ...TEMPLATE,
    id: 'tpl-2',
    name: 'my copy',
    upstream: { upstreamId: 'tpl-1', upstreamVersion: 900, baseDigest: 'd0' },
  }

  test('a template nobody copied shows NO origin badge', async () => {
    // A badge on every original would be noise on the common case, which is
    // how a badge stops being read at all.
    installFetch({ templates: [TEMPLATE] })
    await renderPage('/code?tab=templates')
    await screen.findByTestId('code-template-tpl-1')
    expect(screen.queryByText(/copied from/i)).toBeNull()
  })

  test('a copy shows where it came from', async () => {
    installFetch({ templates: [COPY] })
    await renderPage('/code?tab=templates')
    expect(await screen.findByText(/copied from/i)).toBeTruthy()
  })

  test('export is offered for a template', async () => {
    installFetch({ templates: [TEMPLATE] })
    await renderPage('/code?tab=templates')
    const row = await screen.findByTestId('code-template-tpl-1')
    // The shared export primitive, not a hand-rolled link: it carries the
    // fence, the filename and the error handling every other resource gets.
    expect(row.textContent?.toLowerCase()).toContain('export')
  })

  test('the matrix can POINT a capability at a template — the step that was missing', async () => {
    // The page could switch a capability ON but never give it one, so the cell
    // sat `misconfigured` forever and the only way to configure the platform
    // was the HTTP API. This is that gap, closed.
    const rec = installFetch({
      rows: [
        {
          repoId: 'repo-1',
          capability: 'mr-review',
          enabled: false,
          readiness: 'misconfigured',
          issues: [
            { code: 'no-binding', detail: 'no capability binding is selected for this repo' },
          ],
          repairActions: [
            { code: 'no-binding', label: 'Choose one', route: '/code?tab=templates' },
          ],
          templateId: null,
        },
      ],
      templates: [API_TEMPLATE],
    })
    await renderPage('/code?repo=repo-1')

    // The repo's Select idiom: click the combobox, then mouseDown the option.
    fireEvent.click(await screen.findByTestId('code-template-pick-mr-review'))
    fireEvent.mouseDown(await screen.findByRole('option', { name: 'Our reviewers' }))

    await waitFor(() => {
      const put = rec.calls.find((c) => c.method === 'PUT' && c.url.includes('/api/code/matrix'))
      expect(put?.body).toMatchObject({ capability: 'mr-review', templateId: 'bd-1' })
    })
  })

  test('only templates for THIS capability are offered', async () => {
    // A template names its capability directly after RFC-309 — before the merge
    // it inherited one through its framework, which is how a review binding
    // could be offered for `ci-fix` at all. Doing so would produce a cell that
    // reads `ready` and fails at its first AI stage, on the merge request, in
    // front of the author.
    installFetch({
      rows: [
        {
          repoId: 'repo-1',
          capability: 'ci-fix',
          enabled: false,
          readiness: 'misconfigured',
          issues: [],
          repairActions: [],
          templateId: null,
        },
      ],
      templates: [
        API_TEMPLATE,
        { ...API_TEMPLATE, id: 'tpl-ci', name: 'Our CI fixers', capability: 'ci-fix' },
      ],
    })
    await renderPage('/code?repo=repo-1')

    fireEvent.click(await screen.findByTestId('code-template-pick-ci-fix'))
    expect(await screen.findByRole('option', { name: 'Our CI fixers' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Our reviewers' })).toBeNull()
  })

  test('toggling enabled KEEPS the chosen template', async () => {
    // The server takes the cell as sent. A toggle that omitted `templateId`
    // would silently clear a configuration somebody had just made — and the
    // capability would go back to `misconfigured` for no visible reason.
    const rec = installFetch({
      rows: [
        {
          repoId: 'repo-1',
          capability: 'mr-review',
          enabled: false,
          readiness: 'ready',
          issues: [],
          repairActions: [],
          templateId: 'bd-1',
        },
      ],
      templates: [API_TEMPLATE],
    })
    await renderPage('/code?repo=repo-1')

    fireEvent.click(await screen.findByTestId('code-toggle-mr-review'))

    await waitFor(() => {
      const put = rec.calls.find((c) => c.method === 'PUT' && c.url.includes('/api/code/matrix'))
      expect(put?.body).toMatchObject({ enabled: true, templateId: 'bd-1' })
    })
  })
})
