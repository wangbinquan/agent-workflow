// RFC-187 PR-2 — TRAP-1 启动就绪护栏（AC-6）。
//
// workgroup-e2e-audit TRAP-1：leader-only 花名册当年绿灯通过 readiness、启动后
// leader 无人可派 → 空转/以不透明协议失败收场。本文件锁 `workgroupLaunchReadiness`
// 的三态 golden：blocking reasons（不变）+ 新增 advisory `warnings` 层
// （no-non-leader-worker，不阻启动）。设计门修订（design.md §8 P1-5尾）：
// readonly 字段已删（RFC-130）→ no-producer 无数据源，只保结构性可查项。

import { describe, expect, test } from 'bun:test'
import { workgroupLaunchReadiness } from '@agent-workflow/shared'

const agent = (id: string) => ({ id, memberType: 'agent' as const })
const human = (id: string) => ({ id, memberType: 'human' as const })

describe('RFC-187 TRAP-1 workgroupLaunchReadiness 三态', () => {
  test('健康组：ready、零 warning', () => {
    const r = workgroupLaunchReadiness({
      mode: 'leader_worker',
      leaderMemberId: 'lead',
      members: [agent('lead'), agent('coder')],
    })
    expect(r).toEqual({ ready: true, reasons: [], warnings: [] })
  })

  test('leader-only 花名册：ready（可启动）但带 no-non-leader-worker warning', () => {
    const r = workgroupLaunchReadiness({
      mode: 'leader_worker',
      leaderMemberId: 'lead',
      members: [agent('lead')],
    })
    expect(r.ready).toBe(true)
    expect(r.reasons).toEqual([])
    expect(r.warnings).toEqual(['no-non-leader-worker'])
  })

  test('leader + human 成员：human 是合法派发对象（交付卡）→ 无 warning', () => {
    const r = workgroupLaunchReadiness({
      mode: 'leader_worker',
      leaderMemberId: 'lead',
      members: [agent('lead'), human('pm')],
    })
    expect(r.warnings).toEqual([])
  })

  test('leaderless：blocking leader-missing 已覆盖，不再叠加 warning', () => {
    const r = workgroupLaunchReadiness({
      mode: 'leader_worker',
      leaderMemberId: null,
      members: [agent('solo')],
    })
    expect(r.ready).toBe(false)
    expect(r.reasons).toEqual(['leader-missing'])
    expect(r.warnings).toEqual([])
  })

  test('free_collab 单成员：无 leader 概念 → 无 warning（blocking 规则不变）', () => {
    const r = workgroupLaunchReadiness({
      mode: 'free_collab',
      leaderMemberId: null,
      members: [agent('solo')],
    })
    expect(r).toEqual({ ready: true, reasons: [], warnings: [] })
  })

  test('空花名册：既有 blocking 语义逐字节保留', () => {
    const r = workgroupLaunchReadiness({
      mode: 'leader_worker',
      leaderMemberId: null,
      members: [],
    })
    expect(r.ready).toBe(false)
    expect(r.reasons).toEqual(['no-agent-member', 'leader-missing'])
    expect(r.warnings).toEqual([])
  })
})
