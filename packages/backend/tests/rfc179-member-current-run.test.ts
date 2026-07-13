// RFC-179 §8.1/§8.2 — locks the workgroup room's per-member "current session run"
// derivation (deriveMemberCurrentRuns) and the message-turn shardKey-prefix
// contract. This is the single-source oracle behind「点成员看当前 session」and the
// executing indicator; a regression here silently breaks both. See
// design/RFC-179-workgroup-room-runtime-visibility/design.md §2.1 / §5.

import { describe, expect, test } from 'bun:test'
import {
  deriveMemberCurrentRuns,
  type HostRunLite,
  type MemberLite,
} from '../src/services/workgroupRoom'
import { WG_LEADER_NODE_ID, WG_MEMBER_NODE_ID } from '../src/services/workgroupLaunch'

const LEADER = 'M_leader'
const A1 = 'M_agent1'
const A2 = 'M_agent2'
const H1 = 'M_human1'

const members: MemberLite[] = [
  { id: LEADER, memberType: 'agent' },
  { id: A1, memberType: 'agent' },
  { id: A2, memberType: 'agent' },
  { id: H1, memberType: 'human' },
]

function leaderRun(id: string, status: string, cause = 'wg-leader-round'): HostRunLite {
  return { id, nodeId: WG_LEADER_NODE_ID, shardKey: null, status, rerunCause: cause }
}
function assignRun(id: string, shardKey: string, status: string): HostRunLite {
  return { id, nodeId: WG_MEMBER_NODE_ID, shardKey, status, rerunCause: 'wg-assignment' }
}
function msgRun(id: string, shardKey: string, status: string): HostRunLite {
  return { id, nodeId: WG_MEMBER_NODE_ID, shardKey, status, rerunCause: 'wg-message-turn' }
}

describe('deriveMemberCurrentRuns (RFC-179)', () => {
  test('leader-round → the leader member', () => {
    const out = deriveMemberCurrentRuns(members, LEADER, [leaderRun('R1', 'running')], [], [])
    expect(out[LEADER]).toEqual({
      nodeRunId: 'R1',
      status: 'running',
      kind: 'leader-round',
      triggerMessageId: null,
    })
    expect(out[A1]).toBeNull()
  })

  test('assignment run → assignment.assigneeMemberId (shardKey = assignment.id)', () => {
    const assignments = [{ id: 'ASG1', assigneeMemberId: A1 }]
    const out = deriveMemberCurrentRuns(
      members,
      LEADER,
      [assignRun('R1', 'ASG1', 'running')],
      assignments,
      [],
    )
    expect(out[A1]?.nodeRunId).toBe('R1')
    expect(out[A1]?.kind).toBe('assignment')
    expect(out[A2]).toBeNull()
  })

  test('message-turn run → memberId parsed from shardKey', () => {
    const out = deriveMemberCurrentRuns(
      members,
      LEADER,
      [msgRun('R1', `msg:${A2}:0`, 'running')],
      [],
      [],
    )
    expect(out[A2]?.nodeRunId).toBe('R1')
    expect(out[A2]?.kind).toBe('message-turn')
  })

  test('running wins over an older terminal run', () => {
    const runs = [assignRun('R1', 'ASG1', 'done'), assignRun('R2', 'ASG1', 'running')]
    const out = deriveMemberCurrentRuns(
      members,
      LEADER,
      runs,
      [{ id: 'ASG1', assigneeMemberId: A1 }],
      [],
    )
    expect(out[A1]?.nodeRunId).toBe('R2')
    expect(out[A1]?.status).toBe('running')
  })

  test('running still wins even when a later id is terminal', () => {
    // R2 has the larger id but is terminal; the running R1 must win.
    const runs = [assignRun('R1', 'ASG1', 'running'), assignRun('R2', 'ASG1', 'failed')]
    const out = deriveMemberCurrentRuns(
      members,
      LEADER,
      runs,
      [{ id: 'ASG1', assigneeMemberId: A1 }],
      [],
    )
    expect(out[A1]?.nodeRunId).toBe('R1')
  })

  test('no running → newest terminal by id', () => {
    const runs = [
      assignRun('R1', 'ASG1', 'done'),
      assignRun('R3', 'ASG1', 'failed'),
      assignRun('R2', 'ASG1', 'done'),
    ]
    const out = deriveMemberCurrentRuns(
      members,
      LEADER,
      runs,
      [{ id: 'ASG1', assigneeMemberId: A1 }],
      [],
    )
    expect(out[A1]?.nodeRunId).toBe('R3')
  })

  test('human member and members with no run → null', () => {
    const out = deriveMemberCurrentRuns(members, LEADER, [], [], [])
    expect(out[H1]).toBeNull()
    expect(out[LEADER]).toBeNull()
    expect(out[A1]).toBeNull()
  })

  test('wg-gate holder run on the leader node is excluded', () => {
    const out = deriveMemberCurrentRuns(
      members,
      LEADER,
      [leaderRun('R1', 'running', 'wg-gate')],
      [],
      [],
    )
    expect(out[LEADER]).toBeNull()
  })

  test('two members run concurrently without cross-contamination', () => {
    const assignments = [
      { id: 'ASG1', assigneeMemberId: A1 },
      { id: 'ASG2', assigneeMemberId: A2 },
    ]
    const runs = [assignRun('R1', 'ASG1', 'running'), assignRun('R2', 'ASG2', 'running')]
    const out = deriveMemberCurrentRuns(members, LEADER, runs, assignments, [])
    expect(out[A1]?.nodeRunId).toBe('R1')
    expect(out[A2]?.nodeRunId).toBe('R2')
  })

  test('message-turn triggerMessageId = newest mention ≤ maxMsgId', () => {
    // shardKey maxMsgId = 'MSG5'; the newest chat that @-mentioned A1 with id ≤ MSG5.
    const messages = [
      { id: 'MSG2', mentionMemberIds: [A1] },
      { id: 'MSG4', mentionMemberIds: [A1] },
      { id: 'MSG6', mentionMemberIds: [A1] }, // after wake — must NOT be picked
      { id: 'MSG3', mentionMemberIds: [A2] }, // wrong member
    ]
    const out = deriveMemberCurrentRuns(
      members,
      LEADER,
      [msgRun('R1', `msg:${A1}:MSG5`, 'running')],
      [],
      messages,
    )
    expect(out[A1]?.triggerMessageId).toBe('MSG4')
  })

  test('message-turn with maxMsgId 0 or no mention → triggerMessageId null', () => {
    const out = deriveMemberCurrentRuns(
      members,
      LEADER,
      [msgRun('R1', `msg:${A1}:0`, 'running')],
      [],
      [],
    )
    expect(out[A1]?.triggerMessageId).toBeNull()
  })

  test('assignment run with unknown shardKey (no matching assignment) → ignored', () => {
    const out = deriveMemberCurrentRuns(
      members,
      LEADER,
      [assignRun('R1', 'GHOST', 'running')],
      [],
      [],
    )
    expect(out[A1]).toBeNull()
  })
})

describe('message-turn shardKey prefix contract (RFC-179 §8.2)', () => {
  // Locks the `msg:${memberId}:${maxMsgId}` format that workgroupRunner.ts:1251
  // mints and workgroupRoom.ts parses. If the engine changes the format, this
  // test (and the message-turn mapping above) goes red on purpose.
  test('deriveMemberCurrentRuns maps exactly the msg:<memberId>:<maxMsgId> shape', () => {
    const shardKey = `msg:${A1}:01ARZ3NDEKTSV4RRFFQ69G5FAV`
    const out = deriveMemberCurrentRuns(
      members,
      LEADER,
      [msgRun('R1', shardKey, 'running')],
      [],
      [],
    )
    expect(out[A1]?.kind).toBe('message-turn')
    // A shardKey without the msg: prefix must NOT be read as a message-turn owner.
    const out2 = deriveMemberCurrentRuns(members, LEADER, [msgRun('R2', A1, 'running')], [], [])
    expect(out2[A1]).toBeNull()
  })
})
