// RFC-164 PR-4 — pure-function coverage for the chat room's data oracles
// (lib/workgroup-room): timeline round separators, dispatch-card joins
// (leader direct-id link vs human multi-@ same-instant join), @-mention
// completion, composer gating and status → chip-kind mapping. The rendered
// behaviors sit in workgroup-room.test.tsx; this file locks the branches
// without a DOM.

import { describe, expect, test } from 'vitest'
import type { WorkgroupMemberCurrentRun, WorkgroupRunEntry } from '@agent-workflow/shared'
import {
  WORKGROUP_ASSIGNMENT_STATUS_KIND,
  applyMention,
  assignmentDurationMs,
  assignmentStatusToKind,
  assignmentsForMessage,
  buildDeliverBody,
  buildRoomTimeline,
  canPostRoomMessage,
  countMemberActiveRuns,
  groupFcAssignments,
  indexRunHistory,
  isAssignmentCancelable,
  isHumanDeliveryCard,
  deriveMemberPresence,
  formatRoomTimestamp,
  formatTurnDuration,
  memberExecuting,
  mentionExecutingPills,
  standaloneTurnEntries,
  turnCardsForMessage,
  turnDurationMs,
  mentionCandidates,
  mentionQueryAt,
  resolveComposerKey,
  resultBodyFor,
  sendChordModLabel,
  workgroupRoomKey,
  type ComposerKeyState,
  type WorkgroupRoomAssignment,
  type WorkgroupRoomMessage,
} from '../src/lib/workgroup-room'

function msg(
  over: Partial<WorkgroupRoomMessage> & Pick<WorkgroupRoomMessage, 'id'>,
): WorkgroupRoomMessage {
  return {
    round: 0,
    authorKind: 'member',
    authorMemberId: 'mem_1',
    authorUserId: null,
    kind: 'chat',
    bodyMd: 'hi',
    mentionMemberIds: [],
    assignmentId: null,
    createdAt: 1000,
    ...over,
  }
}

function card(
  over: Partial<WorkgroupRoomAssignment> & Pick<WorkgroupRoomAssignment, 'id'>,
): WorkgroupRoomAssignment {
  return {
    round: 1,
    source: 'leader',
    createdByUserId: null,
    assigneeMemberId: 'mem_2',
    title: 'do it',
    briefMd: 'do it well',
    status: 'dispatched',
    nodeRunId: null,
    resultMessageId: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  }
}

describe('workgroupRoomKey', () => {
  test('is the single ["workgroup-room", taskId] shape (WS rules + query share it)', () => {
    expect(workgroupRoomKey('t1')).toEqual(['workgroup-room', 't1'])
    expect(workgroupRoomKey(null)).toEqual(['workgroup-room', null])
  })
})

describe('buildRoomTimeline', () => {
  test('inserts a separator at every round transition; round-0 prelude gets none', () => {
    const timeline = buildRoomTimeline([
      msg({ id: '01A', round: 0 }),
      msg({ id: '01B', round: 1 }),
      msg({ id: '01C', round: 1 }),
      msg({ id: '01D', round: 2 }),
    ])
    expect(
      timeline.map((e) =>
        e.type === 'round'
          ? `round:${e.round}`
          : e.type === 'turn'
            ? e.entry.nodeRunId
            : e.message.id,
      ),
    ).toEqual(['01A', 'round:1', '01B', '01C', 'round:2', '01D'])
  })

  test('a stream that starts at round 1 gets a leading separator', () => {
    const timeline = buildRoomTimeline([msg({ id: '01A', round: 1 })])
    expect(timeline[0]).toEqual({ type: 'round', round: 1 })
  })

  test('sorts by ULID id even when the input array is shuffled', () => {
    const timeline = buildRoomTimeline([
      msg({ id: '01C', round: 1 }),
      msg({ id: '01A', round: 0 }),
      msg({ id: '01B', round: 0 }),
    ])
    expect(timeline.filter((e) => e.type === 'message').map((e) => e.message.id)).toEqual([
      '01A',
      '01B',
      '01C',
    ])
  })

  test('empty stream → empty timeline', () => {
    expect(buildRoomTimeline([])).toEqual([])
  })
})

describe('assignmentsForMessage', () => {
  test('non-dispatch messages never carry cards', () => {
    const a = card({ id: 'a1' })
    expect(assignmentsForMessage(msg({ id: 'm1', kind: 'chat', assignmentId: 'a1' }), [a])).toEqual(
      [],
    )
  })

  test('engine dispatch: exactly the direct-id linked card (one message per card)', () => {
    const a1 = card({ id: 'a1' })
    const a2 = card({ id: 'a2' })
    const m = msg({
      id: 'm1',
      kind: 'dispatch',
      authorKind: 'member',
      assignmentId: 'a1',
      mentionMemberIds: ['mem_2'],
    })
    expect(assignmentsForMessage(m, [a1, a2]).map((a) => a.id)).toEqual(['a1'])
  })

  test('human multi-@: same-instant sibling cards join the single message', () => {
    // routes/workgroupTasks.ts reuses ONE Date.now() for all cards + the
    // message, and only stamps assignmentIds[0] on the message row.
    const a1 = card({ id: 'a1', source: 'human', assigneeMemberId: 'mem_2', createdAt: 777 })
    const a2 = card({ id: 'a2', source: 'human', assigneeMemberId: 'mem_3', createdAt: 777 })
    const unrelated = card({ id: 'a3', source: 'human', assigneeMemberId: 'mem_3', createdAt: 778 })
    const m = msg({
      id: 'm1',
      kind: 'dispatch',
      authorKind: 'human',
      authorMemberId: null,
      authorUserId: 'u1',
      assignmentId: 'a1',
      mentionMemberIds: ['mem_2', 'mem_3'],
      createdAt: 777,
    })
    expect(assignmentsForMessage(m, [a1, a2, unrelated]).map((a) => a.id)).toEqual(['a1', 'a2'])
  })
})

describe('resultBodyFor', () => {
  test('resolves the linked result message body; null when unset or missing', () => {
    const messages = [msg({ id: 'm9', kind: 'result', bodyMd: 'summary text' })]
    expect(resultBodyFor(card({ id: 'a1', resultMessageId: 'm9' }), messages)).toBe('summary text')
    expect(resultBodyFor(card({ id: 'a2', resultMessageId: null }), messages)).toBeNull()
    expect(resultBodyFor(card({ id: 'a3', resultMessageId: 'gone' }), messages)).toBeNull()
  })
})

describe('assignment status oracles', () => {
  test('only open/dispatched cards are cancelable (backend CAS contract)', () => {
    expect(isAssignmentCancelable('open')).toBe(true)
    expect(isAssignmentCancelable('dispatched')).toBe(true)
    for (const s of [
      'running',
      'awaiting_human',
      'delivered',
      'done',
      'failed',
      'canceled',
    ] as const) {
      expect(isAssignmentCancelable(s), s).toBe(false)
    }
  })

  test('status → chip kind covers all 8 statuses with the shared vocabulary', () => {
    expect(Object.keys(WORKGROUP_ASSIGNMENT_STATUS_KIND).sort()).toEqual(
      [
        'awaiting_human',
        'canceled',
        'delivered',
        'dispatched',
        'done',
        'failed',
        'open',
        'running',
      ].sort(),
    )
    expect(assignmentStatusToKind('running')).toBe('info')
    expect(assignmentStatusToKind('awaiting_human')).toBe('warn')
    expect(assignmentStatusToKind('done')).toBe('success')
    expect(assignmentStatusToKind('failed')).toBe('danger')
    expect(assignmentStatusToKind('canceled')).toBe('neutral')
  })

  // RFC-182 D5 —— 取代 memberIsWorking（RFC-164 只读 assignments 的忙/闲：
  // leader 轮/被@轮执行时恒「空闲」，与执行中 pill 同屏矛盾——用户抱怨 #2 根因）。
  test('deriveMemberPresence: currentRun 状态优先，assignment 只兜底', () => {
    const cards = [
      card({ id: 'a1', assigneeMemberId: 'mem_2', status: 'running' }),
      card({ id: 'a2', assigneeMemberId: 'mem_3', status: 'done' }),
      card({ id: 'a3', assigneeMemberId: 'mem_5', status: 'dispatched' }),
      card({ id: 'a4', assigneeMemberId: 'mem_6', status: 'awaiting_human' }),
    ]
    const cur = (status: string) => ({
      nodeRunId: 'r1',
      status,
      kind: 'assignment' as const,
      triggerMessageId: null,
    })
    // 设计门 P1 关键例：run=pending + assignment=running → 排队中（非执行中）。
    expect(deriveMemberPresence('mem_2', cards, cur('pending'))).toBe('queued')
    expect(deriveMemberPresence('mem_2', cards, cur('running'))).toBe('working')
    expect(deriveMemberPresence('mem_2', cards, cur('awaiting_human'))).toBe('awaiting')
    // currentRun 终态 → 落 assignment 兜底（running 卡）。
    expect(deriveMemberPresence('mem_2', cards, cur('done'))).toBe('working')
    // 无 run：dispatched → queued；awaiting_human 卡 → awaiting；无卡 → idle。
    expect(deriveMemberPresence('mem_5', cards, null)).toBe('queued')
    expect(deriveMemberPresence('mem_6', cards, null)).toBe('awaiting')
    expect(deriveMemberPresence('mem_3', cards, null)).toBe('idle')
    expect(deriveMemberPresence('mem_4', cards, null)).toBe('idle')
  })
})

describe('composer gating', () => {
  test('terminal statuses (done/failed/canceled) block posting; parked/live allow', () => {
    expect(canPostRoomMessage('done')).toBe(false)
    expect(canPostRoomMessage('failed')).toBe(false)
    expect(canPostRoomMessage('canceled')).toBe(false)
    expect(canPostRoomMessage('running')).toBe(true)
    expect(canPostRoomMessage('awaiting_human')).toBe(true)
    expect(canPostRoomMessage('interrupted')).toBe(true)
  })
})

describe('mention completion', () => {
  const config = {
    members: [
      {
        id: 'm1',
        memberType: 'agent' as const,
        agentName: 'x',
        userId: null,
        displayName: 'Worker',
        roleDesc: '',
      },
      {
        id: 'm2',
        memberType: 'agent' as const,
        agentName: 'y',
        userId: null,
        displayName: 'Watcher',
        roleDesc: '',
      },
      {
        id: 'm3',
        memberType: 'human' as const,
        agentName: null,
        userId: 'u1',
        displayName: 'Alice',
        roleDesc: '',
      },
    ],
  }

  test('mentionQueryAt finds the @token under the caret', () => {
    expect(mentionQueryAt('ping @Wo', 8)).toEqual({ start: 5, query: 'Wo' })
    expect(mentionQueryAt('ping @', 6)).toEqual({ start: 5, query: '' })
    // Caret in the middle of the text still completes the token before it.
    expect(mentionQueryAt('@Wo tail', 3)).toEqual({ start: 0, query: 'Wo' })
  })

  test('mentionQueryAt returns null once the token terminated (space / comma / @)', () => {
    expect(mentionQueryAt('no mention here', 15)).toBeNull()
    expect(mentionQueryAt('@Worker done', 12)).toBeNull()
    expect(mentionQueryAt('@a,b', 4)).toBeNull()
  })

  test('mentionCandidates: prefix matches first (case-insensitive), then substring', () => {
    expect(mentionCandidates(config, 'w').map((m) => m.displayName)).toEqual(['Worker', 'Watcher'])
    expect(mentionCandidates(config, 'lic').map((m) => m.displayName)).toEqual(['Alice'])
    // Empty query (just typed '@') offers the whole roster.
    expect(mentionCandidates(config, '').map((m) => m.displayName)).toEqual([
      'Worker',
      'Watcher',
      'Alice',
    ])
    expect(mentionCandidates(config, 'zzz')).toEqual([])
  })

  test('applyMention replaces the in-progress token and reports the new caret', () => {
    const ctx = mentionQueryAt('ping @Wo tail', 8)!
    const next = applyMention('ping @Wo tail', 8, ctx, 'Worker')
    expect(next.text).toBe('ping @Worker  tail')
    expect(next.caret).toBe('ping @Worker '.length)
  })
})

// ---------------------------------------------------------------------------
// PR-5 — delivery / fc-list oracles
// ---------------------------------------------------------------------------

describe('isHumanDeliveryCard', () => {
  const members = new Map([
    ['mem_h', { memberType: 'human' as const }],
    ['mem_a', { memberType: 'agent' as const }],
  ])

  test('human assignee + dispatched → to-do form', () => {
    expect(isHumanDeliveryCard(card({ id: 'x', assigneeMemberId: 'mem_h' }), members)).toBe(true)
  })

  test('agent assignee / other statuses / unknown member → plain card', () => {
    expect(isHumanDeliveryCard(card({ id: 'x', assigneeMemberId: 'mem_a' }), members)).toBe(false)
    expect(
      isHumanDeliveryCard(
        card({ id: 'x', assigneeMemberId: 'mem_h', status: 'delivered' }),
        members,
      ),
    ).toBe(false)
    expect(
      isHumanDeliveryCard(card({ id: 'x', assigneeMemberId: 'mem_h', status: 'done' }), members),
    ).toBe(false)
    expect(isHumanDeliveryCard(card({ id: 'x', assigneeMemberId: null }), members)).toBe(false)
    expect(isHumanDeliveryCard(card({ id: 'x', assigneeMemberId: 'gone' }), members)).toBe(false)
  })
})

describe('buildDeliverBody (拍板 #16 双形态)', () => {
  test('quick reply → {body} (trimmed)', () => {
    expect(buildDeliverBody({ kind: 'quick', body: '  looks good  ' })).toEqual({
      body: 'looks good',
    })
  })

  test('form → {summary} with detail only when non-blank', () => {
    expect(buildDeliverBody({ kind: 'form', summary: ' ok ', detail: '' })).toEqual({
      summary: 'ok',
    })
    expect(buildDeliverBody({ kind: 'form', summary: 'ok', detail: '  ' })).toEqual({
      summary: 'ok',
    })
    expect(buildDeliverBody({ kind: 'form', summary: 'ok', detail: 'long text' })).toEqual({
      summary: 'ok',
      detail: 'long text',
    })
  })
})

describe('groupFcAssignments', () => {
  test('open / active(dispatched|running|awaiting_human) / done; the rest stay off-panel', () => {
    const rows = [
      card({ id: 'o', status: 'open' }),
      card({ id: 'd', status: 'dispatched' }),
      card({ id: 'r', status: 'running' }),
      card({ id: 'ah', status: 'awaiting_human' }),
      card({ id: 'dn', status: 'done' }),
      card({ id: 'dl', status: 'delivered' }),
      card({ id: 'f', status: 'failed' }),
      card({ id: 'c', status: 'canceled' }),
    ]
    const groups = groupFcAssignments(rows)
    expect(groups.open.map((a) => a.id)).toEqual(['o'])
    expect(groups.active.map((a) => a.id)).toEqual(['d', 'r', 'ah'])
    expect(groups.done.map((a) => a.id)).toEqual(['dn'])
  })
})

// ---------------------------------------------------------------------------
// RFC-174 — composer keyboard oracle (modifier discipline is the focus)
// ---------------------------------------------------------------------------

describe('resolveComposerKey', () => {
  // A key event with everything cleared; each test overrides only what it needs.
  function key(over: Partial<ComposerKeyState> & Pick<ComposerKeyState, 'key'>): ComposerKeyState {
    return {
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      isComposing: false,
      mentionOpen: false,
      candidateCount: 0,
      activeIndex: 0,
      ...over,
    }
  }
  const open = { mentionOpen: true, candidateCount: 3, activeIndex: 1 }

  test('IME composing → default for every key (send chord and mention keys included)', () => {
    expect(resolveComposerKey(key({ key: 'Enter', ctrlKey: true, isComposing: true }))).toEqual({
      type: 'default',
    })
    expect(resolveComposerKey(key({ key: 'Enter', metaKey: true, isComposing: true }))).toEqual({
      type: 'default',
    })
    expect(resolveComposerKey(key({ key: 'ArrowDown', isComposing: true, ...open }))).toEqual({
      type: 'default',
    })
  })

  test('send chord (dropdown closed): Enter + Cmd OR Ctrl, no Shift/Alt', () => {
    expect(resolveComposerKey(key({ key: 'Enter', metaKey: true }))).toEqual({ type: 'send' })
    expect(resolveComposerKey(key({ key: 'Enter', ctrlKey: true }))).toEqual({ type: 'send' })
    // Shift/Alt on the chord → not a send (falls through to newline).
    expect(resolveComposerKey(key({ key: 'Enter', ctrlKey: true, shiftKey: true }))).toEqual({
      type: 'default',
    })
    expect(resolveComposerKey(key({ key: 'Enter', metaKey: true, altKey: true }))).toEqual({
      type: 'default',
    })
  })

  test('plain Enter (dropdown closed) → default (newline, never send)', () => {
    expect(resolveComposerKey(key({ key: 'Enter' }))).toEqual({ type: 'default' })
    expect(resolveComposerKey(key({ key: 'Enter', shiftKey: true }))).toEqual({ type: 'default' })
    expect(resolveComposerKey(key({ key: 'a' }))).toEqual({ type: 'default' })
  })

  test('dropdown open: Cmd/Ctrl+Enter COMMITS the candidate, does not send', () => {
    expect(resolveComposerKey(key({ key: 'Enter', ctrlKey: true, ...open }))).toEqual({
      type: 'mention-commit',
      index: 1,
    })
    expect(resolveComposerKey(key({ key: 'Enter', metaKey: true, ...open }))).toEqual({
      type: 'mention-commit',
      index: 1,
    })
  })

  test('dropdown open: Arrow navigation wraps, only with no modifiers', () => {
    // activeIndex 1 of 3: down → 2, up → 0.
    expect(resolveComposerKey(key({ key: 'ArrowDown', ...open }))).toEqual({
      type: 'mention-move',
      index: 2,
    })
    expect(resolveComposerKey(key({ key: 'ArrowUp', ...open }))).toEqual({
      type: 'mention-move',
      index: 0,
    })
    // wrap: last → first, first → last.
    expect(
      resolveComposerKey(
        key({ key: 'ArrowDown', mentionOpen: true, candidateCount: 3, activeIndex: 2 }),
      ),
    ).toEqual({ type: 'mention-move', index: 0 })
    expect(
      resolveComposerKey(
        key({ key: 'ArrowUp', mentionOpen: true, candidateCount: 3, activeIndex: 0 }),
      ),
    ).toEqual({ type: 'mention-move', index: 2 })
    // modifiers → not hijacked (Shift+Arrow selection, Cmd+Arrow line-end).
    expect(resolveComposerKey(key({ key: 'ArrowDown', shiftKey: true, ...open }))).toEqual({
      type: 'default',
    })
    expect(resolveComposerKey(key({ key: 'ArrowUp', metaKey: true, ...open }))).toEqual({
      type: 'default',
    })
  })

  test('dropdown open: Enter/Tab commit the active index; Shift+Enter, Ctrl+Tab, Shift+Tab do not', () => {
    expect(resolveComposerKey(key({ key: 'Enter', ...open }))).toEqual({
      type: 'mention-commit',
      index: 1,
    })
    expect(resolveComposerKey(key({ key: 'Tab', ...open }))).toEqual({
      type: 'mention-commit',
      index: 1,
    })
    expect(resolveComposerKey(key({ key: 'Enter', shiftKey: true, ...open }))).toEqual({
      type: 'default',
    })
    expect(resolveComposerKey(key({ key: 'Enter', altKey: true, ...open }))).toEqual({
      type: 'default',
    })
    expect(resolveComposerKey(key({ key: 'Tab', ctrlKey: true, ...open }))).toEqual({
      type: 'default',
    })
    expect(resolveComposerKey(key({ key: 'Tab', shiftKey: true, ...open }))).toEqual({
      type: 'default',
    })
  })

  test('dropdown open: Escape closes (no modifiers)', () => {
    expect(resolveComposerKey(key({ key: 'Escape', ...open }))).toEqual({ type: 'mention-close' })
    expect(resolveComposerKey(key({ key: 'Escape', ctrlKey: true, ...open }))).toEqual({
      type: 'default',
    })
  })

  test('mentionOpen with zero candidates falls through to send/default (guards deref)', () => {
    expect(
      resolveComposerKey(
        key({ key: 'Enter', ctrlKey: true, mentionOpen: true, candidateCount: 0 }),
      ),
    ).toEqual({ type: 'send' })
    expect(
      resolveComposerKey(key({ key: 'ArrowDown', mentionOpen: true, candidateCount: 0 })),
    ).toEqual({ type: 'default' })
  })
})

describe('sendChordModLabel', () => {
  test('non-mac (happy-dom default) → Ctrl', () => {
    expect(sendChordModLabel()).toBe('Ctrl')
  })

  test('mac platform → ⌘', () => {
    const orig = Object.getOwnPropertyDescriptor(navigator, 'platform')
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
    try {
      expect(sendChordModLabel()).toBe('⌘')
    } finally {
      if (orig !== undefined) Object.defineProperty(navigator, 'platform', orig)
      else Object.defineProperty(navigator, 'platform', { value: '', configurable: true })
    }
  })
})

describe('RFC-179 executing indicators', () => {
  const members = [
    { id: 'lead', displayName: 'Lead' },
    { id: 'a1', displayName: 'Coder' },
    { id: 'a2', displayName: 'Rev' },
  ]
  const run = (over: Partial<WorkgroupMemberCurrentRun>): WorkgroupMemberCurrentRun => ({
    nodeRunId: 'r',
    status: 'running',
    kind: 'message-turn',
    triggerMessageId: null,
    ...over,
  })

  test('memberExecuting: running only', () => {
    expect(memberExecuting(run({ status: 'running' }))).toBe(true)
    expect(memberExecuting(run({ status: 'done' }))).toBe(false)
    expect(memberExecuting(null)).toBe(false)
  })

  // RFC-182 D8 —— streamActiveExecutions（跑完即消失的合成活跃行）被持久回合卡
  // 取代：leader 轮/降级被@轮成为 standalone timeline 条目，永不消失。
  test('standaloneTurnEntries: leader 轮全收 + 无 trigger 的被@轮降级收，assignment 不收', () => {
    const entry = (over: Partial<WorkgroupRunEntry>): WorkgroupRunEntry => ({
      nodeRunId: 'R1',
      memberId: 'a1',
      displayName: 'Coder',
      kind: 'message-turn',
      status: 'done',
      round: null,
      startedAt: null,
      finishedAt: null,
      triggerMessageId: null,
      assignmentId: null,
      note: null,
      ...over,
    })
    const history = [
      entry({ nodeRunId: 'L1', kind: 'leader-round', round: 1 }),
      entry({ nodeRunId: 'M1', kind: 'message-turn', triggerMessageId: 'MSG1' }),
      entry({ nodeRunId: 'M2', kind: 'message-turn', triggerMessageId: null }),
      entry({ nodeRunId: 'A1', kind: 'assignment', assignmentId: 'ASG1' }),
    ]
    expect(standaloneTurnEntries(history).map((e) => e.nodeRunId)).toEqual(['L1', 'M2'])
    expect(turnCardsForMessage(history, 'MSG1').map((e) => e.nodeRunId)).toEqual(['M1'])
    expect(turnCardsForMessage(history, 'MSG9')).toEqual([])
  })

  test('mentionExecutingPills: triggerMessageId → running message-turn members', () => {
    const memberRuns = {
      a1: run({ kind: 'message-turn', status: 'running', triggerMessageId: 'MSG4' }),
      a2: run({ kind: 'message-turn', status: 'running', triggerMessageId: 'MSG4' }),
      lead: run({ kind: 'message-turn', status: 'done', triggerMessageId: 'MSG4' }), // terminal → out
    }
    expect(mentionExecutingPills(members, memberRuns).get('MSG4')).toEqual([
      { displayName: 'Coder', nodeRunId: 'r' },
      { displayName: 'Rev', nodeRunId: 'r' },
    ])
  })

  test('mentionExecutingPills: assignment / no-trigger runs produce no pill', () => {
    const memberRuns = {
      a1: run({ kind: 'assignment', status: 'running', triggerMessageId: 'MSG1' }),
      a2: run({ kind: 'message-turn', status: 'running', triggerMessageId: null }),
    }
    expect(mentionExecutingPills(members, memberRuns).size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// RFC-185 —— fan-out 并发规模数据预言（countMemberActiveRuns）：leader 对同一
// 成员并发派 N 单时，presence 单值投影不反映规模。双源计数（Codex 实现门 P2
// 折入）：assignment 实例按 assignment 行（dispatched/running/awaiting_human）
// —— 覆盖 merge-back 窗口（run 行先落 done、assignment 等 merge 归来才 done）
// 与未 mint 的 dispatched 排队窗口；leader 轮/被 @ 轮按非终态 run；assignment
// 类 run 跳过防双计。
// ---------------------------------------------------------------------------

describe('RFC-185 countMemberActiveRuns', () => {
  const entry = (over: Partial<WorkgroupRunEntry>): WorkgroupRunEntry => ({
    nodeRunId: '01R',
    memberId: 'a1',
    displayName: 'Coder',
    kind: 'assignment',
    status: 'running',
    round: null,
    startedAt: null,
    finishedAt: null,
    triggerMessageId: null,
    assignmentId: 'ASG',
    note: null,
    ...over,
  })

  test('assignment instances count by ASSIGNMENT status — merge-back window stays visible', () => {
    const history = [
      // merge-back pending: the run row is already done while its assignment
      // is still running — must NOT drop out of the badge (Codex P2).
      entry({ nodeRunId: 'R1', status: 'done', assignmentId: 'A1' }),
      // a live assignment run — skipped here, counted via its assignment row.
      entry({ nodeRunId: 'R2', status: 'running', assignmentId: 'A2' }),
    ]
    const assignments = [
      { assigneeMemberId: 'a1', status: 'running' as const }, // R1's — merging
      { assigneeMemberId: 'a1', status: 'dispatched' as const }, // queued, no run yet
      { assigneeMemberId: 'a1', status: 'awaiting_human' as const }, // clarify park
      { assigneeMemberId: 'a1', status: 'done' as const }, // terminal — out
      { assigneeMemberId: 'a2', status: 'running' as const }, // someone else
    ]
    expect(countMemberActiveRuns(history, assignments, 'a1')).toBe(3)
    expect(countMemberActiveRuns(history, assignments, 'a2')).toBe(1)
    expect(countMemberActiveRuns(history, assignments, 'lead')).toBe(0)
  })

  test('non-assignment turns count by run; assignment-kind runs never double-count', () => {
    const history = [
      entry({ nodeRunId: 'L1', kind: 'leader-round', memberId: 'lead', status: 'running' }),
      entry({ nodeRunId: 'M1', kind: 'message-turn', memberId: 'lead', status: 'pending' }),
      entry({ nodeRunId: 'M2', kind: 'message-turn', memberId: 'lead', status: 'done' }), // terminal — out
      entry({ nodeRunId: 'A1', kind: 'assignment', memberId: 'a1', status: 'running' }),
    ]
    expect(countMemberActiveRuns(history, [], 'lead')).toBe(2)
    // an assignment-kind run with no assignment row contributes nothing —
    // the assignment row is the single counting authority for instances.
    expect(countMemberActiveRuns(history, [], 'a1')).toBe(0)
    expect(countMemberActiveRuns([], [], 'a1')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// RFC-182 —— timeline interleave（round-aware leader 卡 + ULID 降级 + tail）
// 与时间/耗时纯函数。
// ---------------------------------------------------------------------------

describe('RFC-182 timeline interleave + time helpers', () => {
  const turn = (over: Partial<WorkgroupRunEntry>): WorkgroupRunEntry => ({
    nodeRunId: '01Z',
    memberId: 'lead',
    displayName: 'Lead',
    kind: 'leader-round',
    status: 'done',
    round: 1,
    startedAt: null,
    finishedAt: null,
    triggerMessageId: null,
    assignmentId: null,
    note: null,
    ...over,
  })
  const flat = (entries: ReturnType<typeof buildRoomTimeline>): string[] =>
    entries.map((e) =>
      e.type === 'round'
        ? `round:${e.round}`
        : e.type === 'turn'
          ? `turn:${e.entry.nodeRunId}`
          : e.message.id,
    )

  test('leader 卡 round-aware：落在本轮分隔之后（leader run 先于本轮产出 mint，纯 ULID 会插错轮）', () => {
    const timeline = buildRoomTimeline(
      [msg({ id: '01B', round: 1 }), msg({ id: '01D', round: 2 })],
      // L1 的 ULID 小于 01B（先 mint），但属于 round 1 → 必须在 round:1 分隔后。
      [turn({ nodeRunId: '01A', round: 1 }), turn({ nodeRunId: '01C', round: 2 })],
    )
    expect(flat(timeline)).toEqual(['round:1', 'turn:01A', '01B', 'round:2', 'turn:01C', '01D'])
  })

  test('分隔未出现的轮（leader 正在思考）→ 卡落尾部', () => {
    const timeline = buildRoomTimeline(
      [msg({ id: '01B', round: 1 })],
      [turn({ nodeRunId: '01C', round: 2 })],
    )
    expect(flat(timeline)).toEqual(['round:1', '01B', 'turn:01C'])
  })

  test('round=null 的降级被@卡按 ULID 插入', () => {
    const timeline = buildRoomTimeline(
      [msg({ id: '01B', round: 0 }), msg({ id: '01F', round: 0 })],
      [turn({ nodeRunId: '01D', kind: 'message-turn', round: null })],
    )
    expect(flat(timeline)).toEqual(['01B', 'turn:01D', '01F'])
  })

  test('formatRoomTimestamp：同日 HH:mm:ss，跨日带 M/D', () => {
    const now = new Date(2026, 6, 14, 10, 0, 0).getTime()
    const sameDay = new Date(2026, 6, 14, 9, 5, 7).getTime()
    const otherDay = new Date(2026, 6, 13, 22, 30, 0).getTime()
    expect(formatRoomTimestamp(sameDay, now)).toBe('09:05:07')
    expect(formatRoomTimestamp(otherDay, now)).toBe('7/13 22:30')
  })

  test('turnDurationMs / formatTurnDuration：running 走 now，终态定格，缺 startedAt → null', () => {
    const e = turn({ startedAt: 1_000, finishedAt: null, status: 'running' })
    expect(turnDurationMs(e, 66_000)).toBe(65_000)
    expect(turnDurationMs(turn({ startedAt: 1_000, finishedAt: 31_000 }), 999_999)).toBe(30_000)
    expect(turnDurationMs(turn({ startedAt: null }), 5_000)).toBeNull()
    expect(formatTurnDuration(65_000)).toBe('01:05')
    expect(formatTurnDuration(3_725_000)).toBe('1:02:05')
  })

  // 2026-07-14 用户拍板「给所有正在执行的 agent 加计时」——DispatchCard 计时
  // 走 assignment.nodeRunId → runHistory 索引关联（Map 一次构建、每 tick O(1)
  // 查找——Codex 实现门 finding），语义与 turnDurationMs 一致。
  test('assignmentDurationMs：关联 run 计时；无 nodeRunId / 索引缺条目 → null', () => {
    const index = indexRunHistory([
      turn({ nodeRunId: 'nrA', kind: 'assignment', startedAt: 1_000, finishedAt: null }),
      turn({ nodeRunId: 'nrB', kind: 'assignment', startedAt: 1_000, finishedAt: 31_000 }),
    ])
    expect(index.size).toBe(2)
    expect(assignmentDurationMs(index, 'nrA', 66_000)).toBe(65_000) // running 走 now
    expect(assignmentDurationMs(index, 'nrB', 999_999)).toBe(30_000) // 终态定格
    expect(assignmentDurationMs(index, null, 66_000)).toBeNull() // human to-do 卡无 run
    expect(assignmentDurationMs(index, 'nrGone', 66_000)).toBeNull() // refetch gap
    expect(
      assignmentDurationMs(
        indexRunHistory([turn({ nodeRunId: 'nrC', startedAt: null })]),
        'nrC',
        66_000,
      ),
    ).toBeNull() // pending（未起跑）→ em-dash
  })
})

describe('RFC-217 T5 — fc round 对外显式 null', () => {
  test('round:null 的消息不产生分隔线、不进水位线（fc 无波次语义的显式形态）', () => {
    const timeline = buildRoomTimeline(
      [msg({ id: '01A', round: null }), msg({ id: '01B', round: null })],
      [],
      { dividers: false },
    )
    expect(timeline.filter((e) => e.type === 'round')).toHaveLength(0)
  })

  test('lw 混入 null（防御位）不打断既有水位线', () => {
    const timeline = buildRoomTimeline(
      [msg({ id: '01A', round: 1 }), msg({ id: '01B', round: null }), msg({ id: '01C', round: 2 })],
      [],
    )
    const rounds = timeline.filter((e) => e.type === 'round')
    expect(rounds.map((r) => (r.type === 'round' ? r.round : -1))).toEqual([1, 2])
  })
})
