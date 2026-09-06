// RFC-187 F3/F8 (audit design/workgroup-e2e-audit.md §5 F3/F8) — a non-autonomous
// leader that asks a <workflow-clarify> used to spin to max_rounds: the leader
// clarify parks on a __wg_clarify__ row (null shardKey), but the old `leaderParked`
// checked hostRuns for __wg_leader__+awaiting_human (a state that never exists — leader
// runs go `done`) AND loadDbState never even loaded __wg_clarify__ rows. So the engine
// re-drove the leader every round, orphaned N clarify sessions, and the human was never
// asked (probe B: 10 leader rounds → failed "hit max_rounds (10)"). Fix: derive the park
// from the open clarify SESSION (sourceAgentNodeId=leader — answerable, crash-safe;
// Codex P0-1) and surface awaiting_human reason `leader-clarify`.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { WorkgroupMessage, WorkgroupRuntimeConfig } from '@agent-workflow/shared'
// RFC-359 W4-D19c-tail：判据改指两个 provider 真正在跑的那份（中立驱动）；
// 夹具经 `wakeSnapshotOf` 翻成它要的 (snapshot, inflight)，断言原样保留。
import {
  decideWorkgroupOutcome,
  deriveWakeSet,
} from '@/modules/resource-catalog/application/workgroups/workgroupTurnsDriver'
import { wakeSnapshotOf, type LegacyWakeInput as WakeInput } from './helpers/workgroupWake'
// RFC-359 W4-D19c-tail：判据改指生产那条（宿主账本按 run id 连接未答反问）；夹具把
// 「会话」翻成「宿主 run + 提问 run 集合」，断言逐条保留。
import { leaderClarifyParkedOf } from '@/modules/task-execution/infrastructure/workgroupHostLedgerParticipant'

/** 旧夹具形状 → 中立驱动的两参调用（RFC-359 W4-D19c-tail）。 */
function deriveWake(input: WakeInput) {
  const { snapshot, inflight } = wakeSnapshotOf(input)
  return deriveWakeSet(snapshot, inflight)
}
function decideOutcome(input: WakeInput, wake: ReturnType<typeof deriveWake>) {
  const { snapshot, inflight } = wakeSnapshotOf(input)
  return decideWorkgroupOutcome(snapshot, inflight, wake)
}

function cfg(overrides: Partial<WorkgroupRuntimeConfig> = {}): WorkgroupRuntimeConfig {
  return {
    workgroupId: 'wg1',
    workgroupName: 'squad',
    mode: 'leader_worker',
    leaderMemberId: 'm-lead',
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 10,
    completionGate: false,
    instructions: 'be kind',
    goal: 'fix payments',
    // RFC-207 — ask-back requires a human on the roster (the RFC-180 `autonomous:
    // false` this replaced meant the same thing: "questions to humans are on").
    // Without one the leader's <workflow-clarify> is suppressed and this park
    // can never happen, so the fixture would pass vacuously.
    members: [
      {
        id: 'm-human',
        memberType: 'human',
        agentName: null,
        userId: 'u-1',
        displayName: 'owner',
        roleDesc: '拍板',
      },
      {
        id: 'm-lead',
        memberType: 'agent',
        agentName: 'planner',
        userId: null,
        displayName: 'planner',
        roleDesc: '协调',
      },
      {
        id: 'm-coder',
        memberType: 'agent',
        agentName: 'coder-a',
        userId: null,
        displayName: 'coder',
        roleDesc: '实现',
      },
    ],
    ...overrides,
  }
}

function wakeInput(overrides: Partial<WakeInput> = {}): WakeInput {
  return {
    config: cfg(),
    assignments: [],
    messages: [] as WorkgroupMessage[],
    cursors: new Map(),
    inFlight: {
      leaderRunning: false,
      runningAssignmentIds: new Set(),
      messageTurnMemberIds: new Set(),
    },
    budgetUsed: 0,
    gate: { declaredDone: false, awaitingConfirmation: false, rejected: false },
    ...overrides,
  }
}

type Sess = { sourceAgentNodeId: string; status: string }
const LEADER = '__wg_leader__'
const MEMBER = '__wg_member__'

/**
 * 旧夹具（反问会话列表）→ 生产判据要的两样：领队/成员的宿主 run，以及**未答**反问的提问 run 集合。
 * 每条会话映射成一条同 nodeId 的 run；只有 `awaiting_human` 的那条进提问集合——这正是
 * 合一前 `deriveLeaderClarifyPark` 用 status 过滤表达的同一件事。
 */
function deriveLeaderClarifyPark(sessions: readonly Sess[]): boolean {
  const runs = sessions.map((session, index) => ({
    id: `run-${index}`,
    nodeId: session.sourceAgentNodeId,
  }))
  const asking = new Set(
    sessions.flatMap((session, index) =>
      session.status === 'awaiting_human' ? [`run-${index}`] : [],
    ),
  )
  return leaderClarifyParkedOf(runs, asking)
}

describe('RFC-187 F3 — deriveLeaderClarifyPark (session-keyed, Codex P0-1)', () => {
  test('an open (awaiting_human) session sourced from the leader host node = leader park', () => {
    const sessions: Sess[] = [{ sourceAgentNodeId: LEADER, status: 'awaiting_human' }]
    expect(deriveLeaderClarifyPark(sessions)).toBe(true)
  })

  test('a member clarify session is NOT a leader park', () => {
    // member clarifies park their assignment awaiting_human (caught by humanPending).
    expect(deriveLeaderClarifyPark([{ sourceAgentNodeId: MEMBER, status: 'awaiting_human' }])).toBe(
      false,
    )
  })

  test('an answered/closed leader session does not park', () => {
    expect(deriveLeaderClarifyPark([{ sourceAgentNodeId: LEADER, status: 'answered' }])).toBe(false)
    expect(deriveLeaderClarifyPark([{ sourceAgentNodeId: LEADER, status: 'canceled' }])).toBe(false)
  })

  test('empty set = not parked (also self-heals a crash-orphan run with no session)', () => {
    expect(deriveLeaderClarifyPark([])).toBe(false)
  })

  test('mixed: an open leader session among member sessions is still detected', () => {
    const sessions: Sess[] = [
      { sourceAgentNodeId: MEMBER, status: 'awaiting_human' },
      { sourceAgentNodeId: LEADER, status: 'answered' },
      { sourceAgentNodeId: LEADER, status: 'awaiting_human' },
    ]
    expect(deriveLeaderClarifyPark(sessions)).toBe(true)
  })
})

describe('RFC-187 F3/F8 — decideWorkgroupOutcome surfaces leader-clarify', () => {
  test('leaderClarifyParked → awaiting_human reason leader-clarify', () => {
    const out = decideOutcome(wakeInput({ leaderClarifyParked: true }), {
      items: [],
      capExceeded: false,
    })
    expect(out).toEqual({ kind: 'awaiting-human', reason: 'leader-clarify' })
  })

  test('leader-clarify park BEATS max_rounds (a blocked leader is not a failure)', () => {
    // this is exactly probe B: without the park signal the same state returned
    // { failed, max-rounds }.
    const out = decideOutcome(wakeInput({ leaderClarifyParked: true, budgetUsed: 10 }), {
      items: [],
      capExceeded: true,
    })
    expect(out).toEqual({ kind: 'awaiting-human', reason: 'leader-clarify' })
  })

  test('without the park signal, the same empty state hits max_rounds (regression contrast)', () => {
    const out = decideOutcome(wakeInput({ budgetUsed: 10 }), {
      items: [],
      capExceeded: true,
    })
    expect(out).toEqual({ kind: 'failed', reason: 'max-rounds' })
  })

  test('an in-flight leader still reports running (park only matters when idle)', () => {
    const out = decideOutcome(
      wakeInput({
        leaderClarifyParked: true,
        inFlight: {
          leaderRunning: true,
          runningAssignmentIds: new Set(),
          messageTurnMemberIds: new Set(),
        },
      }),
      { items: [], capExceeded: false },
    )
    expect(out).toEqual({ kind: 'running' })
  })
})

describe('RFC-187 F3 — deriveWakeSet does not re-drive a clarify-parked leader', () => {
  test('leaderClarifyParked suppresses the leader wake even on the initial round', () => {
    const parked = deriveWake(wakeInput({ leaderClarifyParked: true }))
    expect(parked.items.filter((i) => i.kind === 'leader')).toHaveLength(0)
    // sanity: without the park the leader IS woken (initial round).
    const notParked = deriveWake(wakeInput({ leaderClarifyParked: false }))
    expect(notParked.items.filter((i) => i.kind === 'leader')).toHaveLength(1)
  })
})

describe('RFC-187 F3 — source locks (宿主账本接线)', () => {
  // RFC-359 W4-D19c-tail：legacy 工作组引擎岛已退役。停靠信号的两半——「读出未答反问」与
  // 「按它判领队是否停靠」——现在都住在宿主账本参与者里，两个 provider 共用这一份。
  const LEDGER = readFileSync(
    resolve(
      import.meta.dir,
      '..',
      'src',
      'modules',
      'task-execution',
      'infrastructure',
      'workgroupHostLedgerParticipant.ts',
    ),
    'utf8',
  )

  test('宿主快照读的是未答反问的提问 run（Codex P0-1：可回答、崩溃安全的那个信号）', () => {
    expect(LEDGER).toContain('clarify.loadProjection(taskId)')
    expect(LEDGER).toContain('new Set(clarifyProjection.askingNodeRunIds)')
    // hostRuns 仍只取领队 / 成员两个宿主节点（停靠不再挂在 run 的状态上）。
    expect(LEDGER).toMatch(
      /inArray\(\s*nodeRuns\.nodeId,\s*\[WORKGROUP_TURN_LEADER_NODE_ID, WORKGROUP_TURN_MEMBER_NODE_ID\],?\s*\)/,
    )
  })

  test('领队停靠由未答反问推出，不是已死的 hostRuns 状态判据', () => {
    expect(LEDGER).toContain(
      'leaderClarifyParked: leaderClarifyParkedOf(hostRows, askingNodeRunIds)',
    )
    // 旧的死判据（领队宿主 run 处于 awaiting_human）绝不能回潮。
    expect(LEDGER).not.toMatch(
      /nodeId === WORKGROUP_TURN_LEADER_NODE_ID && \w+\.status === 'awaiting_human'/,
    )
  })
})
