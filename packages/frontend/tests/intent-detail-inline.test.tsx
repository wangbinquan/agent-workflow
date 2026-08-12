// RFC-234 (T8) — /intent/$sessionId locks:
//   1. Pending questions render as native radio/checkbox choices; submit POSTs answers.
//   2. A draft with blocking errors disables commit; a stale draft shows the
//      rebase notice and disables commit.
//   3. A clean draft opens the commit dialog; secret slots gate the submit;
//      the commit POST carries {clientMutationId, draftRevision, draftHash,
//      decisions[slots]} — the server-issued-slot contract end to end.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  const currentDraft = overrides.currentDraft ?? null
  const impliedJourney: IntentSessionDetail['session']['journey'] =
    currentDraft === null
      ? { kind: 'goal', reason: 'describe-goal', step: 1, completedThrough: 0 }
      : currentDraft.stale
        ? { kind: 'review-blocked', reason: 'draft-stale', step: 3, completedThrough: 2 }
        : currentDraft.validation.errors.length > 0
          ? { kind: 'review-blocked', reason: 'draft-invalid', step: 3, completedThrough: 2 }
          : { kind: 'review-ready', reason: 'review-draft', step: 3, completedThrough: 2 }
  const baseSession: IntentSessionDetail['session'] = {
    id: 'S1',
    title: 'audit pipeline',
    status: 'active',
    contextRevision: 0,
    turnSeq: 2,
    commitSeq: 0,
    inFlight: false,
    currentDraftRevision: currentDraft?.revision ?? null,
    journey: impliedJourney,
    createdAt: 1,
    updatedAt: Date.now(),
  }
  return {
    mounts: [],
    mountSuggestions: null,
    turns: [
      {
        id: 'T1',
        seq: 1,
        role: 'user',
        kind: 'message',
        content: { message: 'build it' },
        contextRevision: 0,
        runMeta: null,
        scratchRetained: false,
        execution: null,
        createdAt: 1,
      },
    ],
    currentDraft,
    commits: [],
    ...overrides,
    session: overrides.session ?? baseSession,
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
  test('archives and reopens from the detail header without a hidden API-only state', async () => {
    const archiveRec = installFetch(detailFixture())
    await renderPage()
    fireEvent.click(await screen.findByRole('button', { name: enUS.intent.archiveAction }))
    await waitFor(() =>
      expect(
        archiveRec.calls.some(
          (call) => call.method === 'POST' && call.url.endsWith('/intent-sessions/S1/archive'),
        ),
      ).toBe(true),
    )
    cleanup()

    const archived = detailFixture({
      session: {
        ...detailFixture().session,
        status: 'archived',
        journey: { kind: 'archived', reason: 'archived', step: 1, completedThrough: 0 },
      },
    })
    const reopenRec = installFetch(archived)
    await renderPage()
    const reopen = await screen.findByRole('button', { name: enUS.intent.reopenAction })
    expect(screen.queryByTestId('intent-add-mount')).toBeNull()
    expect(screen.queryByTestId('intent-composer')).toBeNull()
    fireEvent.click(reopen)
    await waitFor(() =>
      expect(
        reopenRec.calls.some(
          (call) => call.method === 'POST' && call.url.endsWith('/intent-sessions/S1/reopen'),
        ),
      ).toBe(true),
    )
  })

  test('admin audit view keeps the full history but exposes no owner mutation controls', async () => {
    const auditDetail = detailFixture({
      session: {
        ...detailFixture({ currentDraft: CLEAN_DRAFT }).session,
        ownerUserId: 'OTHER-OWNER',
        currentDraftRevision: CLEAN_DRAFT.revision,
        journey: { kind: 'review-ready', reason: 'review-draft', step: 3, completedThrough: 2 },
      },
      mounts: [
        {
          handle: 'res#agent#1',
          resourceType: 'agent',
          resourceId: 'A1',
          displayName: 'auditor',
          detail: true,
        },
      ],
      turns: [
        detailFixture().turns[0]!,
        {
          id: 'T2',
          seq: 2,
          role: 'agent',
          kind: 'error',
          content: { code: 'intent-envelope-missing', reason: 'runtime-shape-unknown' },
          contextRevision: 0,
          runMeta: null,
          scratchRetained: false,
          execution: null,
          createdAt: 2,
        },
      ],
      currentDraft: CLEAN_DRAFT,
    })
    installFetch(auditDetail)
    await renderPage()

    expect(await screen.findByText(enUS.intent.auditReadOnly)).toBeTruthy()
    expect(screen.getByText('build it')).toBeTruthy()
    expect(screen.getByTestId('intent-draft')).toBeTruthy()
    expect(screen.queryByRole('button', { name: enUS.intent.archiveAction })).toBeNull()
    expect(screen.queryByRole('button', { name: enUS.intent.retryTurn })).toBeNull()
    expect(screen.queryByRole('button', { name: enUS.intent.unmount })).toBeNull()
    expect(screen.queryByTestId('intent-add-mount')).toBeNull()
    expect(screen.queryByTestId('intent-open-commit')).toBeNull()
    expect(screen.queryByTestId('intent-composer')).toBeNull()
  })

  test('RFC-273 error card explains missing-envelope evidence and retained scratch', async () => {
    const detail = detailFixture({
      turns: [
        detailFixture().turns[0]!,
        {
          id: 'T2',
          seq: 2,
          role: 'agent',
          kind: 'error',
          content: { code: 'intent-envelope-missing', reason: 'no-assistant-text' },
          contextRevision: 0,
          runMeta: {
            scratchRetentionHours: 24,
            outputEvidence: {
              assistantTextSeen: false,
              observedAssistantTextBytes: 0,
              retainedAssistantTextBytes: 0,
              eventTextCapHit: false,
              unparsedStdoutSeen: false,
              lastNormalizedEventKind: 'step_start',
              lastRuntimeEventType: 'system',
              terminalResult: 'not-observed',
            },
          },
          scratchRetained: true,
          execution: null,
          createdAt: 2,
        },
      ],
    })
    installFetch(detail)
    await renderPage()

    const diagnostic = await screen.findByTestId('intent-turn-error-diagnostic')
    expect(diagnostic.textContent).toContain(
      enUS.intent.failureDiagnostic.reason['no-assistant-text'].title,
    )
    expect(diagnostic.textContent).toContain('0 B')
    expect(diagnostic.textContent).toContain('24')
    expect(within(diagnostic).getByRole('button', { name: enUS.intent.retryTurn })).toBeTruthy()
  })

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
          scratchRetained: false,
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
          scratchRetained: false,
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
      scratchRetained: false,
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
      scratchRetained: false,
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

  test('journey consumes the server-owned projection for old and current draft failures', () => {
    const currentDraft = { ...CLEAN_DRAFT, id: 'D2' }
    const oldFailure = {
      journalId: 'J1',
      draftId: 'D1',
      state: 'failed' as const,
      receipt: null,
      error: 'old failure',
      createdAt: 3,
    }
    const oldDraftFailure = detailFixture({ currentDraft, commits: [oldFailure] })
    expect(deriveIntentJourneyState(oldDraftFailure).kind).toBe('review-ready')
    const currentDraftFailure = detailFixture({
      currentDraft,
      commits: [{ ...oldFailure, draftId: currentDraft.id }],
      session: {
        ...oldDraftFailure.session,
        journey: { kind: 'error', reason: 'apply-failed', step: 4, completedThrough: 3 },
      },
    })
    expect(deriveIntentJourneyState(currentDraftFailure).kind).toBe('error')
  })

  test('renders answers and mount decisions semantically instead of exposing stored JSON', async () => {
    const base = detailFixture()
    installFetch(
      detailFixture({
        session: { ...base.session, turnSeq: 4 },
        turns: [
          base.turns[0]!,
          {
            id: 'T2',
            seq: 2,
            role: 'agent',
            kind: 'questions',
            content: {
              summary: 'Need one choice',
              questions: [
                {
                  id: 'q1',
                  question: 'How should files be audited?',
                  options: ['per-file', 'all-at-once'],
                  multiSelect: false,
                },
              ],
            },
            contextRevision: 0,
            runMeta: null,
            scratchRetained: false,
            execution: null,
            createdAt: 2,
          },
          {
            id: 'T3',
            seq: 3,
            role: 'user',
            kind: 'answers',
            content: { answers: [{ id: 'q1', picked: ['per-file'] }] },
            contextRevision: 0,
            runMeta: null,
            scratchRetained: false,
            execution: null,
            createdAt: 3,
          },
          {
            id: 'T4',
            seq: 4,
            role: 'user',
            kind: 'mount-approval',
            content: {
              sourceTurnId: 'T2',
              sourceTurnSeq: 2,
              approvalTurnId: 'T4',
              approvalTurnSeq: 4,
              resultingContextRevision: 1,
              approved: [
                {
                  resourceType: 'agent',
                  name: 'security-auditor',
                  resourceId: 'A1',
                  handle: 'res#agent#1',
                },
              ],
              rejected: [{ resourceType: 'workflow', name: 'legacy-flow' }],
            },
            contextRevision: 1,
            runMeta: null,
            scratchRetained: false,
            execution: null,
            createdAt: 4,
          },
        ],
      }),
    )
    await renderPage()

    const answersTurn = await screen.findByTestId('intent-turn-answers')
    expect(answersTurn.textContent).toContain('How should files be audited?')
    expect(answersTurn.textContent).toContain('per-file')
    expect(answersTurn.querySelector('pre')).toBeNull()
    const approvalTurn = screen.getByTestId('intent-turn-mount-approval')
    expect(approvalTurn.textContent).toContain(enUS.intent.mountApproved)
    expect(approvalTurn.textContent).toContain('security-auditor')
    expect(approvalTurn.textContent).toContain(enUS.intent.mountRejected)
    expect(approvalTurn.textContent).toContain('legacy-flow')
  })

  test('applies every pending mount suggestion in one source-bound request', async () => {
    const base = detailFixture()
    const detail = detailFixture({
      session: { ...base.session, turnSeq: 5, contextRevision: 2 },
      mountSuggestions: {
        sourceTurnId: 'T5',
        sourceTurnSeq: 5,
        contextRevision: 2,
        items: [
          {
            resourceType: 'agent',
            name: 'auditor',
            reason: 'required reviewer',
            candidates: [
              { resourceId: 'A1', name: 'auditor', description: 'Audits one file at a time' },
            ],
          },
          {
            resourceType: 'workflow',
            name: 'missing-flow',
            reason: null,
            candidates: [],
          },
        ],
      },
    })
    const calls: Array<{ url: string; method: string; body: unknown }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (req: RequestInfo | URL, init?: RequestInit) => {
        const url = req.toString()
        const method = (init?.method ?? 'GET').toUpperCase()
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
        calls.push({ url, method, body })
        const payload =
          method === 'POST'
            ? {
                sourceTurnId: 'T5',
                sourceTurnSeq: 5,
                approvalTurnId: 'T6',
                approvalTurnSeq: 6,
                resultingContextRevision: 3,
                approved: [
                  {
                    resourceType: 'agent',
                    name: 'auditor',
                    resourceId: 'A1',
                    handle: 'res#agent#1',
                  },
                ],
                rejected: [{ resourceType: 'workflow', name: 'missing-flow' }],
              }
            : detail
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    )
    await renderPage()

    const submit = await screen.findByRole('button', { name: enUS.intent.mountDecisionSubmit })
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false))
    fireEvent.change(screen.getByTestId('intent-composer'), {
      target: { value: 'continue anyway' },
    })
    expect(
      (screen.getByRole('button', { name: enUS.intent.send }) as HTMLButtonElement).disabled,
    ).toBe(true)
    fireEvent.click(submit)
    await waitFor(() => {
      const post = calls.find(
        (call) => call.method === 'POST' && call.url.includes('/mount-approvals'),
      )
      expect(post?.body).toEqual({
        sourceTurnId: 'T5',
        expectedTurnSeq: 5,
        expectedContextRevision: 2,
        decisions: [
          {
            resourceType: 'agent',
            name: 'auditor',
            action: 'approve',
            resourceId: 'A1',
          },
          { resourceType: 'workflow', name: 'missing-flow', action: 'reject' },
        ],
      })
    })
  })

  test('chooses Review once per session, then preserves the user mobile-tab choice on refresh', async () => {
    installFetch(detailFixture({ currentDraft: CLEAN_DRAFT }))
    const qc = await renderPage()
    const build = await screen.findByTestId('intent-build-workspace')
    const review = screen.getByTestId('intent-review-workspace')
    await waitFor(() => expect(review.getAttribute('data-mobile-active')).toBe('true'))
    expect(build.getAttribute('data-mobile-active')).toBe('false')

    fireEvent.click(screen.getByRole('tab', { name: enUS.intent.buildWorkspace }))
    expect(build.getAttribute('data-mobile-active')).toBe('true')
    await qc.refetchQueries({ queryKey: ['intent-sessions', 'detail', 'S1'], exact: true })
    expect(build.getAttribute('data-mobile-active')).toBe('true')
    expect(review.getAttribute('data-mobile-active')).toBe('false')
  })

  test('keeps a large draft lightweight by mounting only the selected operation preview', async () => {
    const changeset = CLEAN_DRAFT.changeset as { $schema_version: 1; ops: unknown[] }
    const draft = {
      ...CLEAN_DRAFT,
      changeset: {
        ...changeset,
        ops: [
          ...changeset.ops,
          {
            opId: 'op-2',
            action: 'create',
            resourceType: 'mcp',
            tempRef: '$new:gitlab',
            payload: {
              type: 'local',
              name: 'gitlab',
              description: '',
              config: { command: ['bunx'] },
            },
          },
        ],
      },
    }
    installFetch(detailFixture({ currentDraft: draft }))
    await renderPage()

    const outline = await screen.findAllByTestId('intent-op-outline-item')
    expect(outline).toHaveLength(2)
    expect(screen.getAllByTestId('intent-op-card')).toHaveLength(1)
    fireEvent.click(within(outline[1]!).getByText('gitlab'))
    expect(screen.getAllByTestId('intent-op-card')).toHaveLength(1)
    expect(screen.getByTestId('intent-op-card').textContent).toContain('gitlab')
  })

  test('groups the build flow before the dedicated draft review workspace', async () => {
    installFetch(detailFixture({ currentDraft: CLEAN_DRAFT }))
    await renderPage()

    const buildWorkspace = await screen.findByTestId('intent-build-workspace')
    const journey = screen.getByRole('region', {
      name: enUS.intent.journey.ariaLabel,
    })
    const reviewWorkspace = screen.getByTestId('intent-review-workspace')

    expect(within(journey).getAllByRole('listitem')).toHaveLength(4)
    expect(journey.querySelector('[aria-current="step"]')?.textContent).toContain(
      enUS.intent.journey.review,
    )
    expect(screen.getByTestId('intent-journey-state').textContent).toContain('Step 3 of 4')
    expect(screen.getByTestId('intent-journey-state').textContent).toContain(
      enUS.intent.journey.reason['review-draft'],
    )
    expect(screen.queryByTestId('intent-stage-status')).toBeNull()
    expect(screen.queryByText('Active')).toBeNull()
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
            scratchRetained: false,
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
            scratchRetained: false,
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
    fireEvent.click(await screen.findByTestId('intent-commit-next'))
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('intent-commit-step-heading')),
    )
    expect(screen.getByTestId('intent-commit-step-heading').textContent).toBe(
      enUS.intent.commitStep.details,
    )
    const next = await screen.findByTestId('intent-commit-next')
    // secret slot unfilled → gated
    expect((next as HTMLButtonElement).disabled).toBe(true)
    const secretInput = screen.getByPlaceholderText(enUS.intent.secretPlaceholder)
    fireEvent.change(secretInput, { target: { value: 'real-secret-value' } })
    expect((next as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(next)
    const submit = await screen.findByTestId('intent-commit-submit')
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

  test('labels commit decisions with resource names instead of raw operation ids', async () => {
    const changeset = CLEAN_DRAFT.changeset as { $schema_version: 1; ops: unknown[] }
    const readableDraft: NonNullable<IntentSessionDetail['currentDraft']> = {
      ...CLEAN_DRAFT,
      id: 'D-readable-operation-labels',
      changeset: {
        ...changeset,
        ops: [
          ...changeset.ops,
          {
            opId: 'op-2',
            action: 'update',
            resourceType: 'mcp',
            target: 'res#mcp#1',
            payload: {
              type: 'local',
              name: 'gitlab',
              description: '',
              config: { command: ['bunx'] },
            },
          },
        ],
      },
      slots: [
        ...CLEAN_DRAFT.slots,
        {
          kind: 'secretWaiver',
          slotId: 'waiver:op-2:/op-2/payload/name',
          opId: 'op-2',
          jsonPointer: '/op-2/payload/name',
        },
        { kind: 'finalName', slotId: 'name:op-2', opId: 'op-2' },
      ],
    }
    installFetch(detailFixture({ currentDraft: readableDraft }))
    await renderPage()
    fireEvent.click(await screen.findByTestId('intent-open-commit'))

    const dialog = await screen.findByRole('dialog')
    const strategyLabels = [...dialog.querySelectorAll('.form-field__label')].map(
      (label) => label.textContent,
    )
    expect(strategyLabels).toContain('gitlab · MCP')
    expect(
      within(dialog).getByRole('radiogroup', {
        name: `gitlab · MCP · ${enUS.intent.applyModeTitle}`,
      }),
    ).toBeTruthy()
    expect(dialog.textContent).not.toContain('op-2')

    fireEvent.click(within(dialog).getByTestId('intent-commit-next'))
    const detailLabels = [...dialog.querySelectorAll('.form-field__label')].map(
      (label) => label.textContent,
    )
    expect(detailLabels).toContain('gh · MCP · /config/env/TOKEN *')
    expect(detailLabels).toContain('gh · MCP')
    expect(detailLabels).toContain('gitlab · MCP')
    expect(dialog.textContent).not.toContain('op-1')
    expect(dialog.textContent).not.toContain('op-2')
    expect(dialog.textContent).toContain('/name')

    fireEvent.change(within(dialog).getByPlaceholderText(enUS.intent.secretPlaceholder), {
      target: { value: 'real-secret-value' },
    })
    fireEvent.click(within(dialog).getByRole('checkbox'))
    fireEvent.click(within(dialog).getByTestId('intent-commit-next'))
    const review = await within(dialog).findByTestId('intent-commit-review')
    expect(review.textContent).toContain('gitlab · MCP')
    expect(review.textContent).toContain('gh · MCP')
    expect(review.textContent).toContain('op-1')
    expect(review.textContent).toContain('op-2')
  })

  test('closes commit review when a refetch replaces the draft identity', async () => {
    installFetch(detailFixture({ currentDraft: CLEAN_DRAFT }))
    const qc = await renderPage({ staleTime: Number.POSITIVE_INFINITY })
    fireEvent.click(await screen.findByTestId('intent-open-commit'))
    expect(await screen.findByText(enUS.intent.commitTitle)).toBeTruthy()

    const replacementDraft: NonNullable<IntentSessionDetail['currentDraft']> = {
      ...CLEAN_DRAFT,
      id: 'D2',
      revision: 4,
      draftHash: `sha256:${'b'.repeat(64)}`,
    }
    act(() => {
      qc.setQueryData(
        ['intent-sessions', 'detail', 'S1'],
        detailFixture({ currentDraft: replacementDraft }),
      )
    })
    await waitFor(() => expect(screen.queryByText(enUS.intent.commitTitle)).toBeNull())
  })

  test('details step requires every explicit credential waiver before review', async () => {
    const waiverDraft: NonNullable<IntentSessionDetail['currentDraft']> = {
      ...CLEAN_DRAFT,
      id: 'D-waiver',
      validation: {
        errors: [],
        credentialFindings: [
          {
            opId: 'op-1',
            jsonPointer: '/config/headers/Authorization',
            kind: 'credential-like',
            excerpt: 'Bearer [redacted]',
          },
        ],
      },
      slots: [
        {
          kind: 'secretWaiver',
          slotId: 'waiver:op-1:/config/headers/Authorization',
          opId: 'op-1',
          jsonPointer: '/config/headers/Authorization',
        },
        { kind: 'finalName', slotId: 'name:op-1', opId: 'op-1' },
      ],
    }
    const rec = installFetch(detailFixture({ currentDraft: waiverDraft }))
    await renderPage()
    fireEvent.click(await screen.findByTestId('intent-open-commit'))
    fireEvent.click(await screen.findByTestId('intent-commit-next'))

    const next = await screen.findByTestId('intent-commit-next')
    expect((next as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    expect((next as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(next)

    const review = await screen.findByTestId('intent-commit-review')
    expect(within(review).getByText(enUS.intent.commitDetailProvided)).toBeTruthy()
    expect(within(review).getByText(enUS.intent.commitDetailDefault)).toBeTruthy()
    expect(review.textContent).not.toContain('Bearer')
    fireEvent.click(screen.getByTestId('intent-commit-submit'))
    await waitFor(() => {
      const post = rec.calls.find((call) => call.url.includes('/commit'))
      expect(post?.body).toMatchObject({
        decisions: [
          {
            opId: 'op-1',
            slots: [
              {
                slotId: 'waiver:op-1:/config/headers/Authorization',
                value: 'waived',
              },
            ],
          },
        ],
      })
    })
  })

  test('retries a lost commit response with the same client mutation id', async () => {
    const detail = detailFixture({ currentDraft: CLEAN_DRAFT })
    const commitBodies: Array<{ clientMutationId: string }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (req: RequestInfo | URL, init?: RequestInit) => {
        const url = req.toString()
        const method = (init?.method ?? 'GET').toUpperCase()
        if (url.includes('/commit') && method === 'POST') {
          commitBodies.push(JSON.parse(String(init?.body)) as { clientMutationId: string })
          if (commitBodies.length === 1) {
            return new Response(
              JSON.stringify({ error: { code: 'temporary', message: 'response was lost' } }),
              { status: 503, headers: { 'content-type': 'application/json' } },
            )
          }
          return new Response(JSON.stringify({ journalId: 'J1', commitSeq: 1, applied: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(JSON.stringify(detail), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    )
    await renderPage()
    fireEvent.click(await screen.findByTestId('intent-open-commit'))
    fireEvent.click(await screen.findByTestId('intent-commit-next'))
    fireEvent.change(screen.getByPlaceholderText(enUS.intent.secretPlaceholder), {
      target: { value: 'real-secret-value' },
    })
    fireEvent.click(screen.getByTestId('intent-commit-next'))
    const submit = await screen.findByTestId('intent-commit-submit')
    fireEvent.click(submit)
    await waitFor(() => expect(commitBodies).toHaveLength(1))
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(submit)
    await waitFor(() => expect(commitBodies).toHaveLength(2))
    expect(commitBodies[0]?.clientMutationId).toBe(commitBodies[1]?.clientMutationId)
  })
})
