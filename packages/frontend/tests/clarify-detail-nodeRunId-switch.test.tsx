// RFC-051 — Clarify detail resets per-session state when `nodeRunId`
// changes on the same mounted component.
//
// Bug locked in:
//   Clicking from clarify session A's inbox row to clarify session B's
//   on the same `/clarify/$nodeRunId` route leaves the previous session's
//   `answers` dictionary in state. The one-shot `draftLoaded` flag blocks
//   the seeding effect from re-running with B's questions, so every
//   render of B's question list goes through `answers[B.question.id] ===
//   undefined` → `return null` and the user sees an empty form.
//
// Two regression locks:
//
//  1. After navigating from A → B with the same component mount, B's
//     QuestionForm(s) actually render.
//
//  2. Source-level: the route file MUST contain a `useEffect(..., [
//     nodeRunId])` reset block that clears `answers` / `draftLoaded` /
//     `initialFocusedRef`. Without the source-level guard a future
//     refactor that removes the reset (intentionally or by accident)
//     would only fail the integration-style case above, which is more
//     expensive to bisect.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router'
import type { ClarifyRound } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { ClarifyDetailPage } from '../src/routes/clarify.detail'
import '../src/i18n'

const ROUTE_TSX = resolve(__dirname, '..', 'src', 'routes', 'clarify.detail.tsx')

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function mkSession(over: Partial<ClarifyRound>): ClarifyRound {
  return {
    id: 'sess_x',
    taskId: 'task_x',
    kind: 'self',
    askingNodeId: 'designer',
    askingNodeRunId: 'nr_src',
    askingShardKey: null,
    intermediaryNodeId: 'c1',
    intermediaryNodeRunId: 'nr_A',
    intermediaryNodeTitle: null,
    targetConsumerNodeId: null,
    loopIter: 0,
    iteration: 0,
    questions: [
      {
        id: 'qA1',
        title: 'Question for A',
        kind: 'single',
        recommended: false,
        options: [
          { label: 'opt1', description: '', recommended: false, recommendationReason: '' },
          { label: 'opt2', description: '', recommended: false, recommendationReason: '' },
        ],
      },
    ],
    status: 'awaiting_human',
    createdAt: 1_700_000_000_000,
    answeredAt: null,
    answeredBy: null,
    directive: null,
    sessionMode: null,
    designerRunTriggeredAt: null,
    abandonedAt: null,
    ...over,
  }
}

function mockApi(byNodeRunId: Record<string, ClarifyRound>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
    const s = typeof url === 'string' ? url : url.toString()
    for (const [nodeRunId, sess] of Object.entries(byNodeRunId)) {
      if (s.includes(`/api/clarify/${nodeRunId}`) && !s.endsWith('/answers')) {
        return new Response(JSON.stringify(sess), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
    }
    if (s.includes('/api/clarify?')) {
      return new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
}

function renderRoute(initialPath: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const detail = createRoute({
    getParentRoute: () => rootRoute,
    path: '/clarify/$nodeRunId',
    component: ClarifyDetailPage,
  })
  const list = createRoute({
    getParentRoute: () => rootRoute,
    path: '/clarify',
    component: () => null,
  })
  const tasks = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks/$id',
    component: () => null,
  })
  const tree = rootRoute.addChildren([detail, list, tasks])
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  })
  return {
    qc,
    router,
    view: render(
      <QueryClientProvider client={qc}>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <RouterProvider router={router as any} />
      </QueryClientProvider>,
    ),
  }
}

describe('/clarify/$nodeRunId — RFC-051 reset on nodeRunId switch', () => {
  test("navigating A → B on the same mount renders B's questions (not empty form)", async () => {
    const sessA = mkSession({
      id: 'sess_a',
      intermediaryNodeRunId: 'nr_A',
      questions: [
        {
          id: 'qA1',
          title: 'Question for A',
          kind: 'single',
          recommended: false,
          options: [
            { label: 'A-1', description: '', recommended: false, recommendationReason: '' },
            { label: 'A-2', description: '', recommended: false, recommendationReason: '' },
          ],
        },
      ],
    })
    const sessB = mkSession({
      id: 'sess_b',
      intermediaryNodeRunId: 'nr_B',
      questions: [
        {
          id: 'qB1',
          title: 'Question 1 for B',
          kind: 'single',
          recommended: false,
          options: [
            { label: 'B-1', description: '', recommended: false, recommendationReason: '' },
            { label: 'B-2', description: '', recommended: false, recommendationReason: '' },
          ],
        },
        {
          id: 'qB2',
          title: 'Question 2 for B',
          kind: 'multi',
          recommended: false,
          options: [
            { label: 'B-X', description: '', recommended: false, recommendationReason: '' },
            { label: 'B-Y', description: '', recommended: false, recommendationReason: '' },
          ],
        },
      ],
    })
    mockApi({ nr_A: sessA, nr_B: sessB })
    const { router } = renderRoute('/clarify/nr_A')
    // Wait until A's question lands.
    await waitFor(() => {
      expect(screen.queryByText('Question for A')).not.toBeNull()
    })
    // Navigate to B on the same mount — the bug is that the
    // ClarifyDetailPage instance is reused (TanStack Router behaviour),
    // and B's questions silently fail to render because answers[] still
    // has A's question.id keys.
    await router.navigate({ to: '/clarify/$nodeRunId', params: { nodeRunId: 'nr_B' } })
    await waitFor(() => {
      expect(screen.queryByText('Question 1 for B')).not.toBeNull()
      expect(screen.queryByText('Question 2 for B')).not.toBeNull()
    })
    // A's question must no longer be in the DOM (we navigated away).
    expect(screen.queryByText('Question for A')).toBeNull()
  })

  test('source-level: route resets answers + draftLoaded + initialFocusedRef on nodeRunId change', () => {
    // Why: the integration test above will catch a future regression at
    // runtime, but bisecting "why is B's form empty again" is expensive.
    // This guard makes the regression a 1-test failure with a clear
    // pointer at the exact lines that must keep their shape.
    const src = readFileSync(ROUTE_TSX, 'utf8')
    // The reset effect: a useEffect dep array [nodeRunId] that clears
    // all three pieces of per-session state. We assert the symptom: the
    // file contains the four reset lines and the dep array.
    expect(src).toContain('setAnswers({})')
    expect(src).toContain('setDraftLoaded(false)')
    expect(src).toContain('initialFocusedRef.current = false')
    expect(src).toMatch(/}, \[nodeRunId\]\)/)
  })
})
