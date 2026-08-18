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
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
