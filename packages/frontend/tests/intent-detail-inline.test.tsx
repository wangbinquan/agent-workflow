// RFC-234 (T8) — /intent/$sessionId locks:
//   1. Pending questions render as native radio/checkbox choices; submit POSTs answers.
//   2. A draft with blocking errors disables commit; a stale draft shows the
//      rebase notice and disables commit.
//   3. A clean draft opens the commit dialog; secret slots gate the submit;
//      the commit POST carries {clientMutationId, draftRevision, draftHash,
//      decisions[slots]} — the server-issued-slot contract end to end.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router'
import type { IntentSessionDetail } from '@agent-workflow/shared'
import { deriveIntentJourneyState } from '../src/components/intent/IntentJourneyProgress'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { enUS } from '../src/i18n/en-US'
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

function detailFixture(overrides: Partial<IntentSessionDetail> = {}): IntentSessionDetail {
  return {
    session: {
      id: 'S1',
      title: 'audit pipeline',
      status: 'active',
      contextRevision: 0,
      turnSeq: 2,
      commitSeq: 0,
      inFlight: false,
      currentDraftRevision: null,
      createdAt: 1,
      updatedAt: Date.now(),
    },
    mounts: [],
    turns: [
      {
        id: 'T1',
        seq: 1,
        role: 'user',
        kind: 'message',
        content: { message: 'build it' },
        contextRevision: 0,
        runMeta: null,
        execution: null,
        createdAt: 1,
      },
    ],
    currentDraft: null,
    commits: [],
    ...overrides,
  }
}

const CLEAN_DRAFT: NonNullable<IntentSessionDetail['currentDraft']> = {
  id: 'D1',
  revision: 3,
  changeset: {
    $schema_version: 1,
    ops: [
      {
        opId: 'op-1',
        action: 'create',
        resourceType: 'mcp',
        tempRef: '$new:gh',
        payload: { type: 'local', name: 'gh', description: '', config: { command: ['npx'] } },
      },
    ],
  },
  validation: { errors: [], credentialFindings: [] },
  slots: [
    {
      kind: 'secret',
      slotId: 'secret:op-1:/config/env/TOKEN',
      opId: 'op-1',
      jsonPointer: '/config/env/TOKEN',
    },
    { kind: 'finalName', slotId: 'name:op-1', opId: 'op-1' },
  ],
  draftHash: `sha256:${'a'.repeat(64)}`,
  contextRevision: 0,
  stale: false,
  createdAt: 2,
}

interface Recorded {
  calls: Array<{ url: string; method: string; body: unknown }>
}

function installFetch(detail: IntentSessionDetail): Recorded {
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
      if (url.includes('/commit')) {
        return json({ journalId: 'J1', commitSeq: 1, applied: [] })
      }
      if (method === 'POST') return json({ turnId: 'T9' })
      return json(detail)
    },
  )
  return rec
}

async function renderPage(opts: { staleTime?: number } = {}) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        ...(opts.staleTime === undefined ? {} : { staleTime: opts.staleTime }),
      },
    },
  })
  const mod = await import('../src/routes/intent.detail')
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/intent/$sessionId',
    component: mod.Route.options.component,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([detailRoute]),
    history: createMemoryHistory({ initialEntries: ['/intent/S1'] }),
  })
  render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
  return qc
}

describe('RFC-234 /intent/$sessionId', () => {
  test('latest running turn stays open when capture truncates and loads the shared renderer', async () => {
    const detail = detailFixture({
      session: {
        ...detailFixture().session,
        inFlight: true,
        turnSeq: 2,
      },
      turns: [
        {
          id: 'T1',
          seq: 1,
          role: 'user',
          kind: 'message',
          content: { message: 'build it' },
          contextRevision: 0,
          runMeta: null,
          execution: null,
          createdAt: 1,
        },
        {
          id: 'T2',
          seq: 2,
          role: 'agent',
          kind: 'running',
          content: {},
          contextRevision: 0,
          runMeta: null,
          execution: {
            captureState: 'truncated',
            lastEventSeq: 1,
            eventBytes: 128,
            rootSessionId: 'runtime-root',
            incompleteReason: null,
          },
          createdAt: 2,
        },
      ],
    })
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (req: RequestInfo | URL) => {
      const url = req.toString()
      calls.push(url)
      const payload = url.includes('/turns/T2/session')
        ? {
            tree: {
              sessionId: 'runtime-root',
              parentSessionId: null,
              agentName: 'aw-intent-builder',
              captureComplete: true,
              messages: [
                {
                  kind: 'assistant-text',
                  text: 'Inspecting the mounted workflow',
                  ts: 2,
                  messageId: 'M1',
                },
              ],
            },
          }
        : detail
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    await renderPage()
    await screen.findByText('Inspecting the mounted workflow')
    expect(screen.getByTestId('intent-turn-session-T2')).toBeTruthy()
    expect(screen.getByText(enUS.intent.executionTruncatedNotice)).toBeTruthy()
    expect(calls.some((url) => url.includes('/turns/T2/session'))).toBe(true)
  })

  test('terminal detail cursor forces one final Session refetch without WebSocket', async () => {
    const runningTurn: IntentSessionDetail['turns'][number] = {
      id: 'T2',
      seq: 2,
      role: 'agent',
      kind: 'running',
      content: {},
      contextRevision: 0,
      runMeta: null,
      execution: {
        captureState: 'live',
        lastEventSeq: 1,
        eventBytes: 64,
        rootSessionId: 'runtime-root',
        incompleteReason: null,
      },
      createdAt: 2,
    }
    let currentDetail = detailFixture({
      session: { ...detailFixture().session, inFlight: true, turnSeq: 2 },
      turns: [detailFixture().turns[0]!, runningTurn],
    })
    let sessionCalls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (req: RequestInfo | URL) => {
      const url = req.toString()
      const payload = url.includes('/turns/T2/session')
        ? {
            tree: {
              sessionId: 'runtime-root',
              parentSessionId: null,
              agentName: 'aw-intent-builder',
              captureComplete: sessionCalls > 0,
              messages:
                sessionCalls++ === 0
                  ? [
                      {
                        kind: 'assistant-text',
                        text: 'first evidence',
                        ts: 2,
                        messageId: 'M1',
                      },
                    ]
                  : [
                      {
                        kind: 'assistant-text',
                        text: 'first evidence',
                        ts: 2,
                        messageId: 'M1',
                      },
                      {
                        kind: 'assistant-text',
                        text: 'final evidence',
                        ts: 3,
                        messageId: 'M2',
                      },
                    ],
            },
          }
        : currentDetail
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const qc = await renderPage()
    await screen.findByText('first evidence')
    expect(screen.queryByText('final evidence')).toBeNull()

    currentDetail = detailFixture({
      session: { ...currentDetail.session, inFlight: false },
      turns: [
        currentDetail.turns[0]!,
        {
          ...runningTurn,
          kind: 'changeset',
          content: { summary: 'done', opCount: 1 },
          execution: {
            ...runningTurn.execution!,
            captureState: 'complete',
            lastEventSeq: 2,
            eventBytes: 128,
          },
        },
      ],
    })
    await qc.refetchQueries({
      queryKey: ['intent-sessions', 'detail', 'S1'],
      exact: true,
    })

    await screen.findByText('final evidence')
    expect(sessionCalls).toBeGreaterThanOrEqual(2)
  })

  test('reopening a terminal Session bypasses fresh cache and fetches final evidence', async () => {
    const runningTurn: IntentSessionDetail['turns'][number] = {
      id: 'T2',
      seq: 2,
      role: 'agent',
      kind: 'running',
      content: {},
      contextRevision: 0,
      runMeta: null,
      execution: {
        captureState: 'live',
        lastEventSeq: 1,
        eventBytes: 64,
        rootSessionId: 'runtime-root',
        incompleteReason: null,
      },
      createdAt: 2,
    }
    let currentDetail = detailFixture({
      session: { ...detailFixture().session, inFlight: true, turnSeq: 2 },
      turns: [detailFixture().turns[0]!, runningTurn],
    })
    let sessionCalls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (req: RequestInfo | URL) => {
      const url = req.toString()
      const payload = url.includes('/turns/T2/session')
        ? {
            tree: {
              sessionId: 'runtime-root',
              parentSessionId: null,
              agentName: 'aw-intent-builder',
              captureComplete: !currentDetail.session.inFlight,
              messages: [
                {
                  kind: 'assistant-text',
                  text: 'cached evidence',
                  ts: 2,
                  messageId: 'M1',
                },
                ...(!currentDetail.session.inFlight
                  ? [
                      {
                        kind: 'assistant-text' as const,
                        text: 'evidence after reopen',
                        ts: 3,
                        messageId: 'M2',
                      },
                    ]
                  : []),
              ],
            },
          }
        : currentDetail
      if (url.includes('/turns/T2/session')) sessionCalls++
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const qc = await renderPage({ staleTime: 5_000 })
    await screen.findByText('cached evidence')
    fireEvent.click(screen.getByRole('button', { name: /Execution/ }))

    currentDetail = detailFixture({
      session: { ...currentDetail.session, inFlight: false },
      turns: [
        currentDetail.turns[0]!,
        {
          ...runningTurn,
          kind: 'changeset',
          content: { summary: 'done', opCount: 1 },
          execution: {
            ...runningTurn.execution!,
            captureState: 'complete',
            lastEventSeq: 2,
            eventBytes: 128,
          },
        },
      ],
    })
    await qc.refetchQueries({
      queryKey: ['intent-sessions', 'detail', 'S1'],
      exact: true,
    })
    expect(screen.queryByText('evidence after reopen')).toBeNull()

    const callsBeforeReopen = sessionCalls
    fireEvent.click(screen.getByRole('button', { name: /Execution/ }))
    await screen.findByText('evidence after reopen')
    expect(sessionCalls).toBeGreaterThan(callsBeforeReopen)
  })

  test('journey ignores a failed commit that belongs to an older draft', () => {
    const currentDraft = { ...CLEAN_DRAFT, id: 'D2' }
    const oldFailure = {
      journalId: 'J1',
      draftId: 'D1',
      state: 'failed' as const,
      receipt: null,
      error: 'old failure',
      createdAt: 3,
    }
    expect(
      deriveIntentJourneyState(detailFixture({ currentDraft, commits: [oldFailure] })).kind,
    ).toBe('review-ready')
    expect(
      deriveIntentJourneyState(
        detailFixture({
          currentDraft,
          commits: [{ ...oldFailure, draftId: currentDraft.id }],
        }),
      ).kind,
    ).toBe('error')
  })

  test('groups the build flow before the dedicated draft review workspace', async () => {
    installFetch(detailFixture({ currentDraft: CLEAN_DRAFT }))
    await renderPage()

    const buildWorkspace = await screen.findByTestId('intent-build-workspace')
    const reviewWorkspace = screen.getByTestId('intent-review-workspace')

    expect(buildWorkspace.tagName).toBe('SECTION')
    expect(buildWorkspace.getAttribute('aria-labelledby')).toBe('intent-conversation-heading')
    expect(
      within(buildWorkspace).getByRole('heading', {
        name: enUS.intent.timeline,
        level: 2,
      }),
    ).toBeTruthy()
    expect(within(buildWorkspace).getByTestId('intent-composer')).toBeTruthy()
    expect(within(reviewWorkspace).getByTestId('intent-draft')).toBeTruthy()
    expect(
      buildWorkspace.compareDocumentPosition(reviewWorkspace) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0)
  })

  test('pending questions answer via segmented choices and POST', async () => {
    const rec = installFetch(
      detailFixture({
        turns: [
          {
            id: 'T1',
            seq: 1,
            role: 'user',
            kind: 'message',
            content: { message: 'build it' },
            contextRevision: 0,
            runMeta: null,
            execution: null,
            createdAt: 1,
          },
          {
            id: 'T2',
            seq: 2,
            role: 'agent',
            kind: 'questions',
            content: {
              summary: 'need info',
              questions: [
                {
                  id: 'q1',
                  question: 'which sharding?',
                  options: ['per-file', 'per-dir'],
                  multiSelect: false,
                },
              ],
            },
            contextRevision: 0,
            runMeta: null,
            execution: null,
            createdAt: 2,
          },
        ],
      }),
    )
    await renderPage()
    await screen.findByTestId('intent-questions')
    const submit = screen.getByRole('button', { name: enUS.intent.submitAnswers })
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getAllByText('per-file')[0]!)
    expect((submit as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(submit)
    await waitFor(() => {
      const post = rec.calls.find((call) => call.url.includes('/answers'))
      expect(post?.body).toEqual({ answers: [{ id: 'q1', picked: ['per-file'] }] })
    })
  })

  test('blocking errors and staleness both disable commit', async () => {
    installFetch(
      detailFixture({
        currentDraft: {
          ...CLEAN_DRAFT,
          validation: {
            errors: ['op-1: unknown target handle res#workflow#9'],
            credentialFindings: [],
          },
        },
      }),
    )
    await renderPage()
    const open = await screen.findByTestId('intent-open-commit')
    expect((open as HTMLButtonElement).disabled).toBe(true)
    cleanup()

    installFetch(detailFixture({ currentDraft: { ...CLEAN_DRAFT, stale: true } }))
    await renderPage()
    const open2 = await screen.findByTestId('intent-open-commit')
    expect((open2 as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(enUS.intent.draftStaleNotice)).toBeTruthy()
  })

  test('add-mount dialog picks a resource and POSTs the mount ref', async () => {
    const rec: Recorded = { calls: [] }
    const detail = detailFixture()
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
        if (url.includes('/api/agents')) return json([{ id: 'A1', name: 'auditor' }])
        if (url.includes('/api/users')) return json([])
        if (method === 'POST') return json({ handle: 'res#agent#1', contextRevision: 0 })
        return json(detail)
      },
    )
    await renderPage()
    fireEvent.click(await screen.findByTestId('intent-add-mount'))
    const input = await screen.findByTestId('intent-mount-picker')
    fireEvent.focus(input)
    // MultiSelect toggles options on mouseDown (not click) so the input keeps focus.
    fireEvent.mouseDown(await screen.findByText('auditor'))
    const submit = screen.getByTestId('intent-mount-submit')
    expect((submit as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(submit)
    await waitFor(() => {
      const post = rec.calls.find((call) => call.url.includes('/mounts') && call.method === 'POST')
      expect(post?.body).toEqual({ resourceType: 'agent', resourceId: 'A1' })
    })
  })

  test('clean draft commits through server-issued slots', async () => {
    const rec = installFetch(detailFixture({ currentDraft: CLEAN_DRAFT }))
    await renderPage()
    fireEvent.click(await screen.findByTestId('intent-open-commit'))
    const submit = await screen.findByTestId('intent-commit-submit')
    // secret slot unfilled → gated
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    const secretInput = screen.getByPlaceholderText(enUS.intent.secretPlaceholder)
    fireEvent.change(secretInput, { target: { value: 'real-secret-value' } })
    expect((submit as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(submit)
    await waitFor(() => {
      const post = rec.calls.find((call) => call.url.includes('/commit'))
      expect(post).toBeTruthy()
      const body = post?.body as {
        clientMutationId: string
        draftRevision: number
        draftHash: string
        decisions: Array<{ opId: string; slots?: Array<{ slotId: string; value: string }> }>
      }
      expect(body.draftRevision).toBe(3)
      expect(body.draftHash).toBe(CLEAN_DRAFT.draftHash)
      expect(body.clientMutationId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
      expect(body.decisions).toEqual([
        {
          opId: 'op-1',
          slots: [{ slotId: 'secret:op-1:/config/env/TOKEN', value: 'real-secret-value' }],
        },
      ])
    })
  })
})
