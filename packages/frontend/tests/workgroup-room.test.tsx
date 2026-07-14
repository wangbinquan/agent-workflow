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
    rerunCause: null,
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
    // RFC-179 — per-member currentRun map; default empty (no member clickable).
    memberRuns: {},
    runHistory: [],
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
  overrides: { confirm?: () => Response; deliver?: () => Response; runs?: NodeRun[] } = {},
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
        return json({ runs: overrides.runs ?? [makeRun({ id: 'nr1' })], outputs: [] })
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

  // RFC-179 — click a member (leader included, as a peer) to open its current
  // session in the same reused drawer; members with no currentRun are inert.
  test('RFC-179: a member with a currentRun is clickable and opens its session drawer', async () => {
    installFetch(
      makeRoom({
        memberRuns: {
          mem_work: {
            nodeRunId: 'nr1',
            status: 'running',
            kind: 'assignment',
            triggerMessageId: null,
          },
        },
      }),
    )
    renderRoom(makeRoom())
    const btn = await screen.findByTestId('wg-member-open-session-Worker')
    // Lead + human Alice have no run → not clickable (plain name span).
    expect(screen.queryByTestId('wg-member-open-session-Lead')).toBeNull()
    expect(screen.queryByTestId('wg-member-open-session-Alice')).toBeNull()
    fireEvent.click(btn)
    await waitFor(() => {
      expect(document.querySelector('.inspector')).toBeTruthy()
    })
  })

  test('RFC-179: leader is a peer — clickable when it has a currentRun', async () => {
    installFetch(
      makeRoom({
        memberRuns: {
          mem_lead: {
            nodeRunId: 'nr1',
            status: 'running',
            kind: 'leader-round',
            triggerMessageId: null,
          },
        },
      }),
    )
    renderRoom(makeRoom())
    expect(await screen.findByTestId('wg-member-open-session-Lead')).toBeTruthy()
  })

  // RFC-179 §2.3 (Q5) — a message-turn wake (@-mention) surfaces a「执行中」pill on
  // its trigger message + a synthetic stream active row (it has no dispatch card).
  // RFC-182 D1/D8 —— 取代 RFC-179 render②：合成活跃行（跑完即消失）升级为
  // 持久回合卡（执行中实时、终态原地定格、永不消失，可点进 session）。
  test('RFC-182: 被@轮在触发消息下出持久回合卡（终态仍在）+ pill 可点开 drawer', async () => {
    installFetch(
      makeRoom({
        memberRuns: {
          mem_work: {
            nodeRunId: 'nr9',
            status: 'running',
            kind: 'message-turn',
            triggerMessageId: '01E',
          },
        },
        runHistory: [
          {
            nodeRunId: 'nr9',
            memberId: 'mem_work',
            displayName: 'Worker',
            kind: 'message-turn',
            status: 'running',
            round: null,
            startedAt: Date.now() - 5_000,
            finishedAt: null,
            triggerMessageId: '01E',
            assignmentId: null,
            note: null,
          },
          // 早前一轮已终态——回合卡必须仍在流里（「跑完不消失」回归锁）。
          {
            nodeRunId: 'nr8',
            memberId: 'mem_work',
            displayName: 'Worker',
            kind: 'message-turn',
            status: 'done',
            round: null,
            startedAt: Date.now() - 60_000,
            finishedAt: Date.now() - 50_000,
            triggerMessageId: '01E',
            assignmentId: null,
            note: null,
          },
        ],
      }),
    )
    renderRoom(makeRoom())
    // Pill on the triggering @-mention message (01E)，且是可点 button（D9）。
    const pill = await screen.findByTestId('wg-msg-executing-01E')
    expect(pill.tagName).toBe('BUTTON')
    expect(screen.queryByTestId('wg-msg-executing-01A')).toBeNull()
    // 触发消息下出两张回合卡：running 实时 + done 定格（永不消失）。
    expect(screen.getByTestId('wg-turn-nr9')).toBeTruthy()
    expect(screen.getByTestId('wg-turn-nr8')).toBeTruthy()
    // 「查看会话」按钮可点。
    expect(screen.getByTestId('wg-turn-view-nr9')).toBeTruthy()
  })

  test('RFC-179: an assignment run surfaces as its card — no synthetic active row / pill', async () => {
    installFetch(
      makeRoom({
        memberRuns: {
          mem_work: {
            nodeRunId: 'nr1',
            status: 'running',
            kind: 'assignment',
            triggerMessageId: null,
          },
        },
      }),
    )
    renderRoom(makeRoom())
    await screen.findByTestId('workgroup-room-log')
    // RFC-182 D4：assignment 轮由 DispatchCard 承载——不出回合卡（防双卡）。
    expect(screen.queryByTestId('wg-turn-nr1')).toBeNull()
    expect(screen.queryByTestId('wg-msg-executing-01E')).toBeNull()
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

// RFC-174 — composer keyboard UX: @-mention keyboard nav + Cmd/Ctrl+Enter send.
// The key→action matrix is locked purely in workgroup-room-lib.test.ts
// (resolveComposerKey); these assert the component actually wires it.
describe('WorkgroupRoom — composer keyboard (RFC-174)', () => {
  test('Cmd/Ctrl+Enter sends and clears the draft; plain Enter does not (newline)', async () => {
    const calls = installFetch(makeRoom())
    renderRoom(makeRoom())
    const input = (await screen.findByTestId('workgroup-room-input')) as HTMLTextAreaElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'ship it' } })
    // plain Enter → newline: the handler does NOT cancel the event...
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(true)
    // ...and crucially posts NOTHING (a newline must never be a send).
    expect(
      calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/workgroup-tasks/t1/messages')),
    ).toBeUndefined()
    // Ctrl+Enter → send: the handler cancels the event and POSTs.
    expect(fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })).toBe(false)
    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === 'POST' && c.url.endsWith('/api/workgroup-tasks/t1/messages'),
      )
      expect(post?.body).toEqual({ body: 'ship it' })
    })
    await waitFor(() => {
      expect((screen.getByTestId('workgroup-room-input') as HTMLTextAreaElement).value).toBe('')
    })
  })

  test('IME: Ctrl+Enter while composing neither sends nor commits', async () => {
    const calls = installFetch(makeRoom())
    renderRoom(makeRoom())
    const input = (await screen.findByTestId('workgroup-room-input')) as HTMLTextAreaElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '发送消息' } })
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, isComposing: true })
    // Let any (erroneous) mutation flush, then assert nothing was posted.
    await Promise.resolve()
    expect(
      calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/workgroup-tasks/t1/messages')),
    ).toBeUndefined()
    expect(input.value).toBe('发送消息')
  })

  test('empty / whitespace draft: Ctrl+Enter does not send', async () => {
    const calls = installFetch(makeRoom())
    renderRoom(makeRoom())
    const input = (await screen.findByTestId('workgroup-room-input')) as HTMLTextAreaElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    await Promise.resolve()
    expect(
      calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/workgroup-tasks/t1/messages')),
    ).toBeUndefined()
  })

  test('@-mention: ArrowDown moves the highlight and Enter commits; aria wiring', async () => {
    installFetch(makeRoom())
    renderRoom(makeRoom())
    const input = (await screen.findByTestId('workgroup-room-input')) as HTMLTextAreaElement
    fireEvent.focus(input)
    // '@' offers the whole roster in order: Lead, Worker, Alice.
    fireEvent.change(input, { target: { value: '@' } })
    fireEvent.select(input, { target: { selectionStart: 1, selectionEnd: 1 } })
    const listbox = await screen.findByTestId('workgroup-room-mentions')
    expect(input.getAttribute('aria-controls')).toBe(listbox.id)
    // The active-descendant id must resolve to the REAL highlighted option.
    const activeId0 = input.getAttribute('aria-activedescendant')
    expect(activeId0).toBe(`${listbox.id}-opt-0`)
    expect(document.getElementById(activeId0!)).toBe(within(listbox).getByTestId('wg-mention-Lead'))
    expect(within(listbox).getByTestId('wg-mention-Lead').getAttribute('aria-selected')).toBe(
      'true',
    )
    // ArrowDown → 2nd option (Worker) highlighted; activedescendant follows.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    const activeId1 = input.getAttribute('aria-activedescendant')
    expect(activeId1).toBe(`${listbox.id}-opt-1`)
    expect(document.getElementById(activeId1!)).toBe(
      within(listbox).getByTestId('wg-mention-Worker'),
    )
    expect(within(listbox).getByTestId('wg-mention-Worker').getAttribute('aria-selected')).toBe(
      'true',
    )
    // Enter commits the highlighted candidate, closes the list.
    fireEvent.keyDown(input, { key: 'Enter' })
    expect((screen.getByTestId('workgroup-room-input') as HTMLTextAreaElement).value).toBe(
      '@Worker ',
    )
    expect(screen.queryByTestId('workgroup-room-mentions')).toBeNull()
  })

  test('@-mention: Tab commits the active candidate', async () => {
    installFetch(makeRoom())
    renderRoom(makeRoom())
    const input = (await screen.findByTestId('workgroup-room-input')) as HTMLTextAreaElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '@Wo' } })
    fireEvent.select(input, { target: { selectionStart: 3, selectionEnd: 3 } })
    await screen.findByTestId('workgroup-room-mentions')
    fireEvent.keyDown(input, { key: 'Tab' })
    expect((screen.getByTestId('workgroup-room-input') as HTMLTextAreaElement).value).toBe(
      '@Worker ',
    )
  })

  test('@-mention: Escape closes, keeps text, and typing reopens', async () => {
    installFetch(makeRoom())
    renderRoom(makeRoom())
    const input = (await screen.findByTestId('workgroup-room-input')) as HTMLTextAreaElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '@Wo' } })
    fireEvent.select(input, { target: { selectionStart: 3, selectionEnd: 3 } })
    await screen.findByTestId('workgroup-room-mentions')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByTestId('workgroup-room-mentions')).toBeNull()
    expect(input.value).toBe('@Wo')
    // Typing more in the same token reopens (dismissal is {start,query}-scoped).
    fireEvent.change(input, { target: { value: '@Wor' } })
    fireEvent.select(input, { target: { selectionStart: 4, selectionEnd: 4 } })
    expect(await screen.findByTestId('workgroup-room-mentions')).toBeTruthy()
  })

  test('mention dropdown is focus-gated: blur closes it', async () => {
    installFetch(makeRoom())
    renderRoom(makeRoom())
    const input = (await screen.findByTestId('workgroup-room-input')) as HTMLTextAreaElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '@Wo' } })
    fireEvent.select(input, { target: { selectionStart: 3, selectionEnd: 3 } })
    await screen.findByTestId('workgroup-room-mentions')
    fireEvent.blur(input)
    await waitFor(() => expect(screen.queryByTestId('workgroup-room-mentions')).toBeNull())
  })

  test('visible shortcut hint shows the send chord + newline (platform mod)', async () => {
    installFetch(makeRoom())
    renderRoom(makeRoom())
    const hint = await screen.findByTestId('workgroup-room-shortcut-hint')
    const text = hint.textContent ?? ''
    expect(text).toContain('Ctrl+Enter') // happy-dom is non-mac → Ctrl
    // Both "send" (Ctrl+Enter) and "newline" (Enter) are shown → Enter twice.
    expect((text.match(/Enter/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  test('quick reply: Cmd/Ctrl+Enter delivers the {body} shape', async () => {
    const calls = installFetch(deliveryRoom())
    renderRoom(deliveryRoom())
    fireEvent.click(await screen.findByTestId('wg-card-deliver-quick-a3'))
    const input = (await screen.findByTestId('wg-card-quick-input-a3')) as HTMLTextAreaElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'done and dusted' } })
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    await waitFor(() => {
      const post = calls.find(
        (c) =>
          c.method === 'POST' && c.url.endsWith('/api/workgroup-tasks/t1/assignments/a3/deliver'),
      )
      expect(post?.body).toEqual({ body: 'done and dusted' })
    })
  })

  test('quick reply: plain Enter is a newline and IME Ctrl+Enter is ignored (no deliver)', async () => {
    const calls = installFetch(deliveryRoom())
    renderRoom(deliveryRoom())
    fireEvent.click(await screen.findByTestId('wg-card-deliver-quick-a3'))
    const input = (await screen.findByTestId('wg-card-quick-input-a3')) as HTMLTextAreaElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'hold on' } })
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(true) // newline, not cancelled
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, isComposing: true }) // IME
    await Promise.resolve()
    expect(calls.find((c) => c.method === 'POST' && c.url.includes('/deliver'))).toBeUndefined()
  })

  test('IME while the mention dropdown is open: Enter does not commit', async () => {
    installFetch(makeRoom())
    renderRoom(makeRoom())
    const input = (await screen.findByTestId('workgroup-room-input')) as HTMLTextAreaElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '@Wo' } })
    fireEvent.select(input, { target: { selectionStart: 3, selectionEnd: 3 } })
    await screen.findByTestId('workgroup-room-mentions')
    // Enter during IME composition is owned by the input method, not a commit.
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(input.value).toBe('@Wo') // NOT committed to '@Worker '
    expect(screen.queryByTestId('workgroup-room-mentions')).toBeTruthy() // still open
  })

  test('Esc dismissal is cleared on edit: re-typing the same @token reopens (impl-gate P1)', async () => {
    installFetch(makeRoom())
    renderRoom(makeRoom())
    const input = (await screen.findByTestId('workgroup-room-input')) as HTMLTextAreaElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '@Wo' } })
    fireEvent.select(input, { target: { selectionStart: 3, selectionEnd: 3 } })
    await screen.findByTestId('workgroup-room-mentions')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByTestId('workgroup-room-mentions')).toBeNull()
    // Clear the draft, then reconstruct the IDENTICAL '@Wo' token at the same
    // position — the stale {start:0,query:'Wo'} dismissal must not suppress it.
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.change(input, { target: { value: '@Wo' } })
    fireEvent.select(input, { target: { selectionStart: 3, selectionEnd: 3 } })
    expect(await screen.findByTestId('workgroup-room-mentions')).toBeTruthy()
  })

  test('closing the dropdown clears aria-controls + aria-activedescendant (impl-gate P2)', async () => {
    installFetch(makeRoom())
    renderRoom(makeRoom())
    const input = (await screen.findByTestId('workgroup-room-input')) as HTMLTextAreaElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '@Wo' } })
    fireEvent.select(input, { target: { selectionStart: 3, selectionEnd: 3 } })
    await screen.findByTestId('workgroup-room-mentions')
    expect(input.getAttribute('aria-controls')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('workgroup-room-mentions')).toBeNull())
    // No dangling references to the now-unmounted listbox.
    expect(input.getAttribute('aria-controls')).toBeNull()
    expect(input.getAttribute('aria-activedescendant')).toBeNull()
  })
})

describe('WorkgroupRoom — side rail', () => {
  // RFC-182 D5 —— 四态 presence 取代 working/idle 二元（数据源错配修复：
  // memberIsWorking 只读 assignments，leader 轮/被@轮执行时恒「空闲」）。
  test('roster presence: dispatched 卡=排队中；currentRun running=执行中（chip 可点开 drawer）', async () => {
    installFetch(
      makeRoom({
        memberRuns: {
          mem_lead: {
            nodeRunId: 'nrL',
            status: 'running',
            kind: 'leader-round',
            triggerMessageId: null,
          },
        },
      }),
    )
    renderRoom(makeRoom())
    // Worker owns the dispatched a2 card（无 run）→ 排队中（Queued）。
    const worker = await screen.findByTestId('wg-member-state-Worker')
    expect(worker.textContent).toBe('Queued')
    // Leader 轮执行中 → Working（旧实现此处显示 Idle——同屏矛盾回归锁），
    // 且 chip 本身是可点 button，点开该 run 的 drawer。
    const lead = screen.getByTestId('wg-member-state-Lead')
    expect(lead.textContent).toBe('Working')
    expect(lead.tagName).toBe('BUTTON')
    expect(screen.getByTestId('wg-member-state-Alice').textContent).toBe('Idle')
    // Leader badge on the roster row too.
    const leadRow = screen.getByTestId('wg-member-Lead')
    expect(within(leadRow).getByText('Leader')).toBeTruthy()
  })

  // RFC-185 —— fan-out 并发规模徽标：≥2 路在途才显示 ×N（单路/空闲不显示，
  // 常态花名册零噪音）；数据源 = runHistory（与 presence/回合卡同一单源），
  // awaiting_human（clarify park 投影）计入、终态不计。
  test('roster fan-out badge: ×N when a member has ≥2 active runs, absent on single-run members', async () => {
    const entry = (
      over: Partial<WorkgroupRoomResponse['runHistory'][number]>,
    ): WorkgroupRoomResponse['runHistory'][number] => ({
      nodeRunId: '01R1',
      memberId: 'mem_work',
      displayName: 'Worker',
      kind: 'assignment',
      status: 'running',
      round: null,
      startedAt: 1000,
      finishedAt: null,
      triggerMessageId: null,
      assignmentId: 'a1',
      note: null,
      ...over,
    })
    installFetch(
      makeRoom({
        memberRuns: {
          mem_lead: {
            nodeRunId: '01RL',
            status: 'running',
            kind: 'leader-round',
            triggerMessageId: null,
          },
        },
        runHistory: [
          entry({ nodeRunId: '01R1', assignmentId: 'a1', status: 'running' }),
          entry({ nodeRunId: '01R2', assignmentId: 'a2', status: 'pending' }),
          entry({ nodeRunId: '01R3', assignmentId: 'a3', status: 'awaiting_human' }),
          entry({ nodeRunId: '01R4', assignmentId: 'a4', status: 'done' }), // terminal — not counted
          entry({
            nodeRunId: '01RL',
            memberId: 'mem_lead',
            displayName: 'Lead',
            kind: 'leader-round',
            assignmentId: null,
            status: 'running',
          }),
        ],
      }),
    )
    renderRoom(makeRoom())
    const badge = await screen.findByTestId('wg-member-active-runs-Worker')
    expect(badge.textContent).toBe('×3 active')
    // exactly one live run → no badge (presence chip alone carries that state)
    expect(screen.queryByTestId('wg-member-active-runs-Lead')).toBeNull()
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

// ---------------------------------------------------------------------------
// RFC-182 —— 执行记录卡（G4-①）：全成员历次执行倒序、整行可点开 drawer。
// ---------------------------------------------------------------------------

describe('WorkgroupRoom — RFC-182 执行记录', () => {
  const entry = (over: Partial<WorkgroupRoomResponse['runHistory'][number]>) => ({
    nodeRunId: 'nr1',
    memberId: 'mem_work',
    displayName: 'Worker',
    kind: 'assignment' as const,
    status: 'done',
    round: null,
    startedAt: 1_000,
    finishedAt: 61_000,
    triggerMessageId: null,
    assignmentId: 'a1',
    note: null,
    ...over,
  })

  test('倒序列出全部回合；行可点 → 打开 drawer；空态走 EmptyState', async () => {
    const room = makeRoom({
      runHistory: [
        entry({ nodeRunId: 'nr1' }),
        entry({
          nodeRunId: 'nr2',
          kind: 'leader-round',
          memberId: 'mem_lead',
          displayName: 'Lead',
          round: 1,
        }),
      ],
    })
    installFetch(room, { runs: [makeRun({ id: 'nr1' }), makeRun({ id: 'nr2' })] })
    renderRoom(room)
    const rail = await screen.findByTestId('workgroup-room-runlog')
    const rows = within(rail).getAllByRole('button')
    // 倒序：最新的 nr2 在前。
    expect(rows[0]?.getAttribute('data-testid')).toBe('wg-runlog-nr2')
    expect(rows[1]?.getAttribute('data-testid')).toBe('wg-runlog-nr1')
    fireEvent.click(rows[1] as HTMLElement)
    await waitFor(() => {
      expect(document.querySelector('.inspector')).toBeTruthy()
    })
  })

  test('无历史 → 空态', async () => {
    installFetch(makeRoom())
    renderRoom(makeRoom())
    expect(await screen.findByTestId('wg-runlog-empty')).toBeTruthy()
  })

  test('「反问已压制」辅注（RFC-181 协同 D11）随 note 渲染在回合卡上', async () => {
    const room = makeRoom({
      runHistory: [
        entry({
          nodeRunId: 'nrS',
          kind: 'message-turn',
          status: 'failed',
          triggerMessageId: null,
          assignmentId: null,
          note: 'clarify-suppressed',
        }),
      ],
    })
    installFetch(room, { runs: [makeRun({ id: 'nrS', status: 'failed' })] })
    renderRoom(room)
    expect(await screen.findByTestId('wg-turn-note-nrS')).toBeTruthy()
  })
})
