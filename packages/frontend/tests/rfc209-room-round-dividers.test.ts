// RFC-209 —— 房间回合分隔线：单调水位线 + 自由协作关闭。
//
// 这条测试锁的回归：用户 2026-07-20 实报「自由讨论里第 x 回合的轮次总是跳，并且中间一直
// 穿插第 0 回合」。前端这一半的根因是 `buildRoomTimeline` 旧判据 `m.round !== prevRound`
// ——把 round **回退**也算成一次转场，于是 `[…5, 0, 5…]` 会画出「第 5 / 第 0 / 第 5」三条线，
// 并且 `key={round-N}` 还会重复。新判据是**单调水位线** `m.round > maxRound`（从 0 起步，
// 顺带吸收了旧的「round 0 是前奏、不画线」特例）。
//
// 另一半是自由协作根本不该有回合分隔线（fc 成员各自异步认领任务，没有全局回合；
// 那个数其实是 max_rounds 的预算计数器），由 `roomShowsRoundDividers` 派生。

import { describe, expect, test } from 'vitest'
import {
  buildRoomTimeline,
  type RoomTimelineEntry,
  type WorkgroupRoomMessage,
} from '../src/lib/workgroup-room'
import { roomShowsRoundDividers } from '../src/lib/workgroup-mode'
import type { WorkgroupRunEntry } from '@agent-workflow/shared'

function msg(id: string, round: number): WorkgroupRoomMessage {
  return {
    id,
    round,
    authorKind: 'member',
    authorMemberId: 'M1',
    authorUserId: null,
    kind: 'chat',
    bodyMd: 'x',
    mentionMemberIds: [],
    assignmentId: null,
    createdAt: 0,
  }
}

function turn(nodeRunId: string, round: number | null): WorkgroupRunEntry {
  return {
    nodeRunId,
    memberId: 'M1',
    displayName: 'planner',
    kind: round === null ? 'message-turn' : 'leader-round',
    status: 'done',
    round,
    startedAt: null,
    finishedAt: null,
    triggerMessageId: null,
    assignmentId: null,
    note: null,
  }
}

const dividersOf = (t: RoomTimelineEntry[]): number[] =>
  t.filter((e) => e.type === 'round').map((e) => (e as { round: number }).round)

const flat = (t: RoomTimelineEntry[]): string[] =>
  t.map((e) =>
    e.type === 'round' ? `round:${e.round}` : e.type === 'turn' ? e.entry.nodeRunId : e.message.id,
  )

describe('RFC-209 — 单调水位线', () => {
  const cases: { name: string; rounds: number[]; expected: number[] }[] = [
    { name: '单调递增（既有行为不回归）', rounds: [0, 1, 1, 2], expected: [1, 2] },
    { name: '回退不画线', rounds: [1, 2, 1], expected: [1, 2] },
    { name: '重复不画线', rounds: [1, 1, 1], expected: [1] },
    { name: '前奏（round 0 全程无分隔线）', rounds: [0, 0], expected: [] },
    // 用户实测形态：fc 首轮全员规划（快照 0）+ 跳号 + 人类发言穿插的 round 0
    {
      name: '用户实测形态：跳号 + 穿插 0',
      rounds: [0, 0, 3, 3, 0, 5, 0, 8, 0, 11],
      expected: [3, 5, 8, 11],
    },
  ]
  for (const c of cases) {
    test(c.name, () => {
      const t = buildRoomTimeline(c.rounds.map((r, i) => msg(`01${String(i).padStart(4, '0')}`, r)))
      expect(dividersOf(t)).toEqual(c.expected)
      // 「一直穿插第 0 回合」这条症状的直接断言
      expect(dividersOf(t)).not.toContain(0)
    })
  }

  test('[5,0,5] 只产生一条可见分隔线 —— React key 不再重复', () => {
    const t = buildRoomTimeline([msg('01A', 5), msg('01B', 0), msg('01C', 5)])
    const keys = dividersOf(t).map((r) => `round-${r}`)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toEqual(['round-5'])
  })
})

describe('RFC-209 — 锚定与渲染解耦', () => {
  // 分隔线被水位线抑制时，该轮的 leader 卡**仍然锚在原处**，不会掉到房间底部。
  test('round 1 的分隔线被抑制（3 在前），卡片依旧锚在该轮边界处', () => {
    const t = buildRoomTimeline([msg('01A', 3), msg('01B', 1)], [turn('01C', 1)])
    // 回合卡的既有语义（RFC-182）：落在该轮**边界之后、该轮消息之前**。
    expect(flat(t)).toEqual(['round:3', '01A', '01C', '01B'])
    // 关键：没有因为分隔线不可见而失锚掉进尾部兜底（那样会排在 01B 之后）。
    expect(flat(t).indexOf('01C')).toBeLessThan(flat(t).indexOf('01B'))
  })

  test('分隔线可见时的锚定行为不回归（卡片紧随其后）', () => {
    const t = buildRoomTimeline([msg('01B', 1), msg('01D', 2)], [turn('01A', 1), turn('01C', 2)])
    expect(flat(t)).toEqual(['round:1', '01A', '01B', 'round:2', '01C', '01D'])
  })
})

describe('RFC-209 — 自由协作关闭分隔线', () => {
  test('dividers:false 时零个 round 条目（任意 round 序列）', () => {
    const t = buildRoomTimeline(
      [msg('01A', 0), msg('01B', 3), msg('01C', 5), msg('01D', 0)],
      [turn('01E', 2)],
      { dividers: false },
    )
    expect(t.filter((e) => e.type === 'round')).toHaveLength(0)
  })

  test('dividers:false 时带 round 的 turn 也按 ULID 交织（不再依赖不存在的分隔线锚点）', () => {
    const t = buildRoomTimeline([msg('01B', 1), msg('01D', 2)], [turn('01C', 1)], {
      dividers: false,
    })
    expect(flat(t)).toEqual(['01B', '01C', '01D'])
  })

  test('缺省仍是画分隔线（既有 2-参调用零改动）', () => {
    expect(dividersOf(buildRoomTimeline([msg('01A', 1)]))).toEqual([1])
  })
})

describe('RFC-209 — roomShowsRoundDividers 单一派生点', () => {
  test('只有 leader_worker 有真正的全局回合', () => {
    expect(roomShowsRoundDividers('leader_worker')).toBe(true)
    expect(roomShowsRoundDividers('free_collab')).toBe(false)
    expect(roomShowsRoundDividers('dynamic_workflow')).toBe(false)
  })
})
