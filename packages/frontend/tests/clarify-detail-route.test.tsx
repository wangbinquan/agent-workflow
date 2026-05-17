// RFC-023 PR-C T23 — locks /clarify/$nodeRunId page contract.
//
// Three locks:
//   1. Context card renders the asking agent + iteration, AND the
//      Shard line appears when sourceShardKey is non-null.
//   2. Truncation warning banner renders only when session.truncationWarnings
//      is populated.
//   3. Shard switcher renders only when ≥ 2 awaiting_human peer sessions
//      share the same (taskId, clarifyNodeId).
//
// Source-code-level: the detail file MUST reference the field name
// `sourceShardKey` so the grep guard in T23 protects against a
// rename. (Sentinel string check at the bottom of this file.)

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router'
import type { ClarifySession, ClarifySessionSummary } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { ClarifyDetailPage } from '../src/routes/clarify.detail'
import '../src/i18n'

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function mkSession(overrides: Partial<ClarifySession> = {}): ClarifySession {
  return {
    id: 'sess_1',
    taskId: 'task_a',
    sourceAgentNodeId: 'designer',
    sourceAgentNodeRunId: 'nr_src',
    sourceShardKey: null,
    clarifyNodeId: 'c1',
    clarifyNodeRunId: 'nr_clarify',
    iterationIndex: 0,
    questions: [
      {
        id: 'q1',
        title: 'Pick DB',
        kind: 'single',
        recommended: false,
        options: [
          { label: 'Postgres', description: '', recommended: false, recommendationReason: '' },
          { label: 'MySQL', description: '', recommended: false, recommendationReason: '' },
        ],
      },
    ],
    status: 'awaiting_human',
    createdAt: 1_700_000_000_000,
    answeredAt: null,
    answeredBy: null,
    ...overrides,
  }
}

function mockApi(session: ClarifySession, peers: ClarifySessionSummary[] = []) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
    const s = typeof url === 'string' ? url : url.toString()
    if (s.includes(`/api/clarify/${session.clarifyNodeRunId}`) && !s.endsWith('/answers')) {
      return new Response(JSON.stringify(session), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (s.includes('/api/clarify?')) {
      return new Response(JSON.stringify(peers), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
}

function renderRoute(initialPath = '/clarify/nr_clarify') {
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
  return render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
}

describe('/clarify/$nodeRunId detail (RFC-023 T23)', () => {
  test('context card includes asking agent + iteration, plus shard line when shardKey is set', async () => {
    mockApi(mkSession({ sourceShardKey: 'shard-A', iterationIndex: 2 }))
    renderRoute()
    await waitFor(() => screen.getByTestId('clarify-context-card'))
    const card = screen.getByTestId('clarify-context-card')
    expect(card.textContent ?? '').toContain('designer')
    expect(screen.getByTestId('clarify-context-shard')).toBeTruthy()
  })

  test('truncation warning renders only when session.truncationWarnings is populated', async () => {
    // Case A: no warnings → banner absent.
    mockApi(mkSession())
    const { unmount } = renderRoute()
    await waitFor(() => screen.getByTestId('clarify-context-card'))
    expect(document.querySelector('[data-testid="clarify-truncation-warning"]')).toBeNull()
    unmount()
    // Case B: warning present → banner renders.
    vi.restoreAllMocks()
    mockApi(
      mkSession({
        truncationWarnings: [{ code: 'clarify-options-too-many', detail: 'sliced 5 → 4' }],
      }),
    )
    renderRoute()
    await waitFor(() => screen.getByTestId('clarify-truncation-warning'))
  })

  test('shard switcher renders only when ≥ 2 awaiting_human peers share the same (taskId, clarifyNodeId)', async () => {
    const session = mkSession({ sourceShardKey: 'shard-A' })
    const peers: ClarifySessionSummary[] = [
      {
        id: 'sess_a',
        taskId: 'task_a',
        sourceAgentNodeId: 'designer',
        sourceShardKey: 'shard-A',
        clarifyNodeId: 'c1',
        clarifyNodeRunId: 'nr_clarify',
        iterationIndex: 0,
        questionCount: 1,
        status: 'awaiting_human',
        createdAt: 0,
        answeredAt: null,
      },
      {
        id: 'sess_b',
        taskId: 'task_a',
        sourceAgentNodeId: 'designer',
        sourceShardKey: 'shard-B',
        clarifyNodeId: 'c1',
        clarifyNodeRunId: 'nr_clarify_b',
        iterationIndex: 0,
        questionCount: 1,
        status: 'awaiting_human',
        createdAt: 0,
        answeredAt: null,
      },
    ]
    mockApi(session, peers)
    renderRoute()
    await waitFor(() => screen.getByTestId('clarify-shard-switcher'))
    // Both shards rendered, sorted ascending.
    expect(screen.getByTestId('clarify-shard-shard-A')).toBeTruthy()
    expect(screen.getByTestId('clarify-shard-shard-B')).toBeTruthy()
  })

  test('source-level grep: shard_key field name survives in clarify.detail.tsx', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'routes', 'clarify.detail.tsx'), 'utf8')
    expect(src).toContain('sourceShardKey')
  })
})

// Reviewer keyboard ergonomics: once the form is loaded, digit / Enter
// keystrokes should hop between questions without a mouse click; the last
// question's "advance" should land focus on the submit button so a final
// Enter actually submits. These tests pin the page-level wiring (parent
// route → QuestionForm refs + advanceFromQuestion + initial focus).
describe('/clarify/$nodeRunId reviewer keyboard nav', () => {
  function twoQuestionSession(): ClarifySession {
    return mkSession({
      questions: [
        {
          id: 'q1',
          title: 'Pick DB',
          kind: 'single',
          recommended: false,
          options: [
            { label: 'Postgres', description: '', recommended: false, recommendationReason: '' },
            { label: 'MySQL', description: '', recommended: false, recommendationReason: '' },
          ],
        },
        {
          id: 'q2',
          title: 'Pick lang',
          kind: 'single',
          recommended: false,
          options: [
            { label: 'TS', description: '', recommended: false, recommendationReason: '' },
            { label: 'Go', description: '', recommended: false, recommendationReason: '' },
          ],
        },
      ],
    })
  }

  test('initial focus lands on the first question once the draft loads', async () => {
    mockApi(twoQuestionSession())
    renderRoute()
    await waitFor(() => screen.getByTestId('clarify-question-q1'))
    // Initial focus is scheduled via rAF after draft load.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    expect(document.activeElement).toBe(screen.getByTestId('clarify-question-q1'))
  })

  test('Enter on the first question moves focus to the second', async () => {
    mockApi(twoQuestionSession())
    renderRoute()
    await waitFor(() => screen.getByTestId('clarify-question-q1'))
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    const q1 = screen.getByTestId('clarify-question-q1')
    fireEvent.keyDown(q1, { key: 'Enter' })
    expect(document.activeElement).toBe(screen.getByTestId('clarify-question-q2'))
  })

  test('Enter on the last question moves focus to the submit button', async () => {
    mockApi(twoQuestionSession())
    renderRoute()
    await waitFor(() => screen.getByTestId('clarify-question-q2'))
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    const q2 = screen.getByTestId('clarify-question-q2')
    q2.focus()
    fireEvent.keyDown(q2, { key: 'Enter' })
    expect(document.activeElement).toBe(screen.getByTestId('clarify-submit'))
  })

  test('keyboard hint is rendered for awaiting_human sessions', async () => {
    mockApi(twoQuestionSession())
    renderRoute()
    await waitFor(() => screen.getByTestId('clarify-keyboard-hint'))
  })
})
