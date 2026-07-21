// RFC-215 — free_collab 双轨调度与批量认领的 wake 纯函数锁。
//
// 锁的是设计门探针实锤的三个生产级饥饿机制的**反转**（design §0）：
//   S1 反转：同成员同 pass 双轨并行合法（message_turn + fc_claim 共存），但各轨内
//           至多一项——v1 的双重占用 bug（两个 run 竞争推同一游标）不得回归；
//   S2 反转：全员在跑消息回合时 open 卡照样配批——「讨论热任务饿死」是本 RFC 的
//           动机（生产环境任务清单堆积无人认领）；
//   S3 反转：预算末端认领批先占格、消息回合让路（G4）。
// 另锁：均分算法边界（idle=0 / open=0 / idle>open 空切片）、恢复批（dispatched
// 失驱卡按 assignee 集结）、lw 合并占用零变化（AC-8）。
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type {
  WorkgroupAssignment,
  WorkgroupMessage,
  WorkgroupRuntimeConfig,
} from '@agent-workflow/shared'
import { deriveWakeSet, type WakeInput, type WakeItem } from '../src/services/workgroupWake'

function fcCfg(overrides: Partial<WorkgroupRuntimeConfig> = {}): WorkgroupRuntimeConfig {
  return {
    workgroupId: 'wg1',
    workgroupName: 'squad',
    mode: 'free_collab',
    leaderMemberId: null,
    switches: { shareOutputs: true, directMessages: true, blackboard: true },
    maxRounds: 40,
    completionGate: false,
    instructions: 'x',
    goal: 'g',
    members: [
      {
        id: 'm-a',
        memberType: 'agent',
        agentName: 'a',
        userId: null,
        displayName: 'A',
        roleDesc: '',
      },
      {
        id: 'm-b',
        memberType: 'agent',
        agentName: 'b',
        userId: null,
        displayName: 'B',
        roleDesc: '',
      },
      {
        id: 'm-c',
        memberType: 'agent',
        agentName: 'c',
        userId: null,
        displayName: 'C',
        roleDesc: '',
      },
    ],
    ...overrides,
  }
}

let seq = 0
function msg(overrides: Partial<WorkgroupMessage> = {}): WorkgroupMessage {
  seq += 1
  return {
    id: `01M${String(seq).padStart(6, '0')}`,
    taskId: 't1',
    round: 0,
    authorKind: 'member',
    authorMemberId: 'm-b',
    authorUserId: null,
    kind: 'chat',
    bodyMd: 'hi',
    mentionMemberIds: [],
    assignmentId: null,
    createdAt: seq,
    ...overrides,
  }
}
function asg(overrides: Partial<WorkgroupAssignment> = {}): WorkgroupAssignment {
  seq += 1
  return {
    id: `A${String(seq).padStart(6, '0')}`,
    taskId: 't1',
    round: 0,
    source: 'self_claim',
    createdByRunId: null,
    createdByUserId: null,
    assigneeMemberId: null,
    title: `task ${seq}`,
    briefMd: 'x',
    status: 'open',
    nodeRunId: null,
    resultMessageId: null,
    dedupKey: null,
    attemptCount: 0,
    createdAt: seq,
    updatedAt: seq,
    ...overrides,
  } as WorkgroupAssignment
}
function input(overrides: Partial<WakeInput> = {}): WakeInput {
  return {
    config: fcCfg(),
    assignments: [],
    messages: [],
    cursors: new Map(),
    inFlight: {
      leaderRunning: false,
      runningAssignmentIds: new Set(),
      messageTurnMemberIds: new Set(),
      taskTurnMemberIds: new Set(),
    },
    roundsUsed: 5,
    gate: { declaredDone: false, awaitingConfirmation: false, rejected: false },
    ...overrides,
  }
}
const claims = (items: readonly WakeItem[]) => items.filter((i) => i.kind === 'fc_claim')
const msgTurns = (items: readonly WakeItem[]) => items.filter((i) => i.kind === 'message_turn')

describe('RFC-215 — dual track: message turns never starve claims (S2 反转)', () => {
  test('ALL members in message turns + open cards ⇒ batches still dispatched', () => {
    const t1 = asg()
    const t2 = asg()
    const t3 = asg()
    const w = deriveWakeSet(
      input({
        assignments: [t1, t2, t3],
        inFlight: {
          leaderRunning: false,
          runningAssignmentIds: new Set(),
          messageTurnMemberIds: new Set(['m-a', 'm-b', 'm-c']),
          taskTurnMemberIds: new Set(),
        },
      }),
    )
    // v1 探针 S2：items=[] 恒 running、任务饿死。现在三张卡均分三批。
    expect(claims(w.items)).toEqual([
      { kind: 'fc_claim', memberId: 'm-a', assignmentIds: [t1.id] },
      { kind: 'fc_claim', memberId: 'm-b', assignmentIds: [t2.id] },
      { kind: 'fc_claim', memberId: 'm-c', assignmentIds: [t3.id] },
    ])
  })

  test('member deep in a task batch still gets its message turn (reverse direction)', () => {
    const card = asg({ status: 'running', assigneeMemberId: 'm-a' })
    const mention = msg({ authorMemberId: 'm-b', mentionMemberIds: ['m-a'] })
    const w = deriveWakeSet(
      input({
        assignments: [card],
        messages: [mention],
        inFlight: {
          leaderRunning: false,
          runningAssignmentIds: new Set([card.id]),
          messageTurnMemberIds: new Set(),
          taskTurnMemberIds: new Set(['m-a']),
        },
      }),
    )
    expect(msgTurns(w.items)).toEqual([{ kind: 'message_turn', memberId: 'm-a' }])
    expect(claims(w.items)).toHaveLength(0) // busy on the task track — no second batch
  })

  test('same-track exclusivity: in-flight message turn not re-woken; task-busy member not re-batched', () => {
    const mention = msg({ authorMemberId: 'm-b', mentionMemberIds: ['m-a'] })
    const open = asg()
    const w = deriveWakeSet(
      input({
        assignments: [open],
        messages: [mention],
        inFlight: {
          leaderRunning: false,
          runningAssignmentIds: new Set(),
          messageTurnMemberIds: new Set(['m-a']),
          taskTurnMemberIds: new Set(['m-b']),
        },
      }),
    )
    // m-a 消息轨在飞 ⇒ 不重复派消息回合，但它的**任务轨**空闲——批照配给它
    // （双轨并行的本义）；m-b 任务轨在飞 ⇒ 批配对轮空 m-b。
    expect(msgTurns(w.items)).toHaveLength(0)
    expect(claims(w.items)).toEqual([
      { kind: 'fc_claim', memberId: 'm-a', assignmentIds: [open.id] },
    ])
  })

  test('S1 反转: same member can hold ONE message turn + ONE batch in the same pass', () => {
    const mention = msg({ authorMemberId: 'm-b', mentionMemberIds: ['m-a'] })
    const t1 = asg()
    const t2 = asg()
    const w = deriveWakeSet(input({ messages: [mention], assignments: [t1, t2] }))
    const aItems = w.items.filter(
      (i) => (i.kind === 'fc_claim' || i.kind === 'message_turn') && i.memberId === 'm-a',
    )
    // 双轨并行合法：m-a 一批 + 一个消息回合；但任务轨内只有一批（两张卡进同批或
    // 分给别人，绝不给 m-a 两个批 item）。
    expect(aItems.some((i) => i.kind === 'fc_claim')).toBe(true)
    expect(aItems.some((i) => i.kind === 'message_turn')).toBe(true)
    expect(aItems.filter((i) => i.kind === 'fc_claim')).toHaveLength(1)
  })
})

describe('RFC-215 — batching math (AC-2)', () => {
  test('7 cards / 2 idle ⇒ 4+3 (contiguous creation-order slices)', () => {
    const cards = Array.from({ length: 7 }, () => asg())
    const cfg2 = fcCfg({
      members: fcCfg().members.slice(0, 2), // m-a, m-b
    })
    const w = deriveWakeSet(input({ config: cfg2, assignments: cards }))
    expect(claims(w.items)).toEqual([
      { kind: 'fc_claim', memberId: 'm-a', assignmentIds: cards.slice(0, 4).map((c) => c.id) },
      { kind: 'fc_claim', memberId: 'm-b', assignmentIds: cards.slice(4, 7).map((c) => c.id) },
    ])
  })

  test('11 cards / 2 idle ⇒ 5+5, one card left for the next pass (cap=5)', () => {
    const cards = Array.from({ length: 11 }, () => asg())
    const cfg2 = fcCfg({ members: fcCfg().members.slice(0, 2) })
    const w = deriveWakeSet(input({ config: cfg2, assignments: cards }))
    const batches = claims(w.items)
    expect(batches.map((b) => (b.kind === 'fc_claim' ? b.assignmentIds.length : 0))).toEqual([5, 5])
    const claimed = new Set(batches.flatMap((b) => (b.kind === 'fc_claim' ? b.assignmentIds : [])))
    expect(claimed.size).toBe(10) // 第 11 张留清单
  })

  test('3 cards / 5-member idle pool ⇒ 1+1+1, NO empty-batch items', () => {
    const five = fcCfg({
      members: ['m-a', 'm-b', 'm-c', 'm-d', 'm-e'].map((id) => ({
        id,
        memberType: 'agent' as const,
        agentName: id,
        userId: null,
        displayName: id,
        roleDesc: '',
      })),
    })
    const cards = [asg(), asg(), asg()]
    const w = deriveWakeSet(input({ config: five, assignments: cards }))
    const batches = claims(w.items)
    expect(batches).toHaveLength(3) // 空切片不产 item（多余成员本 pass 无批）
    for (const b of batches) {
      if (b.kind === 'fc_claim') expect(b.assignmentIds).toHaveLength(1)
    }
  })

  test('zero idle / zero open short-circuit (no division blowup, no items)', () => {
    // idle=0：全员任务轨忙
    const busyAll = deriveWakeSet(
      input({
        assignments: [asg()],
        inFlight: {
          leaderRunning: false,
          runningAssignmentIds: new Set(),
          messageTurnMemberIds: new Set(),
          taskTurnMemberIds: new Set(['m-a', 'm-b', 'm-c']),
        },
      }),
    )
    expect(claims(busyAll.items)).toHaveLength(0)
    // open=0：无卡
    const noCards = deriveWakeSet(input({ assignments: [asg({ status: 'done' })] }))
    expect(claims(noCards.items)).toHaveLength(0)
  })
})

describe('RFC-215 — recovery batches (AC-7 wake leg)', () => {
  test('orphaned dispatched cards regroup per assignee, ahead of new claims', () => {
    // 崩溃在 CAS 之后 mint 之前：卡 dispatched、无 in-flight run。v1 的判据用
    // taskBusy（含卡状态腿）恒排除 assignee ⇒ 恢复集恒空、任务永楔（设计门
    // ①P1-1=②F1=③F1）。恢复判据只看 in-flight 两腿。
    const o1 = asg({ status: 'dispatched', assigneeMemberId: 'm-a' })
    const o2 = asg({ status: 'dispatched', assigneeMemberId: 'm-a' })
    const fresh = asg()
    const w = deriveWakeSet(input({ assignments: [o1, o2, fresh] }))
    expect(claims(w.items)).toEqual([
      { kind: 'fc_claim', memberId: 'm-a', assignmentIds: [o1.id, o2.id] },
      // m-a 已有恢复批不参与均分；新卡落给 m-b。
      { kind: 'fc_claim', memberId: 'm-b', assignmentIds: [fresh.id] },
    ])
  })

  test('dispatched card WITH an in-flight run is NOT re-batched', () => {
    const driven = asg({ status: 'dispatched', assigneeMemberId: 'm-a' })
    const w = deriveWakeSet(
      input({
        assignments: [driven],
        inFlight: {
          leaderRunning: false,
          runningAssignmentIds: new Set([driven.id]),
          messageTurnMemberIds: new Set(),
          taskTurnMemberIds: new Set(['m-a']),
        },
      }),
    )
    expect(claims(w.items)).toHaveLength(0)
  })
})

describe('RFC-215 — budget: batches outrank message turns at the cap (S3 反转, AC-6)', () => {
  test('1 slot left + 1 batch + mentions ⇒ batch takes the slot, message turn capped', () => {
    const mention = msg({ authorMemberId: 'm-b', mentionMemberIds: ['m-c'] })
    const open = asg()
    const w = deriveWakeSet(
      input({
        config: fcCfg({ maxRounds: 6 }),
        roundsUsed: 5,
        messages: [mention],
        assignments: [open],
      }),
    )
    expect(claims(w.items)).toHaveLength(1)
    expect(msgTurns(w.items)).toHaveLength(0)
    expect(w.capExceeded).toBe(true)
  })
})

describe('RFC-215 — lw merged-busy semantics unchanged (AC-8)', () => {
  const lwCfg = fcCfg({
    mode: 'leader_worker',
    leaderMemberId: 'm-a',
    switches: { shareOutputs: true, directMessages: true, blackboard: false },
  })

  test('worker with an active assignment is NOT woken for a mention (pre-215 behavior)', () => {
    const card = asg({ status: 'running', assigneeMemberId: 'm-b', source: 'leader' })
    const mention = msg({ authorMemberId: 'm-a', mentionMemberIds: ['m-b'] })
    const w = deriveWakeSet(
      input({
        config: lwCfg,
        roundsUsed: 1,
        assignments: [card],
        messages: [mention],
        inFlight: {
          leaderRunning: false,
          runningAssignmentIds: new Set([card.id]),
          messageTurnMemberIds: new Set(),
          taskTurnMemberIds: new Set(['m-b']),
        },
      }),
    )
    expect(msgTurns(w.items)).toHaveLength(0)
  })

  test('lw never produces fc_claim items', () => {
    const open = asg({ status: 'dispatched', assigneeMemberId: 'm-b', source: 'leader' })
    const w = deriveWakeSet(input({ config: lwCfg, roundsUsed: 1, assignments: [open] }))
    expect(claims(w.items)).toHaveLength(0)
    expect(w.items.some((i) => i.kind === 'assignment')).toBe(true)
  })
})

describe('RFC-215 — source locks', () => {
  test('fc batch drive path never advances the member cursor (G3)', () => {
    // 游标单一归属消息轨：driveBatchTurn / settleBatchResults 里出现
    // advanceMemberCursor 即回归（双轨并发双推游标 = v1 探针 S1 的竞态）。
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'workgroupRunner.ts'),
      'utf-8',
    )
    const batchFn = src.slice(
      src.indexOf('async function driveBatchTurn'),
      src.indexOf('async function driveMessageTurn'),
    )
    expect(batchFn.length).toBeGreaterThan(0)
    expect(batchFn).not.toContain('advanceMemberCursor')
    // lw 单卡路径保留推进（AC-5 对照面）：整文件仍有调用。
    expect(src).toContain('advanceMemberCursor')
  })
})
