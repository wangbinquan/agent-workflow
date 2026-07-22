// RFC-209 —— 工作组房间回合语义归位。
//
// 这条测试锁的回归族：用户 2026-07-20 实报「自由讨论里第 x 回合的轮次总是跳，并且中间
// 一直穿插第 0 回合」。根因是三个缺陷叠加（design/RFC-209-workgroup-round-semantics/design.md §1）：
//   ① fc 的「回合号」其实是 max_rounds 的**预算计数器**（成员 run 累计行数）；
//   ② 并发轮攥着**过期快照**写库，fc 首轮产出的一切永远写 round 0；
//   ③ 路由层四处**硬编码 round: 0**（且 schema 有 .default(0)，省略也静默写 0）。
//
// 本文件锁：
//   1. `deriveRoundsUsed` 与 RFC-209 之前的 `countRoundsUsed` 口径**互 oracle**
//      （允许的差异只有两条：① 被取代的被杀反问续跑行排除【T7】；② fc 分支豁免
//      `interrupted` 前身行【2026-07-21 T3B 回归，见文件尾 describe】）；
//   2. 被取代行排除在 **lw 与 fc 都**生效（v1 的打戳方案对 fc 是 no-op —— fc 分支
//      根本不读 wg_round，这一条是它的红→绿）；
//   3. `resolveMessageRound` 的两模式语义：lw = 账本读数、fc 恒 0；
//   4. 写入闸口：`buildRoomMessageRow` 的 `round` 必填（类型层）＋ 路由源码里不再有
//      硬编码 `round: 0`，且所有 `insert(workgroupMessages)` 都经构造器。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { buildRoomMessageRow } from '../src/services/workgroup/messages'
import {
  deriveRoundsUsed,
  roundedModeOf,
  type RoundLedgerRow,
  type RoundedWorkgroupMode,
} from '../src/services/workgroup/rounds'

const WG_LEADER = '__wg_leader__'
const WG_MEMBER = '__wg_member__'

let seq = 0
/** 单调 id，保证「更晚的行 id 更大」这一取代判据可控。 */
function row(p: Partial<RoundLedgerRow> & { nodeId: string }): RoundLedgerRow {
  seq += 1
  return {
    id: `01ROW${String(seq).padStart(21, '0')}`,
    shardKey: null,
    status: 'done',
    rerunCause: null,
    wgRound: null,
    ...p,
  }
}

/**
 * RFC-209 之前 `countRoundsUsed` 的逐字复刻（workgroupRunner.ts:657-690 @ 194f067d），
 * 作为互 oracle 的对照实现。**不要**把它改成调用新实现——它的价值就在于是一份独立副本。
 */
function legacyCountRoundsUsed(
  mode: RoundedWorkgroupMode,
  rows: readonly RoundLedgerRow[],
): number {
  if (mode === 'leader_worker') {
    let max = 0
    let nullQualifying = 0
    for (const r of rows) {
      if (r.nodeId !== WG_LEADER || r.status === 'canceled') continue
      if (r.wgRound !== null) {
        if (r.wgRound > max) max = r.wgRound
      } else if (r.rerunCause !== 'wg-gate' && r.rerunCause !== 'wg-protocol-retry') {
        nullQualifying++
      }
    }
    return max + nullQualifying
  }
  return rows.filter(
    (r) =>
      r.nodeId === WG_MEMBER && r.status !== 'canceled' && r.rerunCause !== 'wg-protocol-retry',
  ).length
}

describe('RFC-209 §1 — deriveRoundsUsed 与旧口径互 oracle', () => {
  const fixtures: { name: string; mode: RoundedWorkgroupMode; rows: RoundLedgerRow[] }[] = [
    { name: '空账本', mode: 'leader_worker', rows: [] },
    {
      name: 'lw 全打戳（含协议重试共享轮号）',
      mode: 'leader_worker',
      rows: [
        row({ nodeId: WG_LEADER, wgRound: 1, rerunCause: 'wg-leader-round' }),
        row({ nodeId: WG_LEADER, wgRound: 1, rerunCause: 'wg-protocol-retry' }),
        row({ nodeId: WG_LEADER, wgRound: 2, rerunCause: 'wg-leader-round' }),
      ],
    },
    {
      name: 'lw 混合尾巴（打戳 + 引擎外 mint 的 NULL 行）',
      mode: 'leader_worker',
      rows: [
        row({ nodeId: WG_LEADER, wgRound: 3, rerunCause: 'wg-leader-round' }),
        row({ nodeId: WG_LEADER, rerunCause: 'clarify-answer', status: 'pending' }),
      ],
    },
    {
      name: 'lw 排除 wg-gate / canceled',
      mode: 'leader_worker',
      rows: [
        row({ nodeId: WG_LEADER, wgRound: 2, rerunCause: 'wg-leader-round' }),
        row({ nodeId: WG_LEADER, rerunCause: 'wg-gate' }),
        row({ nodeId: WG_LEADER, status: 'canceled' }),
        row({ nodeId: WG_MEMBER, wgRound: 2, rerunCause: 'wg-assignment' }),
      ],
    },
    {
      name: 'fc 计数制（成员行，排除 canceled / 协议重试）',
      mode: 'free_collab',
      rows: [
        row({ nodeId: WG_MEMBER, rerunCause: 'wg-message-turn' }),
        row({ nodeId: WG_MEMBER, rerunCause: 'wg-assignment' }),
        row({ nodeId: WG_MEMBER, rerunCause: 'wg-protocol-retry' }),
        row({ nodeId: WG_MEMBER, status: 'canceled' }),
        row({ nodeId: WG_LEADER, rerunCause: 'wg-gate' }),
      ],
    },
  ]

  for (const f of fixtures) {
    test(`${f.name} —— 新旧逐值相同`, () => {
      expect(deriveRoundsUsed(f.mode, f.rows)).toBe(legacyCountRoundsUsed(f.mode, f.rows))
    })
  }

  test('未被取代的被杀反问续跑行仍计入（既有语义不变）', () => {
    const rows = [
      row({ nodeId: WG_LEADER, wgRound: 3, rerunCause: 'wg-leader-round' }),
      row({ nodeId: WG_LEADER, rerunCause: 'clarify-answer', status: 'interrupted' }),
    ]
    expect(deriveRoundsUsed('leader_worker', rows)).toBe(4)
    expect(deriveRoundsUsed('leader_worker', rows)).toBe(
      legacyCountRoundsUsed('leader_worker', rows),
    )
  })
})

describe('RFC-209 T7 — 被重铸的反问续跑不再双计', () => {
  // 场景：daemon 重启把已答复的反问续跑行杀成 `interrupted`（**不是** canceled），
  // `reviveKilledClarifyContinuations` 重铸一行；两行同时进账本 ⇒ 一个逻辑轮被数两次。
  // 改动前 lw 会多烧一格 max_rounds 且回合号跳 1；fc 更糟——它的 max_rounds 是硬杀。

  test('lw：被取代的 interrupted 续跑行被排除（改动前必红）', () => {
    const shard = null
    const killed = row({
      nodeId: WG_LEADER,
      shardKey: shard,
      status: 'interrupted',
      rerunCause: 'clarify-answer',
    })
    const revived = row({
      nodeId: WG_LEADER,
      shardKey: shard,
      status: 'pending',
      rerunCause: 'clarify-answer',
    })
    const rows = [
      row({ nodeId: WG_LEADER, wgRound: 3, rerunCause: 'wg-leader-round' }),
      killed,
      revived,
    ]
    expect(deriveRoundsUsed('leader_worker', rows)).toBe(4)
    // 旧口径把同一个逻辑回合数了两次
    expect(legacyCountRoundsUsed('leader_worker', rows)).toBe(5)
  })

  test('fc：同样生效 —— v1 的「打 wg_round 戳」方案对 fc 是 no-op（fc 分支不读 wg_round）', () => {
    const shard = 'assign-1'
    const killed = row({
      nodeId: WG_MEMBER,
      shardKey: shard,
      status: 'interrupted',
      rerunCause: 'clarify-answer',
    })
    const revived = row({
      nodeId: WG_MEMBER,
      shardKey: shard,
      status: 'pending',
      rerunCause: 'clarify-answer',
    })
    const rows = [row({ nodeId: WG_MEMBER, rerunCause: 'wg-message-turn' }), killed, revived]
    expect(deriveRoundsUsed('free_collab', rows)).toBe(2)
    expect(legacyCountRoundsUsed('free_collab', rows)).toBe(3)
  })

  test('NULL 尾巴有多条时逐行判定（k≥2 也正确）', () => {
    const mk = (shard: string) => [
      row({
        nodeId: WG_LEADER,
        shardKey: shard,
        status: 'interrupted',
        rerunCause: 'clarify-answer',
      }),
      row({ nodeId: WG_LEADER, shardKey: shard, status: 'pending', rerunCause: 'clarify-answer' }),
    ]
    const rows = [
      row({ nodeId: WG_LEADER, wgRound: 2, rerunCause: 'wg-leader-round' }),
      ...mk('a'),
      ...mk('b'),
    ]
    // 两个 lineage 各贡献 1（取代者），而不是各 2
    expect(deriveRoundsUsed('leader_worker', rows)).toBe(4)
    expect(legacyCountRoundsUsed('leader_worker', rows)).toBe(6)
  })

  test('分组按 (nodeId, shardKey)：不同 shard 之间不互相取代（lw 口径）', () => {
    // 原 fc 版本断言「shard a 的 interrupted 未被 shard b 取代 ⇒ 仍计入 ⇒ 2」。
    // 2026-07-21 起 fc 直接豁免全部 interrupted（见下一个 describe），
    // 「不互相取代」这个分组语义改用 lw 场景锁：a 的 interrupted NULL 尾不被
    // b 的 pending 取代 ⇒ 两条 NULL 尾各计 1。
    const rows = [
      row({
        nodeId: WG_LEADER,
        shardKey: 'a',
        status: 'interrupted',
        rerunCause: 'clarify-answer',
      }),
      row({ nodeId: WG_LEADER, shardKey: 'b', status: 'pending', rerunCause: 'clarify-answer' }),
    ]
    expect(deriveRoundsUsed('leader_worker', rows)).toBe(2)
  })
})

describe('2026-07-21 T3B 回归 — fc 的 interrupted 前身行不计费', () => {
  // 事故：daemon（并发开发的 --watch）反复重启，orphan reap 把在跑的 fc 成员行
  // 杀成 `interrupted`（orphanReconcile.ts 注释自述这是「安全默认 → auto-RESUME」），
  // 恢复后卡片由**新 run** 重跑。旧口径把前身行也计入 max_rounds ⇒ 同一逻辑消耗
  // 双重计费。实测任务 01KY25DM7EC2T7J2ZKGMQA10B1：160 格预算里 33 格（20.6%）
  // 烧在 interrupted 前身行上，任务被逼进 max-rounds-wrapup 假触顶——8 张 open 卡
  // 明明还有真实预算可用。修法与 `wg-protocol-retry` 豁免同构：一次逻辑消耗只计一次
  // （协议重试豁免重试行；中断豁免前身行，重跑行照常计费）。
  // lw 故意不在本次范围（max+NULL 尾口径另有 T7 窄口，见上一个 describe）。

  test('fc：interrupted 前身 + 重跑 done ⇒ 只计重跑那 1 格', () => {
    const rows = [
      row({ nodeId: WG_MEMBER, shardKey: 'card-1', status: 'interrupted' }), // 被 reap 的前身
      row({ nodeId: WG_MEMBER, shardKey: 'card-1', status: 'done' }), // resume 后的重跑
    ]
    expect(deriveRoundsUsed('free_collab', rows)).toBe(1)
  })

  test('fc：T3B 事故形状 —— done×3 + interrupted×2 + protocol-retry×1 ⇒ 3', () => {
    const rows = [
      row({ nodeId: WG_MEMBER, status: 'done' }),
      row({ nodeId: WG_MEMBER, status: 'done' }),
      row({ nodeId: WG_MEMBER, status: 'done' }),
      row({ nodeId: WG_MEMBER, status: 'interrupted' }), // daemon 重启收割，无 revive 对应行
      row({ nodeId: WG_MEMBER, status: 'interrupted', rerunCause: 'wg-assignment' }),
      row({ nodeId: WG_MEMBER, rerunCause: 'wg-protocol-retry' }),
    ]
    expect(deriveRoundsUsed('free_collab', rows)).toBe(3)
  })

  test('fc：还在跑（running/pending）照常占格 —— 豁免只针对 interrupted', () => {
    const rows = [
      row({ nodeId: WG_MEMBER, status: 'running' }),
      row({ nodeId: WG_MEMBER, status: 'pending' }),
      row({ nodeId: WG_MEMBER, status: 'interrupted' }),
    ]
    expect(deriveRoundsUsed('free_collab', rows)).toBe(2)
  })

  test('lw 口径不受影响：interrupted NULL 尾仍按 T7 既有裁定计入', () => {
    const rows = [
      row({ nodeId: WG_LEADER, wgRound: 3, rerunCause: 'wg-leader-round' }),
      row({ nodeId: WG_LEADER, rerunCause: 'clarify-answer', status: 'interrupted' }),
    ]
    expect(deriveRoundsUsed('leader_worker', rows)).toBe(4)
  })
})

describe('RFC-209 §2.1 — roundedModeOf 窄化', () => {
  test('两种回合制模式原样返回；dynamic_workflow 返回 null 而不是静默落 fc 分支', () => {
    expect(roundedModeOf('leader_worker')).toBe('leader_worker')
    expect(roundedModeOf('free_collab')).toBe('free_collab')
    expect(roundedModeOf('dynamic_workflow')).toBeNull()
  })
})

describe('RFC-209 §2.2 — 消息行构造器是唯一写入闸口', () => {
  test('round 原样落行；mentions 归一成 JSON；可选列缺省成 null', () => {
    const r = buildRoomMessageRow({
      id: ulid(),
      taskId: 't1',
      round: 7,
      authorKind: 'human',
      kind: 'chat',
      bodyMd: 'hi',
      createdAt: 123,
    })
    expect(r.round).toBe(7)
    expect(r.mentionsJson).toBe('[]')
    expect(r.authorMemberId).toBeNull()
    expect(r.authorUserId).toBeNull()
    expect(r.assignmentId).toBeNull()
  })

  test('round 是必填字段（类型层锁 —— schema 的 .default(0) 会让省略静默写 0）', () => {
    const SRC = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'workgroup', 'messages.ts'),
      'utf8',
    )
    // 必填 = 没有 `?`；有默认值会让「忘了带回合号」重新变成静默 round 0。
    // RFC-217 T3 起 messages.ts 还承载 PostMessageArgs（round?: 是 §2.3 的
    // 有意省略=写入时实时解析），锁面窄化到 RoomMessageRowArgs 块本身。
    const block = SRC.slice(
      SRC.indexOf('export interface RoomMessageRowArgs'),
      SRC.indexOf('}', SRC.indexOf('export interface RoomMessageRowArgs')),
    )
    expect(block).toMatch(/\n\s*round: number\n/)
    expect(block).not.toMatch(/round\?:/)
  })
})

describe('RFC-209 §1.3 — 路由层不再硬编码 round: 0', () => {
  const ROUTES = readFileSync(
    resolve(import.meta.dir, '..', 'src', 'routes', 'workgroupTasks.ts'),
    'utf8',
  )

  test('房间路由里 `round: 0` 字面量归零', () => {
    expect(ROUTES.split('round: 0').length - 1).toBe(0)
  })

  test('每一处 insert(workgroupMessages) 都经 buildRoomMessageRow（RFC-217 T4：写编排全量迁 service）', () => {
    // G2 终态：route 层裸写归零；taskActions 里每个 insert 都经构造器。
    expect(ROUTES.split('insert(workgroupMessages)').length - 1).toBe(0)
    const ACTIONS = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'workgroup', 'taskActions.ts'),
      'utf8',
    )
    const inserts = ACTIONS.split('insert(workgroupMessages)').length - 1
    const builders = ACTIONS.split('buildRoomMessageRow(').length - 1
    expect(inserts).toBeGreaterThanOrEqual(4)
    expect(builders).toBeGreaterThanOrEqual(inserts)
  })
})
