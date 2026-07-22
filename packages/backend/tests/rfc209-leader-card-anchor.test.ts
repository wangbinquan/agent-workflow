// RFC-209 T9（对抗设计门 P0 的回归网）—— leader 回合卡的轮序数改读 `node_runs.wg_round`。
//
// 这条测试锁的回归：RFC-209 让人类/系统消息也带上真实回合号之后，**从消息 round 反推**
// 卡片序数（RFC-182 时代的 `1 + max(m.round | m.id < runId)`）必然漂移——
// `driveLeaderTurn` 在 `runHostNode` **之前**就把本轮的行连 `wgRound` 落库
// （workgroupRunner.ts 的 mint 早于 hooks.runHostNode），所以账本读数是**正在进行的那一轮**；
// 房间里的人在 leader 轮 2 跑动中发一句话就写 round 2，而晚于它铸出的协议重试行会被反推成 3
// （正确答案是 2——重试与本轮共享轮号）。卡片于是被塞进一个不存在的 round 3 桶，经前端
// `buildRoomTimeline` 的尾部兜底渲染到房间**最底部**，看起来像最新事件。
//
// RFC-189 之后 `wg_round` 才是权威列，所以这里直接读它；仅当它为 NULL（0095 回填之前的
// 历史行 / 引擎外 mint 未打戳的行 / RFC-179 期 fixture）才回退旧推导。
//
// 相关：rfc179-member-current-run.test.ts 的「重试共享轮号」用例（合成消息、不含人类行）
// 继续绿，本文件补的是它覆盖不到的「人类消息落在在飞轮上」那一格。

import { describe, expect, test } from 'bun:test'
import {
  deriveWorkgroupRunHistory,
  type HostRunLite,
  type MemberLite,
} from '../src/services/workgroup/room'
import { WG_LEADER_NODE_ID, WG_MEMBER_NODE_ID } from '../src/services/workgroup/launch'

const LEADER = 'M_leader'
const A1 = 'M_agent1'

const members: MemberLite[] = [
  { id: LEADER, memberType: 'agent', displayName: 'planner' },
  { id: A1, memberType: 'agent', displayName: 'writer' },
]

function leaderRun(
  id: string,
  status: string,
  wgRound: number | null,
  cause = 'wg-leader-round',
): HostRunLite {
  return { id, nodeId: WG_LEADER_NODE_ID, shardKey: null, status, rerunCause: cause, wgRound }
}

describe('RFC-209 T9 — leader 卡片轮号读 wg_round', () => {
  test('打过戳的行直接用 wg_round（不再从消息 round 反推）', () => {
    const runs = [leaderRun('L1-run', 'done', 1), leaderRun('L2-run', 'done', 2)]
    const messages = [{ id: 'M1-msg', mentionMemberIds: [], round: 1 }]
    const history = deriveWorkgroupRunHistory(members, LEADER, runs, [], messages)
    expect(history.map((e) => e.round)).toEqual([1, 2])
  })

  test('协议重试与本轮**共享**轮号（RFC-182 impl-gate P2 的语义不回归）', () => {
    const runs = [
      leaderRun('L1-run', 'failed', 1),
      leaderRun('L2-run', 'done', 1, 'wg-protocol-retry'),
      leaderRun('L3-run', 'running', 2),
    ]
    const history = deriveWorkgroupRunHistory(members, LEADER, runs, [], [])
    expect(history.map((e) => e.round)).toEqual([1, 1, 2])
  })

  test('P0 失败场景直测：人在轮 2 跑动中发言，晚于它的重试行**不得**被标成轮 3', () => {
    // 时序（ULID 升序）：
    //   L2a-run  leader 轮 2 的第一次尝试（mint 时就带 wgRound=2）
    //   H-msg    人在轮 2 跑动中发言 —— RFC-209 之后写的是**在飞轮** round=2
    //   L2b-run  同一轮的协议重试，ULID 晚于那条人类消息
    // 旧的反推口径：1 + max(round | id < 'L2b-run') = 1 + 2 = 3 ✗
    const runs = [
      leaderRun('L2a-run', 'failed', 2),
      leaderRun('L2b-run', 'done', 2, 'wg-protocol-retry'),
    ]
    const messages = [
      { id: 'L2a-run-Z', mentionMemberIds: [], round: 2 }, // 人类发言，id 介于两行之间
    ]
    const history = deriveWorkgroupRunHistory(members, LEADER, runs, [], messages)
    expect(history.map((e) => e.nodeRunId)).toEqual(['L2a-run', 'L2b-run'])
    // 两行同属轮 2；改动前第二行会是 3，卡片被冲到房间底部。
    expect(history.map((e) => e.round)).toEqual([2, 2])
  })

  test('wg_round 为 NULL 时回退旧的消息锚定推导（0095 回填前 / 引擎外 mint 的历史行）', () => {
    const runs = [leaderRun('L1-run', 'done', null), leaderRun('L3-run', 'running', null)]
    const messages = [{ id: 'L2-msg', mentionMemberIds: [], round: 1 }]
    const history = deriveWorkgroupRunHistory(members, LEADER, runs, [], messages)
    // L1 之前无消息 → 1；L3 之前有 round-1 消息 → 2
    expect(history.map((e) => e.round)).toEqual([1, 2])
  })

  test('非 leader 条目的 round 恒 null（成员轮按 ULID 交织，不参与回合锚定）', () => {
    const runs: HostRunLite[] = [
      leaderRun('L1-run', 'done', 1),
      {
        id: 'M1-run',
        nodeId: WG_MEMBER_NODE_ID,
        shardKey: `msg:${A1}:0`,
        status: 'done',
        rerunCause: 'wg-message-turn',
        wgRound: 1,
      },
    ]
    const history = deriveWorkgroupRunHistory(members, LEADER, runs, [], [])
    expect(history.map((e) => e.round)).toEqual([1, null])
  })
})
