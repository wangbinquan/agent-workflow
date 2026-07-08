// RFC-144 T1 — node_runs.merge_state transition-table oracle.
//
// 为什么这条测试存在：merge_state（RFC-130 第二正交生命周期）此前 19 处裸直写、
// 零类型定义、schema 注释已漂移（flag-audit §4.4 P0，RFC-G2）。本测试把新引入的
// `nextMergeState` 单源转移表锁死：
//   ① LEGAL 网格穷举全部合法 (from, event, to) 三元组——转移图的字节级意图锁；
//   ② property：任意 (from, event) 要么返回 targetForMergeEvent(event)、要么抛
//      IllegalMergeStateTransition，且与 allowedFromForMergeEvent 完全自洽；
//   ③ 终态（merged / merge-failed / abandoned）× 全事件笛卡尔积全拒——终态无出边、
//      无 fixup 逃生门；
//   ④ NULL 语义锁定：唯一出边是 begin-isolation；abandon 不吃 NULL（golden-lock：
//      非隔离行永远 NULL，无 delta 可废弃）；
//   ⑤ TERMINAL_MERGE_STATES / SETTLED_MERGE_STATES / 谓词 ground truth——
//      deriveFrontier settled 门（D15）从这里单源取值。
// 新增 merge 状态/事件时 targetForMergeEvent / nextMergeState 的 never 穷举会编译
// 失败，逼全覆盖；改动转移图必须同步改这里的 LEGAL 网格（意图确认）。

import { describe, expect, test } from 'bun:test'

import {
  IllegalMergeStateTransition,
  MERGE_STATES,
  type MergeStateOrNull,
  type MergeStateTransitionEvent,
  SETTLED_MERGE_STATES,
  TERMINAL_MERGE_STATES,
  allowedFromForMergeEvent,
  isMergeStateSettled,
  isTerminalMergeState,
  nextMergeState,
  targetForMergeEvent,
} from '../src/lifecycle'

const ALL_STATES: readonly MergeStateOrNull[] = [null, ...MERGE_STATES]

const EVENTS: MergeStateTransitionEvent[] = [
  { kind: 'begin-isolation' },
  { kind: 'mark-pending-merge' },
  { kind: 'mark-merged' },
  { kind: 'park-conflict-human' },
  { kind: 'mark-merge-failed' },
  { kind: 'complete-human-resolution' },
  { kind: 'reenter-isolation' },
  { kind: 'abandon', reason: 'test' },
]

/** 全部合法转移（from, event kind, to）——与 design.md §1.2 状态图一一对应。 */
const LEGAL: ReadonlyArray<[MergeStateOrNull, MergeStateTransitionEvent, string]> = [
  [null, { kind: 'begin-isolation' }, 'isolating'],
  // 同行 shard/agg 子行原地续跑：persistIsoBase 对复用行重盖新 iso 基（自环）。
  ['isolating', { kind: 'begin-isolation' }, 'isolating'],
  ['isolating', { kind: 'mark-pending-merge' }, 'pending-merge'],
  ['pending-merge', { kind: 'mark-merged' }, 'merged'],
  ['pending-merge', { kind: 'mark-merged', via: 'replay' }, 'merged'],
  ['pending-merge', { kind: 'park-conflict-human' }, 'conflict-human'],
  ['pending-merge', { kind: 'park-conflict-human', via: 'replay' }, 'conflict-human'],
  ['pending-merge', { kind: 'mark-merge-failed', reason: 'git op threw' }, 'merge-failed'],
  // snapshot-pin 阶段抛错时行还在 isolating（persistIsoNodeTree 未跑）——同样
  // 必须能落 merge-failed，否则 done+isolating 行会卡 blocked 桶而非 fail-loud。
  ['isolating', { kind: 'mark-merge-failed', reason: 'snapshot threw' }, 'merge-failed'],
  ['conflict-human', { kind: 'complete-human-resolution' }, 'merged'],
  // 同行 wrapper 复活开启新一代隔离（Codex 实现门 P2）：merged 是「代终点」非「行终点」。
  ['merged', { kind: 'reenter-isolation' }, 'isolating'],
  ['conflict-human', { kind: 'reenter-isolation' }, 'isolating'],
  ['isolating', { kind: 'abandon', reason: 'retry-node' }, 'abandoned'],
  ['pending-merge', { kind: 'abandon', reason: 'retry-node' }, 'abandoned'],
  ['conflict-human', { kind: 'abandon', reason: 'review-reject' }, 'abandoned'],
]

describe('RFC-144 nextMergeState — 转移表 oracle', () => {
  test('LEGAL 网格：全部合法转移逐格命中期望 to', () => {
    for (const [from, ev, to] of LEGAL) {
      expect(nextMergeState(from, ev)).toBe(to as ReturnType<typeof nextMergeState>)
    }
  })

  test('property：任意 (from,event) 要么返回 target 要么抛，且与 allowedFromForMergeEvent 自洽', () => {
    for (const event of EVENTS) {
      const allowed = new Set(allowedFromForMergeEvent(event))
      for (const from of ALL_STATES) {
        if (allowed.has(from)) {
          expect(nextMergeState(from, event)).toBe(targetForMergeEvent(event))
        } else {
          expect(() => nextMergeState(from, event)).toThrow(IllegalMergeStateTransition)
        }
      }
    }
  })

  test('终态 × 全事件笛卡尔积全拒（merge-failed / abandoned 无出边、无逃生门）', () => {
    for (const terminal of TERMINAL_MERGE_STATES) {
      for (const event of EVENTS) {
        expect(() => nextMergeState(terminal, event)).toThrow(IllegalMergeStateTransition)
      }
    }
  })

  test('非终态非法格全拒（不在 LEGAL 里的 (from,event) 组合）', () => {
    const legalKeys = new Set(LEGAL.map(([from, ev]) => `${from ?? 'NULL'}::${ev.kind}`))
    for (const from of ALL_STATES) {
      if (isTerminalMergeState(from)) continue
      for (const event of EVENTS) {
        if (legalKeys.has(`${from ?? 'NULL'}::${event.kind}`)) continue
        expect(() => nextMergeState(from, event)).toThrow(IllegalMergeStateTransition)
      }
    }
  })

  test('NULL 语义：唯一出边 begin-isolation；abandon 不吃 NULL（golden-lock）', () => {
    // merged 非终态但出边唯一（reenter-isolation）——其余事件在 merged 上全拒。
    for (const event of EVENTS) {
      if (event.kind === 'reenter-isolation') continue
      expect(() => nextMergeState('merged', event)).toThrow(IllegalMergeStateTransition)
    }
    expect(nextMergeState(null, { kind: 'begin-isolation' })).toBe('isolating')
    for (const event of EVENTS) {
      if (event.kind === 'begin-isolation') continue
      expect(() => nextMergeState(null, event)).toThrow(IllegalMergeStateTransition)
    }
    expect(allowedFromForMergeEvent({ kind: 'abandon', reason: 'x' })).toEqual([
      'isolating',
      'pending-merge',
      'conflict-human',
    ])
  })

  test('allowedFrom 派生集逐事件锁定意图', () => {
    expect(allowedFromForMergeEvent({ kind: 'begin-isolation' })).toEqual([null, 'isolating'])
    expect(allowedFromForMergeEvent({ kind: 'mark-pending-merge' })).toEqual(['isolating'])
    expect(allowedFromForMergeEvent({ kind: 'mark-merged' })).toEqual(['pending-merge'])
    expect(allowedFromForMergeEvent({ kind: 'park-conflict-human' })).toEqual(['pending-merge'])
    expect(allowedFromForMergeEvent({ kind: 'mark-merge-failed' })).toEqual([
      'isolating',
      'pending-merge',
    ])
    expect(allowedFromForMergeEvent({ kind: 'complete-human-resolution' })).toEqual([
      'conflict-human',
    ])
    expect(allowedFromForMergeEvent({ kind: 'reenter-isolation' })).toEqual([
      'merged',
      'conflict-human',
    ])
  })

  test('IllegalMergeStateTransition 携带 from/eventKind/code（NULL 渲染为 "NULL"）', () => {
    try {
      nextMergeState(null, { kind: 'mark-merged' })
      throw new Error('unreachable')
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalMergeStateTransition)
      const e = err as IllegalMergeStateTransition
      expect(e.code).toBe('illegal-merge-state-transition')
      expect(e.from).toBeNull()
      expect(e.eventKind).toBe('mark-merged')
      expect(e.message).toContain("from='NULL'")
    }
  })
})

describe('RFC-144 集合常量与谓词 ground truth', () => {
  test('MERGE_STATES 全集 6 值（顺序即文档顺序）', () => {
    expect([...MERGE_STATES]).toEqual([
      'isolating',
      'pending-merge',
      'merged',
      'conflict-human',
      'merge-failed',
      'abandoned',
    ])
  })

  test('终态集 = merge-failed / abandoned；merged 是代终点非行终点（同行 wrapper 多代）', () => {
    expect([...TERMINAL_MERGE_STATES].sort()).toEqual(['abandoned', 'merge-failed'])
    expect(isTerminalMergeState(null)).toBe(false)
    expect(isTerminalMergeState('isolating')).toBe(false)
    expect(isTerminalMergeState('pending-merge')).toBe(false)
    expect(isTerminalMergeState('conflict-human')).toBe(false)
    expect(isTerminalMergeState('merged')).toBe(false) // reenter-isolation 唯一出边
    expect(isTerminalMergeState('merge-failed')).toBe(true)
    expect(isTerminalMergeState('abandoned')).toBe(true)
  })

  test('settled 集 = {NULL, merged}（D15 settled 门单源）——其余全部 gate 下游', () => {
    expect([...SETTLED_MERGE_STATES]).toEqual([null, 'merged'])
    expect(isMergeStateSettled(null)).toBe(true)
    expect(isMergeStateSettled('merged')).toBe(true)
    expect(isMergeStateSettled('isolating')).toBe(false)
    expect(isMergeStateSettled('pending-merge')).toBe(false)
    expect(isMergeStateSettled('conflict-human')).toBe(false)
    expect(isMergeStateSettled('merge-failed')).toBe(false)
    expect(isMergeStateSettled('abandoned')).toBe(false)
  })

  test('undefined 归一：isMergeStateSettled(undefined as any) 与 NULL 同桶（行来自 drizzle select 可能 undefined）', () => {
    expect(isMergeStateSettled(undefined as unknown as MergeStateOrNull)).toBe(true)
  })
})
