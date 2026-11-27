// RFC-616 (design/RFC-616-process-metrics/design.md §3.3, §6.2): the rule that
// says which member a workgroup host run belongs to. It was lifted out of the
// task room's projection so the room history and the process metrics read one
// rule; this file protects that rule on its own:
//   - a leader node run is the leader's round, except the completion-gate holder;
//   - a message turn and a task batch name their member in the shard key;
//   - a single-card run is attributed through the agent it executed with, and
//     only when exactly one member uses that agent;
//   - an assignment's current assignee never takes part (a card can be reassigned,
//     a run cannot change who executed it).
import { describe, expect, test } from 'bun:test'
import { buildBatchShardKey, buildMsgShardKey } from '../src/schemas/workgroup'
import {
  WORKGROUP_TURN_CLARIFY_NODE_ID,
  WORKGROUP_TURN_LEADER_NODE_ID,
  WORKGROUP_TURN_MEMBER_NODE_ID,
} from '../src/workgroupHostIdentity'
import {
  attributeWorkgroupHostRun,
  uniqueAgentMembersOf,
  workgroupHostRunKindOf,
  type WorkgroupHostRunIdentity,
  type WorkgroupHostRunRoster,
} from '../src/workgroupHostRun'

const LEADER = 'm-leader'
const CODER = 'm-coder'
const TWIN_A = 'm-twin-a'
const TWIN_B = 'm-twin-b'
const HUMAN = 'm-human'
const CARD = 'card-1'

const members = [
  { id: LEADER, memberType: 'agent' as const, agentId: 'agent-lead' },
  { id: CODER, memberType: 'agent' as const, agentId: 'agent-coder' },
  // Two members running the same agent.
  { id: TWIN_A, memberType: 'agent' as const, agentId: 'agent-twin' },
  { id: TWIN_B, memberType: 'agent' as const, agentId: 'agent-twin' },
  { id: HUMAN, memberType: 'human' as const },
]

const roster: WorkgroupHostRunRoster = {
  leaderMemberId: LEADER,
  assignmentIds: new Set([CARD]),
  uniqueAgentMemberById: uniqueAgentMembersOf(members),
}

function leaderRun(rerunCause: string | null = 'wg-leader-round'): WorkgroupHostRunIdentity {
  return { nodeId: WORKGROUP_TURN_LEADER_NODE_ID, shardKey: null, rerunCause }
}

function memberRun(
  shardKey: string | null,
  agentOverrideId?: string | null,
  rerunCause: string | null = 'wg-assignment',
): WorkgroupHostRunIdentity {
  return { nodeId: WORKGROUP_TURN_MEMBER_NODE_ID, shardKey, rerunCause, agentOverrideId }
}

describe('RFC-616 uniqueAgentMembersOf', () => {
  test('an agent used by one member maps to that member', () => {
    const unique = uniqueAgentMembersOf(members)
    expect(unique.get('agent-lead')).toBe(LEADER)
    expect(unique.get('agent-coder')).toBe(CODER)
  })

  test('an agent shared by several members maps to null, however many share it', () => {
    expect(uniqueAgentMembersOf(members).get('agent-twin')).toBeNull()
    const three = uniqueAgentMembersOf([
      { id: 'a', memberType: 'agent', agentId: 'shared' },
      { id: 'b', memberType: 'agent', agentId: 'shared' },
      { id: 'c', memberType: 'agent', agentId: 'shared' },
    ])
    // The third member must not flip the entry back to a member id.
    expect([...three]).toEqual([['shared', null]])
  })

  test('human members and agent members without an agent id are left out', () => {
    const unique = uniqueAgentMembersOf([
      { id: 'h', memberType: 'human', agentId: 'agent-x' },
      { id: 'a1', memberType: 'agent' },
      { id: 'a2', memberType: 'agent', agentId: null },
      { id: 'a3', memberType: 'agent', agentId: 'agent-x' },
    ])
    // The human carrying the same agent id neither claims it nor makes it shared.
    expect([...unique]).toEqual([['agent-x', 'a3']])
  })

  test('an empty roster yields an empty map', () => {
    expect(uniqueAgentMembersOf([]).size).toBe(0)
  })
})

describe('RFC-616 workgroupHostRunKindOf', () => {
  const cards = new Set([CARD])

  test('a leader node run is a leader round whatever minted it, except the gate holder', () => {
    for (const cause of ['wg-leader-round', 'wg-protocol-retry', 'clarify-answer', 'revival', null])
      expect(workgroupHostRunKindOf(leaderRun(cause), cards)).toBe('leader-round')
    expect(workgroupHostRunKindOf(leaderRun('wg-gate'), cards)).toBeNull()
  })

  test('a member node run is classified by its shard key', () => {
    expect(workgroupHostRunKindOf(memberRun(buildMsgShardKey(CODER, 'msg-9')), cards)).toBe(
      'message-turn',
    )
    expect(workgroupHostRunKindOf(memberRun(CARD), cards)).toBe('assignment')
    // A batch is recognised by its key alone: its cards need not be known.
    expect(
      workgroupHostRunKindOf(memberRun(buildBatchShardKey(CODER, ['x', 'y'])), new Set()),
    ).toBe('assignment')
  })

  test('a member node run that is none of the three turn kinds is not a turn', () => {
    expect(workgroupHostRunKindOf(memberRun(null), cards)).toBeNull()
    expect(workgroupHostRunKindOf(memberRun('card-unknown'), cards)).toBeNull()
    // Neither key names a member and work, so neither is a turn.
    expect(workgroupHostRunKindOf(memberRun('batch:'), cards)).toBeNull()
    expect(workgroupHostRunKindOf(memberRun(`batch:${CODER}:`), cards)).toBeNull()
    expect(workgroupHostRunKindOf(memberRun('msg::msg-9'), cards)).toBeNull()
  })

  test('a message key wins over a card id that happens to look the same', () => {
    const key = buildMsgShardKey(CODER, 'msg-9')
    expect(workgroupHostRunKindOf(memberRun(key), new Set([key]))).toBe('message-turn')
  })

  test('runs of any other node are not turns', () => {
    for (const nodeId of [WORKGROUP_TURN_CLARIFY_NODE_ID, '__dw_orchestrator__', 'agent-node'])
      expect(
        workgroupHostRunKindOf({ nodeId, shardKey: CARD, rerunCause: 'wg-assignment' }, cards),
      ).toBeNull()
  })
})

describe('RFC-616 attributeWorkgroupHostRun', () => {
  test('a leader round belongs to the leader', () => {
    expect(attributeWorkgroupHostRun(leaderRun(), roster)).toEqual({
      kind: 'leader-round',
      memberId: LEADER,
      maxMsgId: null,
    })
  })

  test('a leader round of a group without a leader belongs to nobody', () => {
    expect(attributeWorkgroupHostRun(leaderRun(), { ...roster, leaderMemberId: null })).toBeNull()
  })

  test('the completion-gate holder on the leader node is not attributed', () => {
    expect(attributeWorkgroupHostRun(leaderRun('wg-gate'), roster)).toBeNull()
  })

  test('a message turn takes its member and the newest message it saw from the key', () => {
    expect(
      attributeWorkgroupHostRun(
        memberRun(buildMsgShardKey(TWIN_A, 'msg-42'), 'agent-twin', 'wg-message-turn'),
        roster,
      ),
    ).toEqual({ kind: 'message-turn', memberId: TWIN_A, maxMsgId: 'msg-42' })
    // A turn that saw no message yet freezes the zero marker.
    expect(
      attributeWorkgroupHostRun(memberRun(buildMsgShardKey(CODER, ''), null, null), roster),
    ).toEqual({ kind: 'message-turn', memberId: CODER, maxMsgId: '0' })
  })

  test('a batch takes its member from the key, not from the agent it ran with', () => {
    expect(
      attributeWorkgroupHostRun(
        // The agent id points at another member; the key frozen at mint wins.
        memberRun(buildBatchShardKey(TWIN_B, ['c1', 'c2']), 'agent-coder'),
        roster,
      ),
    ).toEqual({ kind: 'assignment', memberId: TWIN_B, maxMsgId: null })
    // The key is enough: no agent id, and none of its cards known.
    expect(
      attributeWorkgroupHostRun(memberRun(buildBatchShardKey(TWIN_A, ['c9'])), {
        ...roster,
        assignmentIds: new Set(),
      }),
    ).toEqual({ kind: 'assignment', memberId: TWIN_A, maxMsgId: null })
  })

  test('a single-card run belongs to the one member using the agent it ran with', () => {
    expect(attributeWorkgroupHostRun(memberRun(CARD, 'agent-coder'), roster)).toEqual({
      kind: 'assignment',
      memberId: CODER,
      maxMsgId: null,
    })
  })

  test('a single-card run cannot be attributed when its agent is shared, unknown or missing', () => {
    expect(attributeWorkgroupHostRun(memberRun(CARD, 'agent-twin'), roster)).toBeNull()
    expect(attributeWorkgroupHostRun(memberRun(CARD, 'agent-removed'), roster)).toBeNull()
    expect(attributeWorkgroupHostRun(memberRun(CARD, null), roster)).toBeNull()
    expect(attributeWorkgroupHostRun(memberRun(CARD), roster)).toBeNull()
  })

  test('a run that is not a turn is not attributed, whatever agent it ran with', () => {
    expect(attributeWorkgroupHostRun(memberRun('card-unknown', 'agent-coder'), roster)).toBeNull()
    expect(
      attributeWorkgroupHostRun(
        {
          nodeId: WORKGROUP_TURN_CLARIFY_NODE_ID,
          shardKey: CARD,
          rerunCause: 'clarify-park',
          agentOverrideId: 'agent-coder',
        },
        roster,
      ),
    ).toBeNull()
  })
})
