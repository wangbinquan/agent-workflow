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
import type { ClarifyRound, ClarifyRoundSummary } from '@agent-workflow/shared'
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

// RFC-058: fixtures accept legacy aliases so older test cases stay readable.
type LegacySessionOverrides = Partial<{
  sourceAgentNodeId: string
  sourceAgentNodeRunId: string
  sourceShardKey: string | null
  clarifyNodeId: string
  clarifyNodeTitle: string | null
  clarifyNodeRunId: string
  iterationIndex: number
}> &
  Partial<ClarifyRound>

function mkSession(overrides: LegacySessionOverrides = {}): ClarifyRound {
  const {
    sourceAgentNodeId,
    sourceAgentNodeRunId,
    sourceShardKey,
    clarifyNodeId,
    clarifyNodeTitle,
    clarifyNodeRunId,
    iterationIndex,
    ...rest
  } = overrides
  return {
    id: 'sess_1',
    taskId: 'task_a',
    kind: 'self',
    askingNodeId: sourceAgentNodeId ?? 'designer',
    askingNodeRunId: sourceAgentNodeRunId ?? 'nr_src',
    askingShardKey: sourceShardKey ?? null,
    intermediaryNodeId: clarifyNodeId ?? 'c1',
    intermediaryNodeRunId: clarifyNodeRunId ?? 'nr_clarify',
    intermediaryNodeTitle: clarifyNodeTitle ?? null,
    targetConsumerNodeId: null,
    loopIter: 0,
    iteration: iterationIndex ?? 0,
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
    directive: null,
    sessionMode: null,
    designerRunTriggeredAt: null,
    abandonedAt: null,
    ...rest,
  }
}

function mockApi(session: ClarifyRound, peers: ClarifyRoundSummary[] = [], taskSnapshot?: unknown) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
    const s = typeof url === 'string' ? url : url.toString()
    if (s.includes(`/api/clarify/${session.intermediaryNodeRunId}`) && !s.endsWith('/answers')) {
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
    // 2026-07-02: optional frozen workflowSnapshot on the task fetch — drives the
    // page's node display-name resolution (节点名 vs 节点 id).
    if (taskSnapshot !== undefined && s.includes(`/api/tasks/${session.taskId}`)) {
      return new Response(
        JSON.stringify({ name: 'fixture-task', workflowSnapshot: taskSnapshot }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
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
    // 无快照 → 节点名解析回退原 id（'designer'）——本用例同时锁住回退路径。
    mockApi(mkSession({ sourceShardKey: 'shard-A', iterationIndex: 2 }))
    renderRoute()
    await waitFor(() => screen.getByTestId('clarify-context-card'))
    const card = screen.getByTestId('clarify-context-card')
    expect(card.textContent ?? '').toContain('designer')
    expect(screen.getByTestId('clarify-context-shard')).toBeTruthy()
  })

  // 2026-07-02 (用户拍板) — 上下文卡的提问节点显示节点名（任务快照 title → agentName → id
  // 回退，lib/node-names 同一 oracle），不再裸渲染 askingNodeId。
  test('context card 提问节点显示节点名（快照解析），不显示裸节点 ID', async () => {
    mockApi(mkSession({ sourceAgentNodeId: 'node-a3' }), [], {
      nodes: [{ id: 'node-a3', kind: 'agent-single', agentName: 'coder', title: '设计师' }],
    })
    renderRoute()
    await waitFor(() => screen.getByTestId('clarify-context-card'))
    const card = screen.getByTestId('clarify-context-card')
    await waitFor(() => expect(card.textContent ?? '').toContain('设计师'))
    expect(card.textContent ?? '').not.toContain('node-a3')
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

  test('shard switcher renders only when ≥ 2 awaiting_human peers share the same (taskId, intermediaryNodeId)', async () => {
    const session = mkSession({ sourceShardKey: 'shard-A' })
    const peers: ClarifyRoundSummary[] = [
      {
        id: 'sess_a',
        taskId: 'task_a',
        taskName: 'fixture-task',
        kind: 'self',
        askingNodeId: 'designer',
        askingShardKey: 'shard-A',
        intermediaryNodeId: 'c1',
        intermediaryNodeRunId: 'nr_clarify',
        targetConsumerNodeId: null,
        loopIter: 0,
        iteration: 0,
        questionCount: 1,
        status: 'awaiting_human',
        directive: null,
        createdAt: 0,
        answeredAt: null,
      },
      {
        id: 'sess_b',
        taskId: 'task_a',
        taskName: 'fixture-task',
        kind: 'self',
        askingNodeId: 'designer',
        askingShardKey: 'shard-B',
        intermediaryNodeId: 'c1',
        intermediaryNodeRunId: 'nr_clarify_b',
        targetConsumerNodeId: null,
        loopIter: 0,
        iteration: 0,
        questionCount: 1,
        status: 'awaiting_human',
        directive: null,
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

  test('peer lookup failure stays visible and can be retried without hiding the loaded round', async () => {
    const session = mkSession({ sourceShardKey: 'shard-A' })
    let peerAttempts = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
      const s = typeof url === 'string' ? url : url.toString()
      if (s.includes(`/api/clarify/${session.intermediaryNodeRunId}`) && !s.endsWith('/answers')) {
        return new Response(JSON.stringify(session), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (s.includes('/api/clarify?')) {
        peerAttempts += 1
        if (peerAttempts === 1) {
          return new Response(JSON.stringify({ error: 'peer lookup unavailable' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    renderRoute()

    await waitFor(() => expect(screen.getByTestId('clarify-context-card')).toBeTruthy())
    await waitFor(() => expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy())
    expect(screen.getByText('Pick DB')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /retry/i }))

    await waitFor(() => expect(screen.queryByRole('button', { name: /retry/i })).toBeNull())
    expect(peerAttempts).toBe(2)
    expect(screen.getByText('Pick DB')).toBeTruthy()
  })

  test('source-level grep: shard_key field name survives in clarify.detail.tsx', () => {
    // RFC-058: `sourceShardKey` → `askingShardKey` (renamed on the unified
    // ClarifyRound shape). The user-facing DOM shard testids are unchanged.
    const src = readFileSync(join(__dirname, '..', 'src', 'routes', 'clarify.detail.tsx'), 'utf8')
    expect(src).toContain('askingShardKey')
  })

  // RFC-037 follow-up: H1 reads "{taskName} / {clarifyNodeTitle || clarifyNodeId}"
  // — the same pattern reviews.detail.tsx uses, so the two pages are visually
  // interchangeable. Test the title path; the taskName mock is intentionally
  // left undefined so we isolate the node-label branch.
  test('H1 prefers clarifyNodeTitle when present, falls back to clarifyNodeId otherwise', async () => {
    // With title.
    mockApi(mkSession({ clarifyNodeTitle: 'Ask user about the DB' }))
    const { unmount } = renderRoute()
    await waitFor(() => screen.getByTestId('clarify-context-card'))
    expect(document.querySelector('h1')?.textContent ?? '').toContain('Ask user about the DB')
    unmount()
    vi.restoreAllMocks()

    // Without title — H1 keeps the id so it's never empty.
    mockApi(mkSession({ clarifyNodeTitle: null }))
    renderRoute()
    await waitFor(() => screen.getByTestId('clarify-context-card'))
    const heading = document.querySelector('h1')?.textContent ?? ''
    expect(heading).toContain('c1')
    expect(heading).not.toContain('Ask user about the DB')
  })
})

// Reviewer keyboard ergonomics: once the form is loaded, digit / Enter
// keystrokes should hop between questions without a mouse click; the last
// question's "advance" should land focus on the submit button so a final
// Enter actually submits. These tests pin the page-level wiring (parent
// route → QuestionForm refs + advanceFromQuestion + initial focus).
describe('/clarify/$nodeRunId reviewer keyboard nav', () => {
  function twoQuestionSession(): ClarifyRound {
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
    // RFC-023 directive iteration: the primary "submit & keep clarifying"
    // button absorbs Enter from the last question (continue is the default).
    expect(document.activeElement).toBe(screen.getByTestId('clarify-submit-continue'))
  })

  test('keyboard hint is rendered for awaiting_human sessions', async () => {
    mockApi(twoQuestionSession())
    renderRoute()
    await waitFor(() => screen.getByTestId('clarify-keyboard-hint'))
  })
})

// RFC-023 directive iteration: the footer renders TWO buttons. Each one POSTs
// /answers with the matching directive so the runtime can either keep the
// clarify channel open ('continue') or suppress the <workflow-clarify>
// protocol block for the source agent's next rerun ('stop'). Locks the
// wire format the backend now consumes — renaming the POST field would be a
// silent contract break with deployed clients.
describe('/clarify/$nodeRunId directive submit buttons (RFC-023 iter)', () => {
  test('continue button POSTs directive="continue"; stop button POSTs directive="stop"', async () => {
    const session = mkSession()
    let capturedPosts: Array<Record<string, unknown>> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const s = typeof url === 'string' ? url : url.toString()
        if (s.includes(`/api/clarify/${session.intermediaryNodeRunId}`) && s.endsWith('/answers')) {
          const body =
            typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
          capturedPosts.push(body)
          return new Response(
            JSON.stringify({
              ok: true,
              session: { ...session, status: 'answered' },
              rerunNodeRunId: 'nr_rerun',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (s.includes(`/api/clarify/${session.intermediaryNodeRunId}`)) {
          return new Response(JSON.stringify(session), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    )
    // First render: click continue.
    const { unmount } = renderRoute()
    await waitFor(() => screen.getByTestId('clarify-submit-continue'))
    fireEvent.click(screen.getByTestId('clarify-submit-continue'))
    await waitFor(() => expect(capturedPosts.length).toBe(1))
    expect(capturedPosts[0]?.directive).toBe('continue')
    unmount()

    // Second render: click stop → confirm in the unified stop modal.
    // 2026-05-26: self- and cross-clarify share one confirm-modal flow now
    // (testid `clarify-stop-modal`); a bare stop click only opens the
    // modal, the directive does not fire until Confirm.
    capturedPosts = []
    renderRoute()
    await waitFor(() => screen.getByTestId('clarify-submit-stop'))
    fireEvent.click(screen.getByTestId('clarify-submit-stop'))
    await waitFor(() => screen.getByTestId('clarify-stop-modal'))
    expect(capturedPosts.length).toBe(0)
    fireEvent.click(screen.getByTestId('clarify-stop-confirm'))
    await waitFor(() => expect(capturedPosts.length).toBe(1))
    expect(capturedPosts[0]?.directive).toBe('stop')
  })

  test('both buttons render with the i18n-keyed labels and continue is the primary action', async () => {
    mockApi(mkSession())
    renderRoute()
    await waitFor(() => screen.getByTestId('clarify-submit-continue'))
    const cont = screen.getByTestId('clarify-submit-continue')
    const stop = screen.getByTestId('clarify-submit-stop')
    // Primary vs ghost — visual ranking encodes "continue is default".
    expect(cont.className).toContain('btn--primary')
    expect(stop.className).toContain('btn--ghost')
    // Both carry their directive in a data-attribute the e2e layer can grep.
    expect(cont.getAttribute('data-directive')).toBe('continue')
    expect(stop.getAttribute('data-directive')).toBe('stop')
  })
})
