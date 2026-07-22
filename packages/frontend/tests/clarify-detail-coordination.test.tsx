// RFC-128 P4 (T10) — /clarify page coordination grey-out.
//
// The clarify page reads the task's per-question seal/dispatch state
// (GET /api/tasks/:id/questions) so a question already sealed/dispatched via the
// centralized answer pane (or the board) is:
//   1. rendered read-only (its QuestionForm inputs disabled) + a coordination note;
//   2. EXCLUDED from the submit body (capped via `questionIds`) so it's never
//      re-sealed / re-dispatched;
//   3. when EVERY question is locked, the submit buttons are disabled.
// golden-lock: a non-array / unmocked questions response ⇒ no grey-out (unchanged page).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function twoQuestionSelfRound(): ClarifyRound {
  return {
    id: 'rnd_1',
    taskId: 'task_a',
    kind: 'self',
    askingNodeId: 'designer',
    askingNodeRunId: 'nr_src',
    askingShardKey: null,
    intermediaryNodeId: 'c1',
    intermediaryNodeRunId: 'nr_clarify',
    intermediaryNodeTitle: null,
    targetConsumerNodeId: null,
    loopIter: 0,
    iteration: 0,
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
    status: 'awaiting_human',
    terminatedAs: null,
    directive: null,
    sessionMode: null,
    designerRunTriggeredAt: null,
    abandonedAt: null,
    createdAt: 0,
    answeredAt: null,
    answeredBy: null,
    draftAnswers: null,
  }
}

interface WireEntry {
  id: string
  questionId: string
  sealed: boolean
  phase: string
  roleKind: string
  originNodeRunId: string | null
}

function mockApi(
  session: ClarifyRound,
  questions: WireEntry[],
  capture?: { body?: Record<string, unknown> },
) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const s = typeof url === 'string' ? url : url.toString()
      const json = (v: unknown) =>
        new Response(JSON.stringify(v), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      if (s.endsWith('/answers')) {
        if (capture && init?.body) {
          try {
            capture.body = JSON.parse(String(init.body)) as Record<string, unknown>
          } catch {
            /* ignore */
          }
        }
        return json({
          ok: true,
          session: { ...session, status: 'answered' },
          rerunNodeRunId: 'nr_r',
        })
      }
      if (s.includes('/questions')) return json(questions)
      if (s.includes(`/api/clarify/${session.intermediaryNodeRunId}`)) return json(session)
      if (s.includes('/api/clarify?')) return json([])
      return json({})
    },
  )
}

function renderRoute() {
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
  const router = createRouter({
    routeTree: rootRoute.addChildren([detail, list, tasks]),
    history: createMemoryHistory({ initialEntries: ['/clarify/nr_clarify'] }),
  })
  return render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
}

const wire = (over: Partial<WireEntry>): WireEntry => ({
  id: 'e',
  questionId: 'q1',
  sealed: false,
  phase: 'pending',
  roleKind: 'self',
  originNodeRunId: 'nr_clarify',
  ...over,
})

describe('/clarify coordination grey-out (RFC-128 T10)', () => {
  test('a sealed question is read-only + carries a note; an unsealed sibling stays editable', async () => {
    mockApi(twoQuestionSelfRound(), [
      wire({ id: 'e1', questionId: 'q1', sealed: true }),
      wire({ id: 'e2', questionId: 'q2', sealed: false }),
    ])
    renderRoute()
    await waitFor(() => screen.getByTestId('clarify-question-q1'))
    // q1 locked → all its inputs disabled + coordination note present.
    await waitFor(() => screen.getByTestId('clarify-locked-note-q1'))
    const q1Radios = within(screen.getByTestId('clarify-question-q1')).getAllByRole('radio')
    expect(q1Radios.every((r) => (r as HTMLInputElement).disabled)).toBe(true)
    // q2 unsealed → editable, no note.
    expect(screen.queryByTestId('clarify-locked-note-q2')).toBeNull()
    const q2Radios = within(screen.getByTestId('clarify-question-q2')).getAllByRole('radio')
    expect(q2Radios.some((r) => !(r as HTMLInputElement).disabled)).toBe(true)
  })

  test('submit excludes the sealed question + sends NO questionIds on the quick channel (Codex P1-1)', async () => {
    const capture: { body?: Record<string, unknown> } = {}
    mockApi(
      twoQuestionSelfRound(),
      [
        wire({ id: 'e1', questionId: 'q1', sealed: true, phase: 'processing' }),
        wire({ id: 'e2', questionId: 'q2', sealed: false }),
      ],
      capture,
    )
    renderRoute()
    await waitFor(() => screen.getByTestId('clarify-locked-note-q1'))
    fireEvent.click(screen.getByTestId('clarify-submit-continue'))
    await waitFor(() => expect(capture.body).toBeDefined())
    // P1-1: the quick channel (defer unset) must NOT send questionIds — the backend gates that
    // combo ('clarify-question-ids-requires-defer'). The locked q1 is just excluded from
    // `answers`; the backend re-merges its already-sealed answer (lockedIds) → whole round.
    expect(capture.body!.questionIds).toBeUndefined()
    expect(capture.body!.defer).toBeUndefined()
    const answers = capture.body!.answers as Array<{ questionId: string }>
    expect(answers.map((a) => a.questionId)).toEqual(['q2'])
  })

  test('a sibling round sealing the same questionId does NOT lock this round (Codex P2-1)', async () => {
    // This round (nr_clarify) has q1 UNSEALED. A DIFFERENT round (nr_other) has its OWN q1
    // sealed. The board returns task-wide entries; q1 here must stay editable (round-local).
    mockApi(twoQuestionSelfRound(), [
      wire({ id: 'e-other', questionId: 'q1', sealed: true, originNodeRunId: 'nr_other' }),
      wire({ id: 'e1', questionId: 'q1', sealed: false, originNodeRunId: 'nr_clarify' }),
      wire({ id: 'e2', questionId: 'q2', sealed: false, originNodeRunId: 'nr_clarify' }),
    ])
    renderRoute()
    await waitFor(() => screen.getByTestId('clarify-question-q1'))
    expect(screen.queryByTestId('clarify-locked-note-q1')).toBeNull()
    const q1Radios = within(screen.getByTestId('clarify-question-q1')).getAllByRole('radio')
    expect(q1Radios.some((r) => !(r as HTMLInputElement).disabled)).toBe(true)
  })

  test('every question locked → submit buttons disabled', async () => {
    mockApi(twoQuestionSelfRound(), [
      wire({ id: 'e1', questionId: 'q1', sealed: true }),
      wire({ id: 'e2', questionId: 'q2', sealed: false, phase: 'done' }),
    ])
    renderRoute()
    await waitFor(() => screen.getByTestId('clarify-submit-continue'))
    await waitFor(() =>
      expect((screen.getByTestId('clarify-submit-continue') as HTMLButtonElement).disabled).toBe(
        true,
      ),
    )
    expect((screen.getByTestId('clarify-submit-stop') as HTMLButtonElement).disabled).toBe(true)
  })

  test('golden-lock: non-array questions response → no grey-out, whole-round submit', async () => {
    const capture: { body?: Record<string, unknown> } = {}
    // questions endpoint returns {} (non-array) → empty locked set.
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const s = typeof url === 'string' ? url : url.toString()
        const session = twoQuestionSelfRound()
        const json = (v: unknown) =>
          new Response(JSON.stringify(v), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        if (s.endsWith('/answers')) {
          if (init?.body) capture.body = JSON.parse(String(init.body)) as Record<string, unknown>
          return json({
            ok: true,
            session: { ...session, status: 'answered' },
            rerunNodeRunId: 'r',
          })
        }
        if (s.includes('/questions')) return json({})
        if (s.includes('/api/clarify/nr_clarify')) return json(session)
        if (s.includes('/api/clarify?')) return json([])
        return json({})
      },
    )
    renderRoute()
    await waitFor(() => screen.getByTestId('clarify-question-q1'))
    expect(screen.queryByTestId('clarify-locked-note-q1')).toBeNull()
    fireEvent.click(screen.getByTestId('clarify-submit-continue'))
    await waitFor(() => expect(capture.body).toBeDefined())
    // No locked questions ⇒ no questionIds cap (byte-for-byte pre-RFC-128) + all answers.
    expect(capture.body!.questionIds).toBeUndefined()
    expect((capture.body!.answers as unknown[]).length).toBe(2)
  })
})
