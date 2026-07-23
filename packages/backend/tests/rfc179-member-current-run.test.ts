// RFC-179 §8.1/§8.2 — locks the workgroup room's per-member "current session run"
// derivation (deriveMemberCurrentRuns) and the message-turn shardKey-prefix
// contract. This is the single-source oracle behind「点成员看当前 session」and the
// executing indicator; a regression here silently breaks both. See
// design/RFC-179-workgroup-room-runtime-visibility/design.md §2.1 / §5.

import { describe, expect, test } from 'bun:test'
import {
  deriveWorkgroupRunHistory,
  deriveMemberCurrentRuns,
  type HostRunLite,
  type MemberLite,
} from '../src/services/workgroup/room'
import { WG_LEADER_NODE_ID, WG_MEMBER_NODE_ID } from '../src/services/workgroup/launch'

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

  // RFC-215 §3.6 — 批 run（shardKey=batch:member:ids）必须在房间可见：成员归属取
  // key 里编码的 memberId（mint 时冻结，卡重领/requeue 置空 assignee 都不影响）。
  // 修复前 runKindOf 对 batch 行返回 null ⇒ 批执行期 presence 显示空闲、
  // runHistory 整行丢失（设计门 ②F3）。
  test('batch run (RFC-215) → member from the shardKey, visible as assignment kind', () => {
    const out = deriveMemberCurrentRuns(
      members,
      LEADER,
      [assignRun('R1', `batch:${A1}:ASG1+ASG2`, 'running')],
      [], // 卡表为空也能归属（key 自足）
      [],
    )
    expect(out[A1]?.nodeRunId).toBe('R1')
    expect(out[A1]?.kind).toBe('assignment')
    const history = deriveWorkgroupRunHistory(
      members,
      LEADER,
      [assignRun('R1', `batch:${A1}:ASG1+ASG2`, 'done')],
      [],
      [],
    )
    expect(history.map((e) => e.nodeRunId)).toContain('R1')
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

// ---------------------------------------------------------------------------
// RFC-182 — runHistory 单源 + memberRuns 投影
// (design/RFC-182-workgroup-room-execution-overhaul/design.md §2.1 / §6.1)
// kind 判定改按 nodeId+shardKey 形状（设计门 P1）：clarify-answer 续跑 run 保留
// shard 血统但 rerunCause='clarify-answer'——按 cause 分类会把续跑 session 同时
// 漏出历史与 memberRuns（成员答完反问、续跑执行中，花名册却显示空闲）。
// ---------------------------------------------------------------------------

describe('deriveWorkgroupRunHistory (RFC-182)', () => {
  const namedMembers: MemberLite[] = [
    { id: LEADER, memberType: 'agent', displayName: 'planner' },
    { id: A1, memberType: 'agent', displayName: 'coder' },
    { id: A2, memberType: 'agent', displayName: 'reviewer' },
    { id: H1, memberType: 'human', displayName: 'pm' },
  ]

  test('clarify-answer 续跑按 shard 形状归类（assignment / message-turn 双例）并进 memberRuns', () => {
    const assignments = [{ id: 'ASG1', assigneeMemberId: A1 }]
    const runs: HostRunLite[] = [
      {
        id: 'R1',
        nodeId: WG_MEMBER_NODE_ID,
        shardKey: 'ASG1',
        status: 'done',
        rerunCause: 'wg-assignment',
      },
      // 答完反问后的续跑：cause 变 clarify-answer、shard 不变。
      {
        id: 'R2',
        nodeId: WG_MEMBER_NODE_ID,
        shardKey: 'ASG1',
        status: 'running',
        rerunCause: 'clarify-answer',
      },
      {
        id: 'R3',
        nodeId: WG_MEMBER_NODE_ID,
        shardKey: `msg:${A2}:0`,
        status: 'running',
        rerunCause: 'clarify-answer',
      },
    ]
    const history = deriveWorkgroupRunHistory(namedMembers, LEADER, runs, assignments, [])
    expect(history.map((e) => [e.nodeRunId, e.kind])).toEqual([
      ['R1', 'assignment'],
      ['R2', 'assignment'],
      ['R3', 'message-turn'],
    ])
    // 投影同步收编（latent 缺口回归锁：续跑执行中 ≠ 空闲）。
    const current = deriveMemberCurrentRuns(namedMembers, LEADER, runs, assignments, [])
    expect(current[A1]?.nodeRunId).toBe('R2')
    expect(current[A1]?.status).toBe('running')
    expect(current[A2]?.nodeRunId).toBe('R3')
  })

  test('升序 + leader 轮号按消息轮锚定（实现门 P2：重试共享轮号、gate 排除）+ displayName 冻结', () => {
    const runs: HostRunLite[] = [
      leaderRun('A1-run', 'failed'), // 协议重试第一次尝试
      leaderRun('A2-run', 'done'), // 同一逻辑轮的重试成功——共享 round 1
      {
        id: 'A3-run',
        nodeId: WG_LEADER_NODE_ID,
        shardKey: null,
        status: 'done',
        rerunCause: 'wg-gate',
      },
      leaderRun('C1-run', 'running'), // round-1 消息之后 mint → round 2
      msgRun('C2-run', `msg:${A2}:0`, 'done'),
    ]
    // B1-msg（round=1，leader 轮 1 的产出）位于 A* 之后、C* 之前（ULID 序）。
    const messages = [{ id: 'B1-msg', mentionMemberIds: [], round: 1 }]
    const history = deriveWorkgroupRunHistory(namedMembers, LEADER, runs, [], messages)
    expect(history.map((e) => e.nodeRunId)).toEqual(['A1-run', 'A2-run', 'C1-run', 'C2-run'])
    // 计数序数会给重试成功的 A2-run 标 2（卡落错误分隔下）；消息锚定共享轮号。
    expect(history.map((e) => e.round)).toEqual([1, 1, 2, null])
    expect(history[0]?.displayName).toBe('planner')
    expect(history[3]?.displayName).toBe('reviewer')
  })

  test('实现门 P1：open clarify session 的 asking run 投影 awaiting_human（DB 行仍 done）', () => {
    const runs: HostRunLite[] = [leaderRun('L1', 'done'), leaderRun('L2', 'done')]
    const history = deriveWorkgroupRunHistory(namedMembers, LEADER, runs, [], [], {
      openClarifySourceRunIds: new Set(['L2']),
    })
    expect(history.map((e) => e.status)).toEqual(['done', 'awaiting_human'])
    // 投影同样进 memberRuns → presence 显示「等待回答」。
    const current = deriveMemberCurrentRuns(namedMembers, LEADER, runs, [], [], {
      openClarifySourceRunIds: new Set(['L2']),
    })
    expect(current[LEADER]?.status).toBe('awaiting_human')
  })

  test('被移除成员的历史条目 displayName=null（墓碑），memberId 保留', () => {
    const assignments = [{ id: 'ASG9', assigneeMemberId: 'M_gone' }]
    const runs: HostRunLite[] = [
      {
        id: 'R1',
        nodeId: WG_MEMBER_NODE_ID,
        shardKey: 'ASG9',
        status: 'failed',
        rerunCause: 'wg-assignment',
      },
    ]
    const history = deriveWorkgroupRunHistory(namedMembers, LEADER, runs, assignments, [])
    expect(history).toHaveLength(1)
    expect(history[0]?.memberId).toBe('M_gone')
    expect(history[0]?.displayName).toBeNull()
  })

  test('note 派生：仅认结构化 failureCode=clarify-forbidden（RFC-145 禁 errorMessage 机器读；RFC-181 契约互链）', () => {
    const runs: HostRunLite[] = [
      { ...leaderRun('L1', 'failed'), failureCode: 'clarify-forbidden' },
      // 其它失败码 / 无码 → null（errorMessage 是人读 breadcrumb，永不参与判定）。
      { ...leaderRun('L2', 'failed'), failureCode: 'clarify-questions-malformed' },
      { ...leaderRun('L3', 'failed') },
    ]
    const history = deriveWorkgroupRunHistory(namedMembers, LEADER, runs, [], [])
    expect(history.map((e) => e.note)).toEqual(['clarify-suppressed', null, null])
  })

  test('assignmentId / triggerMessageId / startedAt·finishedAt 回填', () => {
    const assignments = [{ id: 'ASG1', assigneeMemberId: A1 }]
    const messages = [{ id: 'MSG5', mentionMemberIds: [A2] }]
    const runs: HostRunLite[] = [
      {
        id: 'R1',
        nodeId: WG_MEMBER_NODE_ID,
        shardKey: 'ASG1',
        status: 'done',
        rerunCause: 'wg-assignment',
        startedAt: 100,
        finishedAt: 250,
      },
      {
        id: 'R2',
        nodeId: WG_MEMBER_NODE_ID,
        shardKey: `msg:${A2}:MSG5`,
        status: 'done',
        rerunCause: 'wg-message-turn',
      },
    ]
    const history = deriveWorkgroupRunHistory(namedMembers, LEADER, runs, assignments, messages)
    expect(history[0]).toMatchObject({
      assignmentId: 'ASG1',
      triggerMessageId: null,
      startedAt: 100,
      finishedAt: 250,
    })
    expect(history[1]).toMatchObject({ assignmentId: null, triggerMessageId: 'MSG5' })
  })

  test('投影等价：memberRuns 恒等于 history 的 per-member 胜者（running 优先否则最新）', () => {
    const assignments = [{ id: 'ASG1', assigneeMemberId: A1 }]
    const runs: HostRunLite[] = [
      assignRun('R1', 'ASG1', 'done'),
      assignRun('R2', 'ASG1', 'failed'),
      leaderRun('L1', 'done'),
      leaderRun('L2', 'pending'),
    ]
    const history = deriveWorkgroupRunHistory(namedMembers, LEADER, runs, assignments, [])
    const current = deriveMemberCurrentRuns(namedMembers, LEADER, runs, assignments, [])
    // A1：无 running → 最新 id（R2 failed）；leader：无 running → 最新 id（L2 pending）。
    expect(current[A1]?.nodeRunId).toBe('R2')
    expect(current[LEADER]?.nodeRunId).toBe('L2')
    // 投影字段与 history 条目一致（单源不漂移）。
    const l2 = history.find((e) => e.nodeRunId === 'L2')
    expect(current[LEADER]).toEqual({
      nodeRunId: l2?.nodeRunId ?? '',
      status: l2?.status ?? '',
      kind: l2?.kind ?? 'leader-round',
      triggerMessageId: l2?.triggerMessageId ?? null,
    })
  })
})

describe('RFC-182 实现门 P2 — fc 卡回收后的历史归属', () => {
  test('现任 assignee 丢失 → 铸造期 agent 身份唯一回退；歧义则弃条目不误标', () => {
    const roster: MemberLite[] = [
      {
        id: A1,
        memberType: 'agent',
        displayName: 'coder',
        agentId: 'ag-coder',
        agentName: 'wg-coder',
      },
      {
        id: A2,
        memberType: 'agent',
        displayName: 'reviewer',
        agentId: 'ag-reviewer',
        agentName: 'wg-reviewer',
      },
    ]
    // fc：失败卡已回收（assignee=null），历史 run 仍应归属当时执行的成员。
    const assignments = [{ id: 'ASG1', assigneeMemberId: null }]
    const runs: HostRunLite[] = [
      {
        id: 'R1',
        nodeId: WG_MEMBER_NODE_ID,
        shardKey: 'ASG1',
        status: 'failed',
        rerunCause: 'wg-assignment',
        agentOverrideId: 'ag-coder',
        agentOverrideName: 'wg-coder',
      },
    ]
    const history = deriveWorkgroupRunHistory(roster, null, runs, assignments, [])
    expect(history).toHaveLength(1)
    expect(history[0]?.memberId).toBe(A1)
    expect(history[0]?.displayName).toBe('coder')

    // 卡被他人重认领后：新 assignee 只影响新 run；老 run 仍按铸造期身份归属。
    const reclaimed = [{ id: 'ASG1', assigneeMemberId: A2 }]
    const withNew = deriveWorkgroupRunHistory(
      roster,
      null,
      [
        ...runs,
        {
          id: 'R2',
          nodeId: WG_MEMBER_NODE_ID,
          shardKey: 'ASG1',
          status: 'running',
          rerunCause: 'wg-assignment',
          agentOverrideId: 'ag-reviewer',
          agentOverrideName: 'wg-reviewer',
        },
      ],
      reclaimed,
      [],
    )
    // 实现门 P2 二审：铸造期身份（viaAgent 唯一解析）优先于卡的现任 assignee——
    // 重认领后老 run 仍归 A、不被误标给 B。
    expect(withNew).toHaveLength(2)
    expect(withNew[0]?.memberId).toBe(A1)
    expect(withNew[1]?.memberId).toBe(A2)

    // 歧义 agent（两成员同 agent）→ 弃条目，不误标。
    const dup: MemberLite[] = [
      {
        id: A1,
        memberType: 'agent',
        displayName: 'x',
        agentId: 'ag-coder',
        agentName: 'wg-coder',
      },
      {
        id: A2,
        memberType: 'agent',
        displayName: 'y',
        agentId: 'ag-coder',
        agentName: 'wg-coder',
      },
    ]
    expect(deriveWorkgroupRunHistory(dup, null, runs, assignments, [])).toHaveLength(0)
  })
})
