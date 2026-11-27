// RFC-616 (design/RFC-616-process-metrics/design.md §3.3, §14 "房间投影回归"):
// the rule that attributes a workgroup host run to a member moved out of the
// task room's projection into shared (`packages/shared/src/workgroupHostRun.ts`)
// so process metrics can read the same rule. The room's run history must come
// out exactly as before the move. This file protects that in two ways:
//   1. every branch of the rule, with the full history entry spelled out;
//   2. a sweep over every combination of host-run identity, compared with a
//      frozen copy of the rule as it stood in the projection before the move
//      (commit 26c56a6ee, the last one that touched it).
import { describe, expect, test } from 'bun:test'
import {
  WORKGROUP_TURN_CLARIFY_NODE_ID,
  WORKGROUP_TURN_LEADER_NODE_ID,
  WORKGROUP_TURN_MEMBER_NODE_ID,
  buildBatchShardKey,
  buildMsgShardKey,
  parseBatchShardKey,
  parseMsgShardKey,
  type WorkgroupRunEntry,
  type WorkgroupRunKind,
} from '@agent-workflow/shared'
import {
  deriveWorkgroupRunHistory,
  resolveMessageTurnTriggerId,
  type WorkgroupRoomAssignment,
  type WorkgroupRoomHostRun,
  type WorkgroupRoomMember,
  type WorkgroupRoomMessage,
} from '@/modules/resource-catalog/application/workgroups/workgroupRoomProjection'

const LEAD = 'm-lead'
const CODER = 'm-coder'
const TWIN_A = 'm-twin-a'
const TWIN_B = 'm-twin-b'
const HUMAN = 'm-human'

const members: WorkgroupRoomMember[] = [
  { id: LEAD, memberType: 'agent', displayName: 'lead', agentId: 'agent-lead' },
  { id: CODER, memberType: 'agent', displayName: 'coder', agentId: 'agent-coder' },
  // Two members running the same agent: a single-card run cannot tell them apart.
  { id: TWIN_A, memberType: 'agent', displayName: 'twin-a', agentId: 'agent-twin' },
  { id: TWIN_B, memberType: 'agent', displayName: 'twin-b', agentId: 'agent-twin' },
  { id: HUMAN, memberType: 'human', displayName: 'pm' },
]

const assignments: WorkgroupRoomAssignment[] = [
  // The card was handed to another member after its run: the run keeps its attribution.
  { id: 'card-coder', assigneeMemberId: TWIN_A },
  { id: 'card-twin', assigneeMemberId: TWIN_A },
]

const messages: WorkgroupRoomMessage[] = [
  { id: 'msg-1', mentionMemberIds: [CODER], authorMemberId: LEAD, round: 1 },
  { id: 'msg-2', mentionMemberIds: [CODER], authorMemberId: LEAD, round: 2 },
  { id: 'msg-3', mentionMemberIds: [CODER], authorMemberId: LEAD, round: 2 },
]

function hostRun(
  sequence: number,
  id: string,
  fields: Partial<Omit<WorkgroupRoomHostRun, 'selection' | 'seq' | 'id'>> &
    Pick<WorkgroupRoomHostRun, 'nodeId'>,
): WorkgroupRoomHostRun {
  return {
    selection: { sequence, legacyGroupCurrent: true },
    seq: sequence,
    id,
    shardKey: null,
    status: 'done',
    rerunCause: null,
    ...fields,
  }
}

const batchKey = buildBatchShardKey(TWIN_B, ['card-twin', 'card-x'])

// Given out of mint order on purpose: the history is ordered by the run selection sequence.
const scenario: WorkgroupRoomHostRun[] = [
  hostRun(7, 'run-08', {
    nodeId: WORKGROUP_TURN_MEMBER_NODE_ID,
    shardKey: buildMsgShardKey('m-gone', ''),
    rerunCause: 'wg-message-turn',
  }),
  hostRun(0, 'run-01', {
    nodeId: WORKGROUP_TURN_LEADER_NODE_ID,
    rerunCause: 'wg-leader-round',
    wgRound: 1,
    startedAt: 100,
    finishedAt: 200,
    agentOverrideId: 'agent-lead',
  }),
  hostRun(1, 'run-02', {
    nodeId: WORKGROUP_TURN_MEMBER_NODE_ID,
    shardKey: 'card-coder',
    rerunCause: 'wg-assignment',
    agentOverrideId: 'agent-coder',
    startedAt: 210,
    finishedAt: 300,
  }),
  hostRun(2, 'run-03', {
    nodeId: WORKGROUP_TURN_MEMBER_NODE_ID,
    shardKey: 'card-twin',
    rerunCause: 'wg-assignment',
    agentOverrideId: 'agent-twin',
  }),
  hostRun(3, 'run-04', {
    nodeId: WORKGROUP_TURN_MEMBER_NODE_ID,
    shardKey: batchKey,
    rerunCause: 'wg-assignment',
    agentOverrideId: 'agent-twin',
  }),
  hostRun(4, 'run-05', {
    nodeId: WORKGROUP_TURN_MEMBER_NODE_ID,
    shardKey: buildMsgShardKey(CODER, 'msg-2'),
    rerunCause: 'wg-message-turn',
    status: 'running',
    startedAt: 310,
  }),
  hostRun(5, 'run-06', {
    nodeId: WORKGROUP_TURN_LEADER_NODE_ID,
    rerunCause: 'wg-gate',
    status: 'awaiting_review',
    wgRound: 1,
  }),
  hostRun(6, 'run-07', {
    nodeId: WORKGROUP_TURN_LEADER_NODE_ID,
    rerunCause: 'wg-protocol-retry',
  }),
  hostRun(8, 'run-09', {
    nodeId: WORKGROUP_TURN_MEMBER_NODE_ID,
    shardKey: 'card-coder',
    rerunCause: 'wg-protocol-retry',
    agentOverrideId: 'agent-coder',
    status: 'failed',
    failureCode: 'clarify-forbidden',
  }),
  hostRun(9, 'run-10', {
    nodeId: WORKGROUP_TURN_MEMBER_NODE_ID,
    shardKey: 'card-unknown',
    rerunCause: 'wg-assignment',
    agentOverrideId: 'agent-coder',
  }),
  hostRun(10, 'run-11', {
    nodeId: WORKGROUP_TURN_CLARIFY_NODE_ID,
    shardKey: 'card-coder',
    rerunCause: 'clarify-park',
    agentOverrideId: 'agent-coder',
  }),
]

function entry(
  fields: Pick<WorkgroupRunEntry, 'nodeRunId' | 'memberId' | 'kind'> & Partial<WorkgroupRunEntry>,
): WorkgroupRunEntry {
  return {
    displayName: null,
    status: 'done',
    round: null,
    startedAt: null,
    finishedAt: null,
    triggerMessageId: null,
    assignmentId: null,
    note: null,
    ...fields,
  }
}

describe('RFC-616 room run history: every branch of the attribution rule', () => {
  const history = deriveWorkgroupRunHistory(members, LEAD, scenario, assignments, messages, {
    openClarifySourceRunIds: new Set(['run-02']),
  })

  test('the whole history comes out entry for entry, in mint order', () => {
    expect(history).toEqual([
      entry({
        nodeRunId: 'run-01',
        memberId: LEAD,
        displayName: 'lead',
        kind: 'leader-round',
        round: 1,
        startedAt: 100,
        finishedAt: 200,
      }),
      entry({
        nodeRunId: 'run-02',
        memberId: CODER,
        displayName: 'coder',
        kind: 'assignment',
        // The run asked a question that is still open.
        status: 'awaiting_human',
        startedAt: 210,
        finishedAt: 300,
        assignmentId: 'card-coder',
      }),
      entry({
        nodeRunId: 'run-04',
        memberId: TWIN_B,
        displayName: 'twin-b',
        kind: 'assignment',
        assignmentId: batchKey,
      }),
      entry({
        nodeRunId: 'run-05',
        memberId: CODER,
        displayName: 'coder',
        kind: 'message-turn',
        status: 'running',
        startedAt: 310,
        triggerMessageId: 'msg-2',
      }),
      entry({
        nodeRunId: 'run-07',
        memberId: LEAD,
        displayName: 'lead',
        kind: 'leader-round',
        // No stamped round: one past the highest round among the messages before it.
        round: 3,
      }),
      entry({ nodeRunId: 'run-08', memberId: 'm-gone', kind: 'message-turn' }),
      entry({
        nodeRunId: 'run-09',
        memberId: CODER,
        displayName: 'coder',
        kind: 'assignment',
        status: 'failed',
        assignmentId: 'card-coder',
        note: 'clarify-suppressed',
      }),
    ])
  })

  test('a leader round belongs to the leader', () => {
    expect(history.find((item) => item.nodeRunId === 'run-01')).toMatchObject({
      kind: 'leader-round',
      memberId: LEAD,
    })
  })

  test('a message turn takes its member from the msg key', () => {
    expect(history.find((item) => item.nodeRunId === 'run-05')).toMatchObject({
      kind: 'message-turn',
      memberId: CODER,
    })
    // The key names the member even after the member left the roster.
    expect(history.find((item) => item.nodeRunId === 'run-08')).toMatchObject({
      memberId: 'm-gone',
      displayName: null,
    })
  })

  test('a batch takes its member from the batch key, not from its shared agent', () => {
    expect(history.find((item) => item.nodeRunId === 'run-04')).toMatchObject({
      kind: 'assignment',
      memberId: TWIN_B,
    })
  })

  test('a single-card run goes to the one member using its agent, not to the card assignee', () => {
    expect(history.find((item) => item.nodeRunId === 'run-02')).toMatchObject({
      kind: 'assignment',
      memberId: CODER,
    })
  })

  test('a single-card run whose agent two members share is dropped', () => {
    expect(history.some((item) => item.nodeRunId === 'run-03')).toBe(false)
  })

  test('the completion-gate holder on the leader node is dropped', () => {
    expect(history.some((item) => item.nodeRunId === 'run-06')).toBe(false)
  })

  test('runs that are not a turn are dropped', () => {
    expect(history.some((item) => item.nodeRunId === 'run-10')).toBe(false)
    expect(history.some((item) => item.nodeRunId === 'run-11')).toBe(false)
  })

  test('without a leader the leader rounds are dropped and nothing else changes', () => {
    const leaderless = deriveWorkgroupRunHistory(members, null, scenario, assignments, messages)
    expect(leaderless.map((item) => item.nodeRunId)).toEqual([
      'run-02',
      'run-04',
      'run-05',
      'run-08',
      'run-09',
    ])
  })
})

// ---------------------------------------------------------------------------
// The rule as it stood inside workgroupRoomProjection.ts before RFC-616, copied
// verbatim (only renamed). It is the oracle of the sweep below and must not be
// "kept in sync" with the shared rule: a difference between the two is the
// regression this file exists to report.
// ---------------------------------------------------------------------------

function frozenRunKindOf(
  run: WorkgroupRoomHostRun,
  assignmentIds: ReadonlySet<string>,
): WorkgroupRunKind | null {
  if (run.nodeId === WORKGROUP_TURN_LEADER_NODE_ID) {
    return run.rerunCause === 'wg-gate' ? null : 'leader-round'
  }
  if (run.nodeId === WORKGROUP_TURN_MEMBER_NODE_ID && run.shardKey !== null) {
    if (parseMsgShardKey(run.shardKey) !== null) return 'message-turn'
    if (assignmentIds.has(run.shardKey)) return 'assignment'
    if (parseBatchShardKey(run.shardKey) !== null) return 'assignment'
  }
  return null
}

interface FrozenClassification {
  readonly kind: WorkgroupRunKind
  readonly memberId: string
  readonly maxMsgId: string | null
}

function frozenClassify(
  run: WorkgroupRoomHostRun,
  leaderMemberId: string | null,
  assignmentIds: ReadonlySet<string>,
  uniqueAgentMemberById: ReadonlyMap<string, string | null>,
): FrozenClassification | null {
  const kind = frozenRunKindOf(run, assignmentIds)
  if (kind === null) return null
  if (kind === 'leader-round') {
    if (leaderMemberId === null) return null
    return { kind, memberId: leaderMemberId, maxMsgId: null }
  }
  if (kind === 'assignment') {
    const viaBatch = parseBatchShardKey(run.shardKey)?.memberId ?? null
    const viaAgent =
      run.agentOverrideId != null ? (uniqueAgentMemberById.get(run.agentOverrideId) ?? null) : null
    const memberId = viaBatch ?? viaAgent
    if (memberId === null) return null
    return { kind, memberId, maxMsgId: null }
  }

  const parsed = run.shardKey === null ? null : parseMsgShardKey(run.shardKey)
  if (parsed === null || parsed.memberId.length === 0) return null
  return { kind, memberId: parsed.memberId, maxMsgId: parsed.maxMessageId }
}

function frozenUniqueAgentMembers(
  roster: readonly WorkgroupRoomMember[],
): Map<string, string | null> {
  const uniqueAgentMemberById = new Map<string, string | null>()
  for (const member of roster) {
    if (member.memberType !== 'agent' || member.agentId == null) continue
    uniqueAgentMemberById.set(
      member.agentId,
      uniqueAgentMemberById.has(member.agentId) ? null : member.id,
    )
  }
  return uniqueAgentMemberById
}

describe('RFC-616 room run history: same attribution as the rule it replaced', () => {
  const nodeIds = [
    WORKGROUP_TURN_LEADER_NODE_ID,
    WORKGROUP_TURN_MEMBER_NODE_ID,
    WORKGROUP_TURN_CLARIFY_NODE_ID,
    'agent-node',
  ]
  const shardKeys = [
    null,
    'card-coder',
    'card-twin',
    'card-unknown',
    buildMsgShardKey(CODER, 'msg-2'),
    buildMsgShardKey(CODER, ''),
    buildMsgShardKey('m-gone', 'msg-3'),
    'msg::msg-2',
    buildBatchShardKey(CODER, ['card-coder']),
    buildBatchShardKey(TWIN_A, ['card-twin', 'card-x']),
    buildBatchShardKey('m-gone', ['card-x']),
    'batch:',
    `batch:${CODER}:`,
  ]
  const rerunCauses = [
    'wg-leader-round',
    'wg-assignment',
    'wg-message-turn',
    'wg-gate',
    'wg-protocol-retry',
    'clarify-answer',
    null,
  ]
  const agentOverrideIds = [undefined, null, 'agent-lead', 'agent-coder', 'agent-twin', 'agent-x']

  const sweep: WorkgroupRoomHostRun[] = []
  for (const nodeId of nodeIds)
    for (const shardKey of shardKeys)
      for (const rerunCause of rerunCauses)
        for (const agentOverrideId of agentOverrideIds)
          sweep.push(
            hostRun(sweep.length, `sweep-${String(sweep.length).padStart(5, '0')}`, {
              nodeId,
              shardKey,
              rerunCause,
              agentOverrideId,
            }),
          )

  /** What the room history says about attribution, one tuple per entry. */
  const attributionOf = (history: readonly WorkgroupRunEntry[]) =>
    history.map((item) => [
      item.nodeRunId,
      item.kind,
      item.memberId,
      item.assignmentId,
      item.triggerMessageId,
    ])

  test.each([
    ['with a leader', LEAD],
    ['without a leader', null],
  ])('every combination of node, shard key, cause and agent %s', (_name, leaderMemberId) => {
    const assignmentIds = new Set(assignments.map((assignment) => assignment.id))
    const uniqueAgentMemberById = frozenUniqueAgentMembers(members)
    const expected = sweep.flatMap((run) => {
      const frozen = frozenClassify(run, leaderMemberId, assignmentIds, uniqueAgentMemberById)
      if (frozen === null) return []
      return [
        [
          run.id,
          frozen.kind,
          frozen.memberId,
          frozen.kind === 'assignment' ? run.shardKey : null,
          frozen.kind === 'message-turn'
            ? resolveMessageTurnTriggerId(frozen.memberId, frozen.maxMsgId, messages)
            : null,
        ],
      ]
    })

    expect(
      attributionOf(
        deriveWorkgroupRunHistory(members, leaderMemberId, sweep, assignments, messages),
      ),
    ).toEqual(expected)

    // The sweep must exercise the rule, not agree on an empty history.
    const kinds = new Set(expected.map((item) => item[1]))
    expect(kinds).toEqual(
      new Set(
        leaderMemberId === null
          ? ['assignment', 'message-turn']
          : ['leader-round', 'assignment', 'message-turn'],
      ),
    )
    expect(expected.length).toBeGreaterThan(100)
    expect(expected.length).toBeLessThan(sweep.length)
  })
})
