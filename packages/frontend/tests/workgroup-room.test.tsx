// RFC-164 PR-4/5/6 — WorkgroupRoom contract (the group task's primary view).
//
// Locks:
//   1. Author forms: member (@displayName + leader badge), human (resolved
//      platform display name via /api/users/lookup), system (muted style +
//      localized "System" label).
//   2. Round separators at round transitions (none for the round-0 prelude).
//   3. Dispatch cards: title + assignee + source badge + live status chip;
//      done cards expose the collapsible result block (body from the message
//      the card's resultMessageId points at); "view run" only with nodeRunId
//      and it opens the reused NodeDetailDrawer.
//   4. Cancel: two-click ConfirmButton on open/dispatched cards POSTs the
//      cancel endpoint; terminal cards render no cancel.
//   5. Composer: send POSTs {body}; the roster @-completion appears while
//      typing "@…" and clicking a suggestion commits it; terminal task
//      statuses disable the composer.
//   6. Gate rail (PR-5, live): approve POSTs directly; reject flows through a
//      REQUIRED-comment dialog; 409 gate-not-open maps to friendly copy.
//   7. Human delivery (PR-5 拍板 #16): dispatched human cards render the
//      to-do form with quick-reply {body} and form {summary, detail} shapes.
//   8. fc task-list panel (PR-5) groups open/active/done; config entry (PR-5)
//      opens WorkgroupTaskConfigDialog; decision messages carry the accent
//      modifier (PR-6).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { NodeRun, TaskStatus } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { WorkgroupRoom } from '../src/components/workgroup/WorkgroupRoom'
import type { WorkgroupRoomResponse } from '../src/lib/workgroup-room'
import '../src/i18n'

function makeRun(over: Partial<NodeRun>): NodeRun {
  return {
    id: 'nr1',
    taskId: 't1',
    nodeId: '__wg_member__',
    parentNodeRunId: null,
    iteration: 0,
    shardKey: null,
    retryIndex: 0,
    reviewIteration: 0,
    status: 'done',
    startedAt: 1000,
    finishedAt: 2000,
    pid: null,
    exitCode: 0,
    errorMessage: null,
    supersededByReview: null,
    rolledBack: null,
    promptText: null,
    tokInput: null,
    tokOutput: null,
    tokTotal: null,
    tokCacheCreate: null,
    tokCacheRead: null,
    opencodeSessionId: null,
    ...over,
  } satisfies NodeRun
}

function makeRoom(over: Partial<WorkgroupRoomResponse> = {}): WorkgroupRoomResponse {
  return {
    taskId: 't1',
    taskStatus: 'running',
    config: {
      workgroupId: 'wg1',
      workgroupName: 'review-squad',
      mode: 'leader_worker',
      leaderMemberId: 'mem_lead',
      switches: { shareOutputs: true, directMessages: true, blackboard: false },
      maxRounds: 20,
      completionGate: true,
      instructions: '',
      goal: 'ship the audit',
      members: [
        {
          id: 'mem_lead',
          memberType: 'agent',
          agentName: 'coordinator',
          userId: null,
          displayName: 'Lead',
          roleDesc: 'dispatches',
        },
        {
          id: 'mem_work',
          memberType: 'agent',
          agentName: 'worker',
          userId: null,
          displayName: 'Worker',
          roleDesc: '',
        },
        {
          id: 'mem_alice',
          memberType: 'human',
          agentName: null,
          userId: 'u1',
          displayName: 'Alice',
          roleDesc: '',
        },
      ],
    },
    gate: { declaredDone: false, awaitingConfirmation: false, rejected: false, summary: null },
    dw: null,
    messages: [
      {
        id: '01A',
        round: 0,
        authorKind: 'human',
        authorMemberId: null,
        authorUserId: 'u1',
        kind: 'chat',
        bodyMd: 'kick off please',
        mentionMemberIds: [],
        assignmentId: null,
        createdAt: 1000,
      },
      {
        id: '01B',
        round: 1,
        authorKind: 'member',
        authorMemberId: 'mem_lead',
        authorUserId: null,
        kind: 'dispatch',
        bodyMd: '@Worker audit the diff',
        mentionMemberIds: ['mem_work'],
        assignmentId: 'a1',
        createdAt: 2000,
      },
      {
        id: '01C',
        round: 1,
        authorKind: 'system',
        authorMemberId: null,
        authorUserId: null,
        kind: 'system',
        bodyMd: 'round 1 started',
        mentionMemberIds: [],
        assignmentId: null,
        createdAt: 2100,
      },
      {
        id: '01D',
        round: 2,
        authorKind: 'member',
        authorMemberId: 'mem_work',
        authorUserId: null,
        kind: 'result',
        bodyMd: 'found 3 issues in the diff',
        mentionMemberIds: [],
        assignmentId: 'a1',
        createdAt: 3000,
      },
      {
        id: '01E',
        round: 2,
        authorKind: 'human',
        authorMemberId: null,
        authorUserId: 'u1',
        kind: 'dispatch',
        bodyMd: '@Worker also check the tests',
        mentionMemberIds: ['mem_work'],
        assignmentId: 'a2',
        createdAt: 4000,
      },
    ],
    assignments: [
      {
        id: 'a1',
        round: 1,
        source: 'leader',
        createdByUserId: null,
        assigneeMemberId: 'mem_work',
        title: 'audit the diff',
        briefMd: 'audit it',
        status: 'done',
        nodeRunId: 'nr1',
        resultMessageId: '01D',
        createdAt: 2000,
        updatedAt: 3000,
      },
      {
        id: 'a2',
        round: 2,
        source: 'human',
        createdByUserId: 'u1',
        assigneeMemberId: 'mem_work',
        title: 'also check the tests',
        briefMd: '@Worker also check the tests',
        status: 'dispatched',
        nodeRunId: null,
        resultMessageId: null,
        createdAt: 4000,
        updatedAt: 4000,
      },
    ],
    ...over,
  }
}

interface FetchCall {
  url: string
  method: string
  body: unknown
}

function installFetch(
  room: WorkgroupRoomResponse,
  overrides: { confirm?: () => Response; deliver?: () => Response } = {},
): FetchCall[] {
  const calls: FetchCall[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      let body: unknown = null
      if (typeof init?.body === 'string' && init.body.length > 0) {
        try {
          body = JSON.parse(init.body)
        } catch {
          body = init.body
        }
      }
      calls.push({ url, method, body })
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      if (url.includes('/room')) return json(room)
      if (url.includes('/messages') && method === 'POST') {
        return json({ messageId: 'new', assignmentIds: [] }, 201)
      }
      if (url.includes('/cancel') && method === 'POST') return new Response(null, { status: 204 })
      if (url.includes('/deliver') && method === 'POST') {
        return overrides.deliver !== undefined
          ? overrides.deliver()
          : json({ messageId: 'delivery' }, 201)
      }
      if (url.includes('/confirm') && method === 'POST') {
        return overrides.confirm !== undefined ? overrides.confirm() : json({ decision: 'approve' })
      }
      if (url.includes('/node-runs')) {
        return json({ runs: [makeRun({ id: 'nr1' })], outputs: [] })
      }
      if (url.includes('/api/users/lookup')) {
        return json([
          {
            id: 'u1',
            username: 'alice',
            displayName: 'Alice Wang',
            role: 'user',
            status: 'active',
          },
        ])
      }
      // NodeDetailDrawer's SessionTab fetch — an error keeps the drawer
      // chrome rendered without needing a full conversation fixture.
      if (url.includes('/session')) return json({ code: 'nope', message: 'nope' }, 500)
      return json({})
    },
  )
  return calls
}

function renderRoom(room: WorkgroupRoomResponse, taskStatus: TaskStatus = 'running') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <WorkgroupRoom taskId="t1" taskStatus={taskStatus} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('WorkgroupRoom — message stream', () => {
  test('renders the three author forms: member+leader badge, human via user lookup, system muted', async () => {
    installFetch(makeRoom())
    renderRoom(makeRoom())

    // Member author: @displayName; the leader message carries the badge.
    const leaderMsg = await screen.findByTestId('wg-msg-01B')
    expect(within(leaderMsg).getByText('@Lead')).toBeTruthy()
    expect(within(leaderMsg).getByTestId('wg-msg-leader-01B')).toBeTruthy()
    // Non-leader member message: no badge.
    const workerMsg = screen.getByTestId('wg-msg-01D')
    expect(within(workerMsg).getByText('@Worker')).toBeTruthy()
    expect(within(workerMsg).queryByTestId('wg-msg-leader-01D')).toBeNull()

    // Human author resolves through /api/users/lookup — never the raw id.
    const humanMsg = screen.getByTestId('wg-msg-01A')
    await waitFor(() => expect(within(humanMsg).getByText('Alice Wang')).toBeTruthy())

    // System row: muted modifier class + localized label.
    const systemMsg = screen.getByTestId('wg-msg-01C')
    expect(systemMsg.className).toContain('workgroup-room__msg--system')
    expect(within(systemMsg).getByText('System')).toBeTruthy()
  })

  test('round separators land at transitions only (no round-0 prelude divider)', async () => {
    installFetch(makeRoom())
    renderRoom(makeRoom())
    await screen.findByTestId('wg-round-1')
    expect(screen.getByTestId('wg-round-2')).toBeTruthy()
    expect(screen.queryByTestId('wg-round-0')).toBeNull()
  })

  test('empty room renders the shared EmptyState', async () => {
    installFetch(makeRoom({ messages: [], assignments: [] }))
    renderRoom(makeRoom({ messages: [], assignments: [] }))
    await screen.findByTestId('workgroup-room-empty')
  })
})

describe('WorkgroupRoom — dispatch cards', () => {
  test('card shows title, assignee, source badge and the live status chip', async () => {
    installFetch(makeRoom())
    renderRoom(makeRoom())
    const cardEl = await screen.findByTestId('wg-card-a1')
    expect(within(cardEl).getByText('audit the diff')).toBeTruthy()
    expect(within(cardEl).getByText('@Worker')).toBeTruthy()
    expect(within(cardEl).getByText('Leader dispatch')).toBeTruthy()
    expect(within(cardEl).getByTestId('wg-card-status-a1').textContent).toBe('Done')
    // The human-dispatched card renders under ITS message with its own status.
    const humanCard = screen.getByTestId('wg-card-a2')
    expect(within(humanCard).getByTestId('wg-card-status-a2').textContent).toBe('Dispatched')
    expect(within(humanCard).getByText('Human dispatch')).toBeTruthy()
  })

  test('done card exposes the collapsible result block resolved via resultMessageId', async () => {
    installFetch(makeRoom())
    renderRoom(makeRoom())
    const result = await screen.findByTestId('wg-card-result-a1')
    expect(result.tagName).toBe('DETAILS')
    expect(result.hasAttribute('open')).toBe(false) // collapsed by default
    expect(within(result).getByText('Result')).toBeTruthy()
    // Body text present (native <details> keeps content in the DOM).
    expect(within(result).getByText('found 3 issues in the diff')).toBeTruthy()
    // The dispatched (no result yet) card has no result block.
    expect(screen.queryByTestId('wg-card-result-a2')).toBeNull()
  })

  test('view-run opens the reused NodeDetailDrawer; cards without a run have no entry', async () => {
    installFetch(makeRoom())
    renderRoom(makeRoom())
    const runBtn = await screen.findByTestId('wg-card-run-a1')
    expect(screen.queryByTestId('wg-card-run-a2')).toBeNull() // nodeRunId null
    fireEvent.click(runBtn)
    // The drawer is the same `.inspector` aside tasks.detail uses.
    await waitFor(() => {
      expect(document.querySelector('.inspector')).toBeTruthy()
    })
    expect(screen.getByText('__wg_member__')).toBeTruthy()
  })

  test('cancel is a two-click ConfirmButton that POSTs the cancel endpoint (dispatched card only)', async () => {
    const calls = installFetch(makeRoom())
    renderRoom(makeRoom())
    const dispatchedCard = await screen.findByTestId('wg-card-a2')
    const cancelBtn = within(dispatchedCard).getByRole('button', { name: 'Cancel' })
    fireEvent.click(cancelBtn) // arm
    fireEvent.click(within(dispatchedCard).getByRole('button', { name: 'Confirm?' }))
    await waitFor(() => {
      expect(
        calls.some(
          (c) =>
            c.method === 'POST' && c.url.endsWith('/api/workgroup-tasks/t1/assignments/a2/cancel'),
        ),
      ).toBe(true)
    })
    // Terminal (done) card renders no cancel button.
    const doneCard = screen.getByTestId('wg-card-a1')
    expect(within(doneCard).queryByRole('button', { name: 'Cancel' })).toBeNull()
  })
})

describe('WorkgroupRoom — composer', () => {
  test('send POSTs {body} to the messages endpoint and clears the draft', async () => {
    const calls = installFetch(makeRoom())
    renderRoom(makeRoom())
    const input = (await screen.findByTestId('workgroup-room-input')) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'hello room' } })
    fireEvent.click(screen.getByTestId('workgroup-room-send'))
    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === 'POST' && c.url.endsWith('/api/workgroup-tasks/t1/messages'),
      )
      expect(post).toBeTruthy()
      expect(post?.body).toEqual({ body: 'hello room' })
    })
    await waitFor(() => {
      expect((screen.getByTestId('workgroup-room-input') as HTMLTextAreaElement).value).toBe('')
    })
  })

  test('typing "@…" pops roster completion; clicking a suggestion commits "@displayName "', async () => {
    installFetch(makeRoom())
    renderRoom(makeRoom())
    const input = (await screen.findByTestId('workgroup-room-input')) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '@Wo' } })
    // Pin the caret explicitly — happy-dom's selectionStart after a change
    // event is not guaranteed to sit at the end like a real browser's.
    fireEvent.select(input, { target: { selectionStart: 3, selectionEnd: 3 } })
    const listbox = await screen.findByTestId('workgroup-room-mentions')
    expect(within(listbox).getByTestId('wg-mention-Worker')).toBeTruthy()
    // Prefix-filtered: Alice does not match '@Wo'.
    expect(within(listbox).queryByTestId('wg-mention-Alice')).toBeNull()
    fireEvent.click(within(listbox).getByTestId('wg-mention-Worker'))
    expect((screen.getByTestId('workgroup-room-input') as HTMLTextAreaElement).value).toBe(
      '@Worker ',
    )
    // Committing closes the suggestion list.
    expect(screen.queryByTestId('workgroup-room-mentions')).toBeNull()
  })

  test('terminal task status disables the composer with the read-only notice', async () => {
    installFetch(makeRoom({ taskStatus: 'done' }))
    renderRoom(makeRoom({ taskStatus: 'done' }), 'done')
    const input = (await screen.findByTestId('workgroup-room-input')) as HTMLTextAreaElement
    expect(input.disabled).toBe(true)
    expect((screen.getByTestId('workgroup-room-send') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('workgroup-room-terminal-notice')).toBeTruthy()
  })
})

describe('WorkgroupRoom — side rail', () => {
  test('roster shows working/idle from live cards (running|dispatched = working)', async () => {
    installFetch(makeRoom())
    renderRoom(makeRoom())
    // Worker owns the dispatched a2 card → working; Lead/Alice idle.
    const worker = await screen.findByTestId('wg-member-state-Worker')
    expect(worker.textContent).toBe('Working')
    expect(screen.getByTestId('wg-member-state-Lead').textContent).toBe('Idle')
    expect(screen.getByTestId('wg-member-state-Alice').textContent).toBe('Idle')
    // Leader badge on the roster row too.
    const leadRow = screen.getByTestId('wg-member-Lead')
    expect(within(leadRow).getByText('Leader')).toBeTruthy()
  })

  test('gate card: approve POSTs {decision:approve} directly (PR-5 live gate)', async () => {
    const room = makeRoom({
      taskStatus: 'awaiting_review',
      gate: {
        declaredDone: true,
        awaitingConfirmation: true,
        rejected: false,
        summary: 'all done',
      },
    })
    const calls = installFetch(room)
    renderRoom(room, 'awaiting_review')
    const gate = await screen.findByTestId('workgroup-room-gate')
    expect(within(gate).getByText('all done')).toBeTruthy()
    fireEvent.click(within(gate).getByTestId('workgroup-room-gate-confirm'))
    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === 'POST' && c.url.endsWith('/api/workgroup-tasks/t1/confirm'),
      )
      expect(post).toBeTruthy()
      expect(post?.body).toEqual({ decision: 'approve' })
    })
  })

  test('gate reject: dialog requires a comment, then POSTs {decision:reject, comment}', async () => {
    const room = makeRoom({
      taskStatus: 'awaiting_review',
      gate: { declaredDone: true, awaitingConfirmation: true, rejected: false, summary: 's' },
    })
    const calls = installFetch(room)
    renderRoom(room, 'awaiting_review')
    const gate = await screen.findByTestId('workgroup-room-gate')
    fireEvent.click(within(gate).getByTestId('workgroup-room-gate-reject'))
    const submit = (await screen.findByTestId(
      'workgroup-room-gate-reject-submit',
    )) as HTMLButtonElement
    // Comment is REQUIRED (backend 422s without one) — submit stays disabled.
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByTestId('workgroup-room-gate-reject-comment'), {
      target: { value: 'missing the perf part' },
    })
    expect(
      (screen.getByTestId('workgroup-room-gate-reject-submit') as HTMLButtonElement).disabled,
    ).toBe(false)
    fireEvent.click(screen.getByTestId('workgroup-room-gate-reject-submit'))
    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === 'POST' && c.url.endsWith('/api/workgroup-tasks/t1/confirm'),
      )
      expect(post).toBeTruthy()
      expect(post?.body).toEqual({ decision: 'reject', comment: 'missing the perf part' })
    })
  })

  test('a 409 gate-not-open response surfaces the friendly copy on the card', async () => {
    const room = makeRoom({
      taskStatus: 'awaiting_review',
      gate: { declaredDone: true, awaitingConfirmation: true, rejected: false, summary: null },
    })
    installFetch(room, {
      confirm: () =>
        new Response(
          JSON.stringify({
            ok: false,
            code: 'workgroup-gate-not-open',
            message: 'the completion gate is not awaiting confirmation',
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
    })
    renderRoom(room, 'awaiting_review')
    const gate = await screen.findByTestId('workgroup-room-gate')
    fireEvent.click(within(gate).getByTestId('workgroup-room-gate-confirm'))
    const err = await screen.findByTestId('workgroup-room-gate-error')
    expect(err.textContent).toContain('The completion gate is not open for confirmation')
    expect(err.textContent).not.toContain('workgroup-gate-not-open')
  })

  test('no gate card while the gate is not awaiting confirmation', async () => {
    installFetch(makeRoom())
    renderRoom(makeRoom())
    await screen.findByTestId('workgroup-room')
    expect(screen.queryByTestId('workgroup-room-gate')).toBeNull()
  })

  test('group info lists goal / mode / max rounds / effective switches', async () => {
    installFetch(makeRoom())
    renderRoom(makeRoom())
    const info = await screen.findByTestId('workgroup-room-info')
    expect(within(info).getByText('ship the audit')).toBeTruthy()
    expect(within(info).getByText('Leader-Worker')).toBeTruthy()
    expect(within(info).getByText('20')).toBeTruthy()
    // shareOutputs + directMessages on, blackboard off (lw uses stored values).
    expect(within(info).getByText('Share outputs · Direct messages')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// PR-5/6 — human delivery, fc task list, config entry, decision highlight
// ---------------------------------------------------------------------------

/** Two dispatched cards: a3 → Alice (human, to-do form), a4 → Worker (agent). */
function deliveryRoom(): WorkgroupRoomResponse {
  return makeRoom({
    messages: [
      {
        id: '01F',
        round: 1,
        authorKind: 'member',
        authorMemberId: 'mem_lead',
        authorUserId: null,
        kind: 'dispatch',
        bodyMd: '@Alice review the copy',
        mentionMemberIds: ['mem_alice'],
        assignmentId: 'a3',
        createdAt: 5000,
      },
      {
        id: '01G',
        round: 1,
        authorKind: 'member',
        authorMemberId: 'mem_lead',
        authorUserId: null,
        kind: 'dispatch',
        bodyMd: '@Worker crunch the data',
        mentionMemberIds: ['mem_work'],
        assignmentId: 'a4',
        createdAt: 5100,
      },
    ],
    assignments: [
      {
        id: 'a3',
        round: 1,
        source: 'leader',
        createdByUserId: null,
        assigneeMemberId: 'mem_alice',
        title: 'review the copy',
        briefMd: 'please review',
        status: 'dispatched',
        nodeRunId: null,
        resultMessageId: null,
        createdAt: 5000,
        updatedAt: 5000,
      },
      {
        id: 'a4',
        round: 1,
        source: 'leader',
        createdByUserId: null,
        assigneeMemberId: 'mem_work',
        title: 'crunch the data',
        briefMd: 'crunch it',
        status: 'dispatched',
        nodeRunId: null,
        resultMessageId: null,
        createdAt: 5100,
        updatedAt: 5100,
      },
    ],
  })
}

describe('WorkgroupRoom — human delivery cards (PR-5 拍板 #16)', () => {
  test('only the human-assigned dispatched card renders the to-do form + deliver entries', async () => {
    installFetch(deliveryRoom())
    renderRoom(deliveryRoom())
    const humanCard = await screen.findByTestId('wg-card-a3')
    expect(humanCard.className).toContain('workgroup-room__card--todo')
    expect(within(humanCard).getByTestId('wg-card-todo-a3')).toBeTruthy()
    expect(within(humanCard).getByTestId('wg-card-deliver-quick-a3')).toBeTruthy()
    expect(within(humanCard).getByTestId('wg-card-deliver-form-a3')).toBeTruthy()
    // Agent-assigned card: plain dispatch form, no delivery affordances.
    const agentCard = screen.getByTestId('wg-card-a4')
    expect(agentCard.className).not.toContain('workgroup-room__card--todo')
    expect(within(agentCard).queryByTestId('wg-card-deliver-quick-a4')).toBeNull()
    expect(within(agentCard).queryByTestId('wg-card-deliver-form-a4')).toBeNull()
  })

  test('quick reply expands inline and POSTs the {body} shape', async () => {
    const calls = installFetch(deliveryRoom())
    renderRoom(deliveryRoom())
    fireEvent.click(await screen.findByTestId('wg-card-deliver-quick-a3'))
    const input = (await screen.findByTestId('wg-card-quick-input-a3')) as HTMLTextAreaElement
    const submit = screen.getByTestId('wg-card-quick-submit-a3') as HTMLButtonElement
    expect(submit.disabled).toBe(true) // empty draft
    fireEvent.change(input, { target: { value: 'looks good to me' } })
    fireEvent.click(screen.getByTestId('wg-card-quick-submit-a3'))
    await waitFor(() => {
      const post = calls.find(
        (c) =>
          c.method === 'POST' && c.url.endsWith('/api/workgroup-tasks/t1/assignments/a3/deliver'),
      )
      expect(post).toBeTruthy()
      expect(post?.body).toEqual({ body: 'looks good to me' })
    })
  })

  test('form delivery opens the Dialog and POSTs the {summary, detail} shape', async () => {
    const calls = installFetch(deliveryRoom())
    renderRoom(deliveryRoom())
    fireEvent.click(await screen.findByTestId('wg-card-deliver-form-a3'))
    const submit = (await screen.findByTestId('wg-deliver-form-submit-a3')) as HTMLButtonElement
    expect(submit.disabled).toBe(true) // summary required
    fireEvent.change(screen.getByTestId('wg-deliver-summary-a3'), {
      target: { value: 'copy approved' },
    })
    fireEvent.change(screen.getByTestId('wg-deliver-detail-a3'), {
      target: { value: 'two nits inline' },
    })
    fireEvent.click(screen.getByTestId('wg-deliver-form-submit-a3'))
    await waitFor(() => {
      const post = calls.find(
        (c) =>
          c.method === 'POST' && c.url.endsWith('/api/workgroup-tasks/t1/assignments/a3/deliver'),
      )
      expect(post).toBeTruthy()
      expect(post?.body).toEqual({ summary: 'copy approved', detail: 'two nits inline' })
    })
  })
})

describe('WorkgroupRoom — fc task list panel (PR-5)', () => {
  function fcRoom(): WorkgroupRoomResponse {
    const base = makeRoom()
    const card = (
      id: string,
      status:
        | 'open'
        | 'dispatched'
        | 'running'
        | 'awaiting_human'
        | 'done'
        | 'canceled'
        | 'delivered'
        | 'failed',
      assignee: string | null,
    ) => ({
      id,
      round: 1,
      source: 'self_claim' as const,
      createdByUserId: null,
      assigneeMemberId: assignee,
      title: `task ${id}`,
      briefMd: 'b',
      status,
      nodeRunId: null,
      resultMessageId: null,
      createdAt: 1000,
      updatedAt: 1000,
    })
    return makeRoom({
      config: { ...base.config, mode: 'free_collab', leaderMemberId: null },
      messages: [],
      assignments: [
        card('o1', 'open', null),
        card('d1', 'dispatched', 'mem_work'),
        card('r1', 'running', 'mem_work'),
        card('ah1', 'awaiting_human', 'mem_alice'),
        card('done1', 'done', 'mem_work'),
        card('c1', 'canceled', null),
      ],
    })
  }

  test('groups open / in-flight / done with counts; canceled stays off the panel', async () => {
    installFetch(fcRoom())
    renderRoom(fcRoom())
    const panel = await screen.findByTestId('workgroup-room-fc-list')
    expect(within(panel).getByTestId('wg-fc-count-open').textContent).toBe('1')
    expect(within(panel).getByTestId('wg-fc-count-active').textContent).toBe('3')
    expect(within(panel).getByTestId('wg-fc-count-done').textContent).toBe('1')
    expect(within(panel).getByTestId('wg-fc-row-o1')).toBeTruthy()
    expect(within(panel).getByTestId('wg-fc-row-r1')).toBeTruthy()
    expect(within(panel).queryByTestId('wg-fc-row-c1')).toBeNull()
    // Open rows keep the cancel affordance.
    const openRow = within(panel).getByTestId('wg-fc-row-o1')
    expect(within(openRow).getByRole('button', { name: 'Cancel' })).toBeTruthy()
  })

  test('leader_worker rooms render no fc panel', async () => {
    installFetch(makeRoom())
    renderRoom(makeRoom())
    await screen.findByTestId('workgroup-room')
    expect(screen.queryByTestId('workgroup-room-fc-list')).toBeNull()
  })
})

describe('WorkgroupRoom — mid-run config entry + decision highlight (PR-5/6)', () => {
  test('the side rail opens the config dialog while the task is live', async () => {
    installFetch(makeRoom())
    renderRoom(makeRoom())
    fireEvent.click(await screen.findByTestId('workgroup-room-config-btn'))
    await screen.findByTestId('workgroup-room-config-dialog')
  })

  test('terminal tasks hide the config entry', async () => {
    installFetch(makeRoom({ taskStatus: 'done' }))
    renderRoom(makeRoom({ taskStatus: 'done' }), 'done')
    await screen.findByTestId('workgroup-room')
    expect(screen.queryByTestId('workgroup-room-config-btn')).toBeNull()
  })

  test("the leader's decision message carries the accent modifier", async () => {
    const room = makeRoom({
      messages: [
        {
          id: '01Z',
          round: 3,
          authorKind: 'member',
          authorMemberId: 'mem_lead',
          authorUserId: null,
          kind: 'decision',
          bodyMd: 'we are done: shipped it',
          mentionMemberIds: [],
          assignmentId: null,
          createdAt: 9000,
        },
      ],
      assignments: [],
    })
    installFetch(room)
    renderRoom(room)
    const msg = await screen.findByTestId('wg-msg-01Z')
    expect(msg.className).toContain('workgroup-room__msg--decision')
  })
})
