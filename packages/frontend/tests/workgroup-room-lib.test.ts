// RFC-164 PR-4 — pure-function coverage for the chat room's data oracles
// (lib/workgroup-room): timeline round separators, dispatch-card joins
// (leader direct-id link vs human multi-@ same-instant join), @-mention
// completion, composer gating and status → chip-kind mapping. The rendered
// behaviors sit in workgroup-room.test.tsx; this file locks the branches
// without a DOM.

import { describe, expect, test } from 'vitest'
import {
  WORKGROUP_ASSIGNMENT_STATUS_KIND,
  applyMention,
  assignmentStatusToKind,
  assignmentsForMessage,
  buildDeliverBody,
  buildRoomTimeline,
  canPostRoomMessage,
  groupFcAssignments,
  isAssignmentCancelable,
  isHumanDeliveryCard,
  memberIsWorking,
  mentionCandidates,
  mentionQueryAt,
  resultBodyFor,
  workgroupRoomKey,
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
    expect(timeline.map((e) => (e.type === 'round' ? `round:${e.round}` : e.message.id))).toEqual([
      '01A',
      'round:1',
      '01B',
      '01C',
      'round:2',
      '01D',
    ])
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

  test('memberIsWorking: running|dispatched cards mark the assignee busy', () => {
    const cards = [
      card({ id: 'a1', assigneeMemberId: 'mem_2', status: 'running' }),
      card({ id: 'a2', assigneeMemberId: 'mem_3', status: 'done' }),
    ]
    expect(memberIsWorking('mem_2', cards)).toBe(true)
    expect(memberIsWorking('mem_3', cards)).toBe(false)
    expect(memberIsWorking('mem_4', cards)).toBe(false)
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
